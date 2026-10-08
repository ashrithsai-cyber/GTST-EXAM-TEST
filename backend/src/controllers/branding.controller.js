const path = require("path");
const supabase = require("../config/examSupabase");
const { logAdminAction } = require("../utils/auditLog");

const BUCKET = "exam-branding";

// The client-supplied Content-Type is just a header the uploader's
// browser set — checked but never trusted alone, same reasoning as
// mockVideo.controller.js. Extension allowlist + a real signature sniff
// of the actual file content are the two independent checks that matter.
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);

function sniffImageFormat(buffer, ext) {
    if (!buffer || buffer.length < 8) return null;
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
    if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
    // SVG is plain-text XML, not a binary format with magic bytes — sniff
    // by content instead, same as any other text format would need.
    if (ext === ".svg") {
        const text = buffer.toString("utf8").toLowerCase();
        const head = text.slice(0, 512).trim();
        if (!head.startsWith("<?xml") && !head.startsWith("<svg")) return null;
        // Served publicly from Storage — reject anything that could run
        // script when the logo URL is opened directly.
        if (/<script|<foreignobject|javascript:|\son[a-z]+\s*=/.test(text)) return null;
        return "svg";
    }
    return null;
}

// Strips everything except alphanumerics/dot/dash/underscore, so the
// Supabase Storage key can never carry `../`, slashes, or other
// characters with special meaning — same approach as
// mockVideo.controller.js's sanitizeFileName.
function sanitizeFileName(name) {
    const cleaned = (name || "logo").replace(/[^a-zA-Z0-9._-]/g, "_");
    return cleaned.slice(-150) || "logo";
}

// exam_branding is a true singleton — one row, always read/updated in
// place (name and logo both), same "always the oldest row" pattern as
// settings.controller.js's getExamSettings. 009_exam_branding.sql always
// seeds exactly one row, so this only ever returns null in an
// unmigrated environment.
async function getCurrentRow() {
    const { data, error } = await supabase
        .from("exam_branding")
        .select("*")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data;
}

function toPublicResponse(row) {
    if (!row) return null;
    let logoUrl = null;
    if (row.logo_storage_path) {
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(row.logo_storage_path);
        logoUrl = data.publicUrl;
    }
    return {
        examName: row.exam_name,
        logoUrl,
        updatedAt: row.updated_at
    };
}


// =====================================================
// GET BRANDING
//
// Intentionally public — reached two ways: GET /api/admin/branding
// (admin dashboard, behind adminJwtAuth like every other admin route)
// and GET /api/exam/branding (student portal, no studentAuth — see
// exam.routes.js). The student portal needs this before login, on the
// Landing page, so it cannot be gated behind student auth.
// =====================================================

const getBranding = async (req, res) => {
    try {
        const row = await getCurrentRow();
        return res.json({ success: true, branding: toPublicResponse(row) });
    } catch (error) {
        console.error("getBranding error:", error);
        return res.status(500).json({ success: false, message: "Unable to load exam branding" });
    }
};


// =====================================================
// UPDATE EXAM NAME — admin only.
// =====================================================

const updateBrandingName = async (req, res) => {
    try {
        const { examName } = req.body;
        if (!examName || !examName.trim()) {
            return res.status(400).json({ success: false, message: "examName is required" });
        }

        const current = await getCurrentRow();
        const updates = {
            exam_name: examName.trim(),
            updated_at: new Date().toISOString(),
            updated_by: req.admin.id
        };

        let row;
        if (current) {
            const { data, error } = await supabase
                .from("exam_branding")
                .update(updates)
                .eq("id", current.id)
                .select()
                .single();
            if (error) throw error;
            row = data;
        } else {
            const { data, error } = await supabase
                .from("exam_branding")
                .insert(updates)
                .select()
                .single();
            if (error) throw error;
            row = data;
        }

        await logAdminAction(req.admin.id, "UPDATE", "exam_branding", row.id, { examName: row.exam_name });

        return res.json({ success: true, branding: toPublicResponse(row) });
    } catch (error) {
        console.error("updateBrandingName error:", error);
        return res.status(500).json({ success: false, message: "Unable to update exam name" });
    }
};


// =====================================================
// UPLOAD (REPLACE) LOGO — admin only. Single-logo model: uploading a
// new one deletes the previous storage object, matching the mock
// video's "replace" UX (see mockVideo.controller.js).
// =====================================================

const uploadBrandingLogo = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "A logo image file is required" });
        }

        const ext = path.extname(req.file.originalname || "").toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) {
            return res.status(400).json({
                success: false,
                message: `Unsupported file extension${ext ? ` "${ext}"` : ""}. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`
            });
        }

        if (!sniffImageFormat(req.file.buffer, ext)) {
            return res.status(400).json({ success: false, message: "This file's content does not look like a valid image" });
        }

        const current = await getCurrentRow();
        const storagePath = `${Date.now()}-${sanitizeFileName(req.file.originalname)}`;

        const { error: uploadError } = await supabase.storage
            .from(BUCKET)
            .upload(storagePath, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: false
            });

        if (uploadError) throw uploadError;

        const updates = {
            logo_storage_path: storagePath,
            logo_file_name: req.file.originalname,
            logo_mime_type: req.file.mimetype,
            updated_at: new Date().toISOString(),
            updated_by: req.admin.id
        };

        let row;
        if (current) {
            const { data, error } = await supabase
                .from("exam_branding")
                .update(updates)
                .eq("id", current.id)
                .select()
                .single();
            if (error) {
                await supabase.storage.from(BUCKET).remove([storagePath]);
                throw error;
            }
            row = data;
        } else {
            // Defensive only — 009_exam_branding.sql always seeds a row,
            // so this path is not expected to run in a migrated
            // environment. "Exam Portal" is a neutral placeholder, not a
            // fabricated exam name — the admin can rename it immediately
            // via PUT /branding.
            const { data, error } = await supabase
                .from("exam_branding")
                .insert({ ...updates, exam_name: "Exam Portal" })
                .select()
                .single();
            if (error) {
                await supabase.storage.from(BUCKET).remove([storagePath]);
                throw error;
            }
            row = data;
        }

        if (current?.logo_storage_path) {
            await supabase.storage.from(BUCKET).remove([current.logo_storage_path]);
        }

        await logAdminAction(req.admin.id, "UPDATE", "exam_branding", row.id, { logoFileName: row.logo_file_name });

        return res.json({ success: true, branding: toPublicResponse(row) });
    } catch (error) {
        console.error("uploadBrandingLogo error:", error);
        return res.status(500).json({ success: false, message: "Unable to upload exam logo" });
    }
};


module.exports = {
    getBranding,
    updateBrandingName,
    uploadBrandingLogo
};

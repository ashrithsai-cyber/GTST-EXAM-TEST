const path = require("path");
const supabase = require("../config/examSupabase");
const { logAdminAction } = require("../utils/auditLog");

const BUCKET = "mock-videos";

// The client-supplied Content-Type (req.file.mimetype) is just a header
// the uploader's browser set — trivially spoofable, so it's checked but
// never trusted alone. Extension allowlist + a real magic-byte sniff of
// the actual file content are the two independent checks that matter;
// both must agree the file is really a video before it's stored.
const ALLOWED_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".avi", ".ogg", ".ogv"]);

function sniffVideoFormat(buffer) {
    if (!buffer || buffer.length < 12) return null;
    // ISO base media containers (mp4/m4v/mov/3gp/...): 4-byte box size
    // followed by the "ftyp" box type at offset 4.
    if (buffer.toString("ascii", 4, 8) === "ftyp") return "mp4";
    // Some legacy QuickTime .mov files start with a different atom
    // (moov/mdat/wide/free/skip) instead of ftyp.
    if (["moov", "mdat", "wide", "free", "skip"].includes(buffer.toString("ascii", 4, 8))) return "mov";
    // WebM/Matroska: EBML header signature.
    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "webm";
    // AVI: RIFF container with an "AVI " form type.
    if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "AVI ") return "avi";
    // Ogg container (used for .ogv video).
    if (buffer.toString("ascii", 0, 4) === "OggS") return "ogg";
    return null;
}

// Strips everything except alphanumerics/dot/dash/underscore, so
// whatever ends up in the Supabase Storage key can never carry `../`,
// slashes, or other characters with special meaning — the previous
// version only collapsed whitespace, leaving the rest of the client-
// supplied filename unsanitized.
function sanitizeFileName(name) {
    const cleaned = (name || "video").replace(/[^a-zA-Z0-9._-]/g, "_");
    return cleaned.slice(-150) || "video";
}

// mock_videos is modeled as a small history table, but the admin UI only
// ever shows/replaces "the current video" — the single most recent row.
async function getCurrentRow() {
    const { data, error } = await supabase
        .from("mock_videos")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data;
}

function toPublicResponse(row) {
    if (!row) return null;
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(row.storage_path);
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        fileName: row.file_name,
        fileSize: row.file_size,
        mimeType: row.mime_type,
        storagePath: row.storage_path,
        url: data.publicUrl,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}


// =====================================================
// GET CURRENT MOCK VIDEO
//
// Shared by both the admin dashboard (GET /api/admin/mock-video) and
// the student portal (GET /api/exam/mock-video, see exam.routes.js) —
// same row, same public URL, just reached through two different auth
// gates. Returns { video: null } when nothing has been uploaded yet.
// =====================================================

const getMockVideo = async (req, res) => {
    try {
        const row = await getCurrentRow();

        return res.json({ success: true, video: toPublicResponse(row) });
    } catch (error) {
        console.error("getMockVideo error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch mock video" });
    }
};


// =====================================================
// UPLOAD (REPLACE) MOCK VIDEO
//
// Single-video model: uploading a new one deletes the previous row and
// its storage object, so there is never more than one at a time — matches
// the admin frontend's "replace" UX, which has no concept of a history.
// =====================================================

const uploadMockVideo = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "A video file is required" });
        }

        if (!req.file.mimetype.startsWith("video/")) {
            return res.status(400).json({ success: false, message: "File must be a video" });
        }

        const ext = path.extname(req.file.originalname || "").toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) {
            return res.status(400).json({
                success: false,
                message: `Unsupported file extension${ext ? ` "${ext}"` : ""}. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`
            });
        }

        const sniffedFormat = sniffVideoFormat(req.file.buffer);
        if (!sniffedFormat) {
            return res.status(400).json({ success: false, message: "This file's content does not look like a valid video file" });
        }

        const { title, description } = req.body;

        const previous = await getCurrentRow();

        const storagePath = `${Date.now()}-${sanitizeFileName(req.file.originalname)}`;

        const { error: uploadError } = await supabase.storage
            .from(BUCKET)
            .upload(storagePath, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: false
            });

        if (uploadError) throw uploadError;

        const { data, error } = await supabase
            .from("mock_videos")
            .insert({
                title: (title || "Mock Examination Demo").trim(),
                description: description !== undefined ? description : null,
                storage_path: storagePath,
                file_name: req.file.originalname,
                file_size: req.file.size,
                mime_type: req.file.mimetype,
                uploaded_by: req.admin.id
            })
            .select()
            .single();

        if (error) {
            // Row insert failed after the object was already uploaded —
            // clean up the orphaned storage object rather than leaving it
            // unreferenced.
            await supabase.storage.from(BUCKET).remove([storagePath]);
            throw error;
        }

        if (previous) {
            await supabase.storage.from(BUCKET).remove([previous.storage_path]);
            await supabase.from("mock_videos").delete().eq("id", previous.id);
        }

        await logAdminAction(req.admin.id, "CREATE", "mock_video", data.id, { fileName: data.file_name });

        return res.status(201).json({ success: true, video: toPublicResponse(data) });
    } catch (error) {
        console.error("uploadMockVideo error:", error);
        return res.status(500).json({ success: false, message: "Unable to upload mock video" });
    }
};


// =====================================================
// UPDATE DETAILS ONLY (no re-upload) — "Edit Details" modal
// =====================================================

const updateMockVideoDetails = async (req, res) => {
    try {
        const { title, description } = req.body;

        const updates = { updated_at: new Date().toISOString() };
        if (title !== undefined) updates.title = title.trim();
        if (description !== undefined) updates.description = description;

        const current = await getCurrentRow();
        if (!current) return res.status(404).json({ success: false, message: "No mock video uploaded yet" });

        const { data, error } = await supabase
            .from("mock_videos")
            .update(updates)
            .eq("id", current.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        await logAdminAction(req.admin.id, "UPDATE", "mock_video", current.id, {
            fieldsChanged: Object.keys(updates).filter((k) => k !== "updated_at")
        });

        return res.json({ success: true, video: toPublicResponse(data) });
    } catch (error) {
        console.error("updateMockVideoDetails error:", error);
        return res.status(500).json({ success: false, message: "Unable to update mock video details" });
    }
};


// =====================================================
// DELETE MOCK VIDEO
// =====================================================

const deleteMockVideo = async (req, res) => {
    try {
        const current = await getCurrentRow();
        if (!current) return res.status(404).json({ success: false, message: "No mock video uploaded yet" });

        const { error: storageError } = await supabase.storage.from(BUCKET).remove([current.storage_path]);
        if (storageError) throw storageError;

        const { error } = await supabase.from("mock_videos").delete().eq("id", current.id);
        if (error) throw error;

        await logAdminAction(req.admin.id, "DELETE", "mock_video", current.id, null);

        return res.json({ success: true, message: "Mock video deleted" });
    } catch (error) {
        console.error("deleteMockVideo error:", error);
        return res.status(500).json({ success: false, message: "Unable to delete mock video" });
    }
};


module.exports = {
    getMockVideo,
    uploadMockVideo,
    updateMockVideoDetails,
    deleteMockVideo
};

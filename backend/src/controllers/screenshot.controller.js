const multer = require("multer");
const supabase = require("../config/examSupabase");
const { getExamSettings, getStudentExamContext } = require("./_examShared");
const { recordCheckInScreenshot } = require("./preflight.controller");
const { isUuid, sanitizeSearchTerm } = require("../utils/validation");

const BUCKET = "system-check-screenshots";

// Small, dedicated instance — this upload is a single-page JPEG
// screenshot, never legitimately large, so it gets its own tight limit
// rather than reusing middleware/upload.js's 200MB video-sized one.
const ALLOWED_SCREENSHOT_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

const screenshotUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

// Same magic-byte approach as branding.controller.js's sniffImageFormat
// (duplicated locally rather than shared, to avoid touching that
// already-working upload path) — the client-supplied Content-Type is
// just a header the browser set, checked but never trusted alone.
function sniffImageMime(buffer) {
    if (!buffer || buffer.length < 8) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
    return null;
}

// Same exam resolution as the preflight: the in-progress session's exam
// first, otherwise the exam a new session would be created for.
async function resolveApplicable(req) {
    const { exam, code } = await getStudentExamContext(req.student.candidateId, req.student.studentClass);
    if (code) return { applicable: false };
    return { applicable: true, examId: exam.id };
}


// =====================================================
// UPLOAD SYSTEM CHECK SCREENSHOT
//
// One automatic capture per (candidate, exam) — enforced first by a
// pre-check (avoids touching Storage at all for a known duplicate, e.g.
// a re-fired effect) and backstopped by the table's unique constraint
// (a concurrent request that loses the race gets 23505, handled the
// same as "already captured" rather than as an error).
// =====================================================

const uploadScreenshot = async (req, res) => {
    try {
        const { candidateId } = req.student;
        const settings = await getExamSettings();
        if (!settings.photoCaptureEnabled) {
            return res.json({ success: true, applicable: false, disabled: true });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: "A screenshot image is required" });
        }
        const sniffedMime = sniffImageMime(req.file.buffer);
        if (!ALLOWED_SCREENSHOT_MIME_TYPES.has(req.file.mimetype) || !sniffedMime) {
            return res.status(400).json({ success: false, message: "This file's content does not look like a valid image" });
        }

        const { applicable, examId } = await resolveApplicable(req);
        if (!applicable) {
            return res.json({ success: true, applicable: false });
        }

        const { data: existing, error: existingError } = await supabase
            .from("system_check_screenshots")
            .select("id, storage_path")
            .eq("candidate_id", candidateId)
            .eq("exam_id", examId)
            .maybeSingle();
        if (existingError) throw existingError;

        // A fresh capture from the student's current System Check replaces
        // the earlier photo: same (candidate, exam) row and Storage path,
        // with captured_at moved to now.
        if (existing) {
            const { error: replaceError } = await supabase.storage
                .from(BUCKET)
                .upload(existing.storage_path, req.file.buffer, {
                    contentType: sniffedMime,
                    upsert: true
                });
            if (replaceError) throw replaceError;

            const capturedAt = new Date().toISOString();
            const { error: touchError } = await supabase
                .from("system_check_screenshots")
                .update({ captured_at: capturedAt })
                .eq("id", existing.id);
            if (touchError) throw touchError;

            await recordCheckInScreenshot(candidateId, examId, capturedAt);
            return res.json({ success: true, applicable: true, captured: true, replaced: true });
        }

        const { data: candidate, error: candidateError } = await supabase
            .from("exam_candidates")
            .select("registration_id, hall_ticket_number")
            .eq("id", candidateId)
            .maybeSingle();
        if (candidateError) throw candidateError;
        if (!candidate) return res.status(404).json({ success: false, message: "Candidate not found" });

        const storagePath = `${examId}/${candidateId}.jpg`;

        const { error: uploadError } = await supabase.storage
            .from(BUCKET)
            .upload(storagePath, req.file.buffer, {
                contentType: sniffedMime,
                upsert: true
            });
        if (uploadError) throw uploadError;

        const capturedAt = new Date().toISOString();
        const { error: insertError } = await supabase
            .from("system_check_screenshots")
            .insert({
                candidate_id: candidateId,
                exam_id: examId,
                registration_id: candidate.registration_id,
                hall_ticket_number: candidate.hall_ticket_number,
                storage_path: storagePath,
                captured_at: capturedAt
            });

        if (insertError) {
            // Lost a race against a concurrent request for the same
            // candidate+exam — treat exactly like "already captured",
            // not an error; the Storage object above is harmless either
            // way since both writers upload the same deterministic path.
            if (insertError.code === "23505") {
                await recordCheckInScreenshot(candidateId, examId, capturedAt);
                return res.json({ success: true, applicable: true, captured: true, alreadyExisted: true });
            }
            throw insertError;
        }

        await recordCheckInScreenshot(candidateId, examId, capturedAt);
        return res.json({ success: true, applicable: true, captured: true });
    } catch (error) {
        console.error("uploadScreenshot error:", error);
        return res.status(500).json({ success: false, message: "Unable to save the check-in screenshot" });
    }
};


// Shared pagination parsing — same shape/cap as admin.controller.js's
// parsePagination, duplicated locally rather than exported from there to
// avoid coupling this student-facing controller's module to the admin
// controller's internals for one small helper.
function parsePagination(query) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 24));
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    return { page, limit, from, to };
}


// =====================================================
// ADMIN: LIST CHECK-IN SCREENSHOTS
//
// Backs the Admin Dashboard's "Captured Images" gallery — every
// automatic System Check screenshot ever captured, newest first, joined
// with the candidate's name/class and the exam's name so the gallery
// never needs a second round trip per row. registration_id/hall_ticket_number
// are searched from this table's own denormalized columns (set at
// capture time, see uploadScreenshot below) rather than the joined
// exam_candidates table, matching how listCandidates searches its own
// table's columns in admin.controller.js.
// =====================================================

const listCheckInScreenshots = async (req, res) => {
    try {
        const { page, limit, from, to } = parsePagination(req.query);

        let query = supabase
            .from("system_check_screenshots")
            .select(
                "id, candidate_id, exam_id, session_id, registration_id, hall_ticket_number, captured_at, exam_candidates(full_name, student_class), exams(exam_name, exam_code)",
                { count: "exact" }
            )
            .order("captured_at", { ascending: false })
            .range(from, to);

        const term = sanitizeSearchTerm(req.query.search);
        if (term) {
            query = query.or(`registration_id.ilike.%${term}%,hall_ticket_number.ilike.%${term}%`);
        }
        if (req.query.examId) {
            query = query.eq("exam_id", req.query.examId);
        }
        if (req.query.candidateId) {
            query = query.eq("candidate_id", req.query.candidateId);
        }

        const { data, error, count } = await query;
        if (error) throw error;

        return res.json({ success: true, page, limit, total: count, screenshots: data });
    } catch (error) {
        console.error("listCheckInScreenshots error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch check-in screenshots" });
    }
};


// =====================================================
// ADMIN: GET CHECK-IN SCREENSHOT IMAGE
//
// Streams the actual JPEG bytes for one screenshot row. The bucket is
// private (see 011_system_check_screenshots.sql) — no public or signed
// URL is ever generated for it; this service_role-backed, admin-JWT-gated
// route (see admin.routes.js) is the only way to ever read the bytes back
// out of Storage, exactly preserving that migration's original intent.
// =====================================================

const getCheckInScreenshotImage = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "Screenshot not found" });

        const { data: row, error } = await supabase
            .from("system_check_screenshots")
            .select("storage_path")
            .eq("id", id)
            .maybeSingle();
        if (error) throw error;
        if (!row) return res.status(404).json({ success: false, message: "Screenshot not found" });

        const { data: file, error: downloadError } = await supabase.storage
            .from(BUCKET)
            .download(row.storage_path);
        if (downloadError) throw downloadError;

        const buffer = Buffer.from(await file.arrayBuffer());
        res.setHeader("Content-Type", sniffImageMime(buffer) || "application/octet-stream");
        // Immutable once captured (one per candidate+exam) — safe for the
        // admin browser to cache for the length of a dashboard session.
        res.setHeader("Cache-Control", "private, max-age=3600");
        return res.send(buffer);
    } catch (error) {
        console.error("getCheckInScreenshotImage error:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch screenshot image" });
    }
};


module.exports = {
    screenshotUpload,
    uploadScreenshot,
    listCheckInScreenshots,
    getCheckInScreenshotImage
};

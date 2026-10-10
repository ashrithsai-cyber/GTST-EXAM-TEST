const multer = require("multer");

const MB = 1024 * 1024;

// In-memory storage — the file never touches local disk, it's forwarded
// straight to Supabase Storage by the controllers. 200MB matches the
// buckets' file_size_limit set in 003_admin_extensions.sql; keep the two
// in sync if either changes.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * MB }
});

// Mock exam video. Supabase Storage also enforces a project-wide per-file
// cap (50 MB on the Free plan) that a bucket's own file_size_limit cannot
// raise, so anything over it is rejected here, before it is buffered or
// sent on. Raise MOCK_VIDEO_MAX_MB only after raising the Supabase
// project's upload limit (paid plans) to at least the same value.
const configuredVideoMb = Number(process.env.MOCK_VIDEO_MAX_MB);
const MOCK_VIDEO_MAX_MB = Number.isInteger(configuredVideoMb) && configuredVideoMb > 0
    ? Math.min(configuredVideoMb, 200)
    : 50;

const videoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MOCK_VIDEO_MAX_MB * MB, files: 1 }
});

module.exports = upload;
module.exports.videoUpload = videoUpload;
module.exports.MOCK_VIDEO_MAX_MB = MOCK_VIDEO_MAX_MB;

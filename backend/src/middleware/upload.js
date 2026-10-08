const multer = require("multer");

// In-memory storage — the file never touches local disk, it's forwarded
// straight to Supabase Storage in mockVideo.controller.js. 200MB matches
// the 'mock-videos' bucket's file_size_limit set in
// 003_admin_extensions.sql; keep the two in sync if either changes.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }
});

module.exports = upload;

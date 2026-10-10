// Deployment behaviour behind Railway's proxy: trust-proxy selection,
// rate limiting that forged X-Forwarded-For headers cannot bypass, the
// mock-video size limits (ours and Supabase's), and client disconnects
// mid-upload. Isolated database doubles; no real keys or storage.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const jwt = require("jsonwebtoken");
process.env.STUDENT_JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(32).toString("hex");
process.env.NODE_ENV = "test";
delete process.env.TRUST_PROXY;
process.env.RAILWAY_ENVIRONMENT_NAME = "test"; // as Railway injects it
process.env.MOCK_VIDEO_MAX_MB = "1";
const { createMemorySupabase } = require("./helpers/memorySupabase");
const { resolveTrustProxy } = require("../src/utils/trustProxy");

const adminId = crypto.randomUUID();
const db = createMemorySupabase({
    exams: [], exam_candidates: [], student_login_sessions: [], student_presence: [], mock_videos: [], admin_audit_logs: [],
    admin_users: [{ id: adminId, name: "Admin", email: "admin@example.invalid", password_hash: "x", role: "admin", is_active: true, created_at: new Date().toISOString() }]
});
const registrationDb = createMemorySupabase({ registrations: [] });
for (const [file, client] of [["examSupabase.js", db], ["registrationSupabase.js", registrationDb]]) {
    const filename = path.join(__dirname, "..", "src", "config", file);
    require.cache[filename] = { id: filename, filename, loaded: true, exports: client };
}

// Collected so the tests can assert what the server logged.
const logs = { error: [], warn: [] };
for (const level of ["error", "warn"]) {
    const original = console[level];
    console[level] = (...args) => { logs[level].push(args.map(String).join(" ")); if (process.env.DEBUG_TEST_LOGS) original(...args); };
}

const app = require("../src/server");
let server;
let baseUrl;
test.before(async () => {
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

const adminToken = () => jwt.sign({ adminId, role: "admin", typ: "admin" }, process.env.ADMIN_JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
const mp4 = (bytes) => { const b = Buffer.alloc(bytes); b.write("ftypisom", 4, "ascii"); return b; };
async function uploadVideo(buffer) {
    const form = new FormData();
    form.append("video", new Blob([buffer], { type: "video/mp4" }), "rules.mp4");
    form.append("title", "Rules");
    const response = await fetch(`${baseUrl}/api/admin/mock-video`, { method: "POST", headers: { Authorization: `Bearer ${adminToken()}` }, body: form });
    return { status: response.status, body: await response.json() };
}

test("Trust proxy: one hop on Railway, explicit TRUST_PROXY wins, nothing trusted otherwise", () => {
    assert.equal(resolveTrustProxy({}), false);
    assert.equal(resolveTrustProxy({ RAILWAY_ENVIRONMENT_NAME: "production" }), 1);
    assert.equal(resolveTrustProxy({ RAILWAY_PROJECT_ID: "p" }), 1);
    assert.equal(resolveTrustProxy({ TRUST_PROXY: "2", RAILWAY_ENVIRONMENT_NAME: "production" }), 2);
    assert.equal(resolveTrustProxy({ TRUST_PROXY: "false", RAILWAY_ENVIRONMENT_NAME: "production" }), false);
    assert.equal(resolveTrustProxy({ TRUST_PROXY: "0" }), false);
    assert.equal(resolveTrustProxy({ TRUST_PROXY: "loopback" }), "loopback");
    assert.equal(app.get("trust proxy"), 1);
});

test("Forged X-Forwarded-For entries cannot bypass the login rate limit", async () => {
    const login = (forwardedFor) => fetch(`${baseUrl}/api/exam/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
        body: JSON.stringify({ registrationId: "GTST26199999", hallTicketNumber: "GTS/ABCDEF123ABC12345" })
    }).then((r) => r.status);
    // Railway's proxy appends the real client address last; everything
    // before it is whatever the client sent.
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push(await login(`10.${i}.0.1, 198.51.100.${i}, 203.0.113.7`));
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses[10], 429, "11th attempt from the same client is limited despite forged entries");
    // A different real client still gets through: req.ip is per client.
    assert.equal(await login("203.0.113.8"), 401);
    assert.equal(logs.error.filter((l) => l.includes("ERR_ERL")).length, 0, "no express-rate-limit validation errors");
});

test("Mock video over MOCK_VIDEO_MAX_MB is refused with a clear 413 before reaching storage", async () => {
    const result = await uploadVideo(mp4(1024 * 1024 + 1));
    assert.equal(result.status, 413);
    assert.match(result.body.message, /larger than the 1 MB upload limit/);
    assert.equal(db.db.storage.size, 0);
    assert.equal(db.db.tables.mock_videos.length, 0);
});

test("Supabase Storage's own size rejection becomes a clear 413, not a 500", async () => {
    const realFrom = db.storage.from;
    db.storage.from = (bucket) => ({ ...realFrom(bucket),
        upload: async () => ({ data: null, error: { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" } }) });
    try {
        const result = await uploadVideo(mp4(4096));
        assert.equal(result.status, 413);
        assert.match(result.body.message, /Supabase Storage rejected this video as too large/);
        assert.equal(db.db.tables.mock_videos.length, 0);
        assert.equal(logs.error.filter((l) => l.includes("uploadMockVideo error")).length, 0);
    } finally {
        db.storage.from = realFrom;
    }
});

test("A video within the limit still uploads", async () => {
    const result = await uploadVideo(mp4(4096));
    assert.equal(result.status, 201);
    assert.equal(result.body.video.title, "Rules");
    assert.equal(db.db.tables.mock_videos.length, 1);
});

test("A client disconnecting mid-upload is logged as a disconnect, not an unhandled error", async () => {
    const before = { error: logs.error.length, warn: logs.warn.length };
    const boundary = "----gtstabort";
    await new Promise((resolve) => {
        const req = http.request(`${baseUrl}/api/admin/mock-video`, {
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken()}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": 900000 }
        });
        req.on("error", () => resolve());
        req.write(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="rules.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
        req.write(mp4(64 * 1024), () => setTimeout(() => { req.destroy(); resolve(); }, 100));
    });
    for (let i = 0; i < 50 && logs.warn.length === before.warn; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(logs.warn.slice(before.warn).some((l) => l.includes("Client disconnected during POST /api/admin/mock-video")));
    assert.equal(logs.error.slice(before.error).filter((l) => l.includes("Unhandled error")).length, 0);
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200, "server keeps serving");
});

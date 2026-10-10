const jwt = require("jsonwebtoken");
const supabase = require("../config/examSupabase");
const { isUuid } = require("../utils/validation");

// Verifies the JWT issued at admin login (adminAuth.controller.js) and
// re-checks the admin's current is_active status from the database on
// every request — so deactivating an admin takes effect immediately,
// not just once their existing token happens to expire.
const adminJwtAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization || "";
        const [scheme, token] = authHeader.split(" ");

        if (scheme !== "Bearer" || !token) {
            return res.status(401).json({
                success: false,
                message: "Admin authentication required"
            });
        }

        const secret = process.env.ADMIN_JWT_SECRET;
        if (!secret) {
            console.error("ADMIN_JWT_SECRET is not configured");
            return res.status(500).json({
                success: false,
                message: "Admin authentication is not configured"
            });
        }

        let payload;
        try {
            payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
        } catch {
            return res.status(401).json({
                success: false,
                message: "Invalid or expired admin session. Please log in again."
            });
        }

        // A student token must never pass as admin authorization.
        if (
            (payload.typ !== undefined && payload.typ !== "admin") ||
            payload.candidateId !== undefined ||
            !isUuid(payload.adminId)
        ) {
            return res.status(401).json({
                success: false,
                message: "Invalid or expired admin session. Please log in again."
            });
        }

        const { data: admin, error } = await supabase
            .from("admin_users")
            .select("id, name, email, role, is_active")
            .eq("id", payload.adminId)
            .maybeSingle();

        if (error) {
            console.error("Admin lookup error:", error);
            return res.status(500).json({
                success: false,
                message: "Unable to verify admin account"
            });
        }

        if (!admin || !admin.is_active) {
            return res.status(401).json({
                success: false,
                message: "This admin account is no longer active"
            });
        }

        req.admin = {
            id: admin.id,
            name: admin.name,
            email: admin.email,
            role: admin.role
        };

        next();
    } catch (error) {
        console.error("adminJwtAuth error:", error);
        return res.status(500).json({
            success: false,
            message: "Admin authentication failed"
        });
    }
};

module.exports = adminJwtAuth;

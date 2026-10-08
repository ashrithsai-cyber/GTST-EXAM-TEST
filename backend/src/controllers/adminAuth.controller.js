const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const supabase = require("../config/examSupabase");
const { logAdminAction } = require("../utils/auditLog");
const { isNonEmptyString } = require("../utils/validation");

// =====================================================
// LOGIN
// =====================================================

const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required"
            });
        }

        const { data: admin, error } = await supabase
            .from("admin_users")
            .select("id, name, email, password_hash, role, is_active")
            .eq("email", email.trim().toLowerCase())
            .maybeSingle();

        if (error) {
            console.error("Admin lookup error:", error);
            return res.status(500).json({
                success: false,
                message: "Unable to verify admin"
            });
        }

        // Same generic message whether the email doesn't exist or the
        // password is wrong — avoids leaking which admin emails exist.
        const invalidCredentials = () => res.status(401).json({
            success: false,
            message: "Invalid email or password"
        });

        if (!admin) {
            return invalidCredentials();
        }

        const passwordMatches = await bcrypt.compare(password, admin.password_hash);
        if (!passwordMatches) {
            return invalidCredentials();
        }

        if (!admin.is_active) {
            return res.status(403).json({
                success: false,
                message: "This admin account is not active"
            });
        }

        const secret = process.env.ADMIN_JWT_SECRET;
        if (!secret) {
            console.error("ADMIN_JWT_SECRET is not configured");
            return res.status(500).json({
                success: false,
                message: "Server error"
            });
        }

        const token = jwt.sign(
            { adminId: admin.id, role: admin.role, typ: "admin" },
            secret,
            { algorithm: "HS256", expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || "8h" }
        );

        await supabase
            .from("admin_users")
            .update({ last_login_at: new Date().toISOString() })
            .eq("id", admin.id);

        await logAdminAction(admin.id, "LOGIN", "admin_session", admin.id, null);

        return res.json({
            success: true,
            message: "Login successful",
            token,
            admin: {
                id: admin.id,
                name: admin.name,
                email: admin.email,
                role: admin.role
            }
        });

    } catch (error) {
        console.error("Admin login error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error. Please try again."
        });
    }
};


// =====================================================
// CURRENT ADMIN
//
// req.admin is already the freshly-verified, password-free row
// attached by adminJwtAuth — just echo it back.
// =====================================================

const me = async (req, res) => {
    return res.json({
        success: true,
        admin: req.admin
    });
};


module.exports = {
    login,
    me
};

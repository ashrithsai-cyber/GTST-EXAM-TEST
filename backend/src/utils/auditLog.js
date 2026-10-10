const supabase = require("../config/examSupabase");

// Records an admin mutation for later review. Never throws — a logging
// failure must not block the admin action it's describing, it's only
// ever reported to the server console.
const logAdminAction = async (adminId, action, resourceType, resourceId, metadata = null) => {
    try {
        const { error } = await supabase
            .from("admin_audit_logs")
            .insert({
                admin_id: adminId,
                action,
                resource_type: resourceType,
                resource_id: resourceId != null ? String(resourceId) : null,
                metadata
            });

        if (error) {
            console.error("Audit log insert error:", error);
        }
    } catch (error) {
        console.error("Audit log error:", error);
    }
};

module.exports = { logAdminAction };

const supabase = require("../config/examSupabase");
const { logAdminAction } = require("../utils/auditLog");

// Postgres "undefined_table" — thrown by every query below until
// backend/sql/007_proctoring_rules.sql has been run. Treated as "no
// rules configured yet" rather than a hard error, so the student page
// falls back to its bundled defaults and the admin page shows a clear
// "run the migration" empty state instead of a 500.
const UNDEFINED_TABLE = "42P01";

function toAdminRule(row) {
    return {
        id: row.id,
        ruleText: row.rule_text,
        displayOrder: row.display_order,
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

// =====================================================
// GET RULES (admin) — every rule, active or not, in display order.
// Every authenticated admin may view and mutate rules.
// =====================================================
const getRules = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("exam_rules")
            .select("*")
            .order("display_order", { ascending: true })
            .order("created_at", { ascending: true });

        if (error) {
            if (error.code === UNDEFINED_TABLE) {
                return res.json({ success: true, rules: [], migrated: false });
            }
            throw error;
        }

        return res.json({ success: true, rules: data.map(toAdminRule), migrated: true });
    } catch (error) {
        console.error("getRules error:", error);
        return res.status(500).json({ success: false, message: "Unable to load proctoring rules" });
    }
};

// =====================================================
// CREATE RULE — appended to the end of the list.
// =====================================================
const createRule = async (req, res) => {
    try {
        const ruleText = typeof req.body.ruleText === "string" ? req.body.ruleText.trim() : "";
        if (!ruleText) {
            return res.status(400).json({ success: false, message: "Rule text is required" });
        }

        // Next display_order = one past the current highest, so a new rule
        // always lands at the bottom of the list.
        const { data: last, error: lastError } = await supabase
            .from("exam_rules")
            .select("display_order")
            .order("display_order", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (lastError) {
            if (lastError.code === UNDEFINED_TABLE) {
                return res.status(400).json({ success: false, message: "Proctoring rules table not found. Run backend/sql/007_proctoring_rules.sql in Supabase first." });
            }
            throw lastError;
        }

        const nextOrder = (last?.display_order ?? 0) + 1;

        const { data, error } = await supabase
            .from("exam_rules")
            .insert({ rule_text: ruleText, display_order: nextOrder, updated_by: req.admin.id })
            .select("*")
            .single();

        if (error) throw error;

        await logAdminAction(req.admin.id, "CREATE", "exam_rule", data.id, { ruleText });

        return res.status(201).json({ success: true, rule: toAdminRule(data) });
    } catch (error) {
        console.error("createRule error:", error);
        return res.status(500).json({ success: false, message: "Unable to create rule" });
    }
};

// =====================================================
// UPDATE RULE — edit text, toggle active, or reorder.
// Only the fields actually supplied are changed.
// =====================================================
const updateRule = async (req, res) => {
    try {
        const { ruleId } = req.params;
        const updates = { updated_at: new Date().toISOString(), updated_by: req.admin.id };

        if (req.body.ruleText !== undefined) {
            const ruleText = typeof req.body.ruleText === "string" ? req.body.ruleText.trim() : "";
            if (!ruleText) return res.status(400).json({ success: false, message: "Rule text cannot be empty" });
            updates.rule_text = ruleText;
        }
        if (req.body.isActive !== undefined) {
            if (typeof req.body.isActive !== "boolean") {
                return res.status(400).json({ success: false, message: "isActive must be true or false" });
            }
            updates.is_active = req.body.isActive;
        }
        if (req.body.displayOrder !== undefined) {
            if (!Number.isInteger(req.body.displayOrder)) {
                return res.status(400).json({ success: false, message: "displayOrder must be an integer" });
            }
            updates.display_order = req.body.displayOrder;
        }

        const { data, error } = await supabase
            .from("exam_rules")
            .update(updates)
            .eq("id", ruleId)
            .select("*")
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Rule not found" });

        await logAdminAction(req.admin.id, "UPDATE", "exam_rule", ruleId, {
            fieldsChanged: Object.keys(updates).filter((k) => k !== "updated_at" && k !== "updated_by")
        });

        return res.json({ success: true, rule: toAdminRule(data) });
    } catch (error) {
        console.error("updateRule error:", error);
        return res.status(500).json({ success: false, message: "Unable to update rule" });
    }
};

// =====================================================
// DELETE RULE
// =====================================================
const deleteRule = async (req, res) => {
    try {
        const { ruleId } = req.params;

        const { data, error } = await supabase
            .from("exam_rules")
            .delete()
            .eq("id", ruleId)
            .select("id")
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Rule not found" });

        await logAdminAction(req.admin.id, "DELETE", "exam_rule", ruleId, null);

        return res.json({ success: true, message: "Rule deleted" });
    } catch (error) {
        console.error("deleteRule error:", error);
        return res.status(500).json({ success: false, message: "Unable to delete rule" });
    }
};

// =====================================================
// GET PUBLIC RULES (student-facing) — only the ACTIVE rules, in order,
// text only. This is what makes the admin's rule edits actually appear
// on the student Exam Proctoring & Rules page instead of a hardcoded
// list. Returns an empty list (never a 500) if the table doesn't exist
// yet, so the student frontend degrades to its bundled default rules.
// =====================================================
const getPublicRules = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("exam_rules")
            .select("id, rule_text, display_order")
            .eq("is_active", true)
            .order("display_order", { ascending: true })
            .order("created_at", { ascending: true });

        if (error) {
            if (error.code === UNDEFINED_TABLE) {
                return res.json({ success: true, rules: [] });
            }
            throw error;
        }

        return res.json({
            success: true,
            rules: data.map((r) => ({ id: r.id, text: r.rule_text }))
        });
    } catch (error) {
        console.error("getPublicRules error:", error);
        return res.status(500).json({ success: false, message: "Unable to load exam rules" });
    }
};

module.exports = {
    getRules,
    createRule,
    updateRule,
    deleteRule,
    getPublicRules
};

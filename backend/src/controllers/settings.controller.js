const supabase = require("../config/examSupabase");
const { getExamSettings } = require("./_examShared");
const { logAdminAction } = require("../utils/auditLog");

// =====================================================
// GET SETTINGS — any authenticated admin can view.
// =====================================================

const getSettings = async (req, res) => {
    try {
        const settings = await getExamSettings();
        return res.json({ success: true, settings });
    } catch (error) {
        console.error("getSettings error:", error);
        return res.status(500).json({ success: false, message: "Unable to load exam settings" });
    }
};

const FIELD_MAP = {
    cameraRequired: "camera_required",
    photoCaptureEnabled: "photo_capture_enabled",
    microphoneRequired: "microphone_required",
    fullscreenRequired: "fullscreen_required",
    proctoringEnabled: "proctoring_enabled",
    faceDetectionEnabled: "face_detection_enabled",
    videoRequired: "video_required",
    networkMonitoringEnabled: "network_monitoring_enabled",
    tabSwitchMonitoringEnabled: "tab_switch_monitoring_enabled"
};

// =====================================================
// UPDATE SETTINGS — available to every authenticated admin. Defensively,
// nothing here trusts req.body beyond the known boolean fields.
//
// These toggles actually change student exam behavior — see
// proctoring.controller.js (which fields count as warnings) and the
// student-facing GET /api/exam/settings consumed by SystemCheckContext /
// SystemCheckPage / ExamProctoringRulesPage — not just this admin page.
// =====================================================

const updateSettings = async (req, res) => {
    try {
        const updates = { updated_at: new Date().toISOString(), updated_by: req.admin.id };

        for (const [key, column] of Object.entries(FIELD_MAP)) {
            if (req.body[key] !== undefined) {
                if (typeof req.body[key] !== "boolean") {
                    return res.status(400).json({ success: false, message: `${key} must be true or false` });
                }
                updates[column] = req.body[key];
            }
        }

        const { data: existing, error: existingError } = await supabase
            .from("exam_settings")
            .select("id")
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();

        if (existingError) throw existingError;

        let row;
        if (existing) {
            const { data, error } = await supabase
                .from("exam_settings")
                .update(updates)
                .eq("id", existing.id)
                .select("*")
                .single();
            if (error) throw error;
            row = data;
        } else {
            const { data, error } = await supabase
                .from("exam_settings")
                .insert(updates)
                .select("*")
                .single();
            if (error) throw error;
            row = data;
        }

        await logAdminAction(req.admin.id, "UPDATE", "exam_settings", row.id, {
            fieldsChanged: Object.keys(updates).filter((k) => k !== "updated_at" && k !== "updated_by")
        });

        return res.json({
            success: true,
            settings: {
                cameraRequired: row.camera_required,
                photoCaptureEnabled: row.photo_capture_enabled ?? true,
                microphoneRequired: row.microphone_required,
                fullscreenRequired: row.fullscreen_required,
                proctoringEnabled: row.proctoring_enabled,
                faceDetectionEnabled: row.face_detection_enabled,
                videoRequired: row.video_required,
                networkMonitoringEnabled: row.network_monitoring_enabled,
                tabSwitchMonitoringEnabled: row.tab_switch_monitoring_enabled
            }
        });
    } catch (error) {
        console.error("updateSettings error:", error);
        return res.status(500).json({
            success: false,
            message: "Unable to update exam settings. Has backend/sql/005_settings_and_presence.sql been run?"
        });
    }
};

module.exports = {
    getSettings,
    updateSettings
};

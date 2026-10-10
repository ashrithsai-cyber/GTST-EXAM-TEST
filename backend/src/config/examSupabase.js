const { createClient } = require("@supabase/supabase-js");

// The exam project — exams, subjects, questions, exam_sessions,
// exam_answers, exam_events. Deliberately a separate Supabase project
// from the main website's registrationSupabase (registrations, payments,
// admin, etc.) so the two databases can never accidentally cross-touch
// each other's tables. This client uses the service_role key and is
// only ever imported by backend controllers — it is never bundled into
// frontend code.
//
// Lazily created (via the Proxy below) rather than at module load, so
// that login and every non-exam route keep working even before
// EXAM_SUPABASE_URL / EXAM_SUPABASE_SERVICE_ROLE_KEY are set — the
// error only surfaces, as a normal caught 500, the moment an exam
// controller actually tries to query this database.
let client = null;

function getClient() {
    if (client) return client;

    const examSupabaseUrl = process.env.EXAM_SUPABASE_URL;
    const examSupabaseServiceRoleKey = process.env.EXAM_SUPABASE_SERVICE_ROLE_KEY;

    if (!examSupabaseUrl || !examSupabaseServiceRoleKey) {
        throw new Error(
            "Exam database is not configured yet — set EXAM_SUPABASE_URL and EXAM_SUPABASE_SERVICE_ROLE_KEY in backend/.env to the dedicated exam Supabase project."
        );
    }

    client = createClient(examSupabaseUrl, examSupabaseServiceRoleKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    });

    return client;
}

module.exports = new Proxy({}, {
    get(_target, prop) {
        return getClient()[prop];
    }
});

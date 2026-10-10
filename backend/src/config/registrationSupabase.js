const { createClient } = require("@supabase/supabase-js");

const registrationSupabaseUrl = process.env.REGISTRATION_SUPABASE_URL;
const registrationSupabaseServiceRoleKey =
    process.env.REGISTRATION_SUPABASE_SERVICE_ROLE_KEY;

if (!registrationSupabaseUrl || !registrationSupabaseServiceRoleKey) {
    throw new Error(
        "Registration Supabase environment variables are missing"
    );
}

const registrationSupabase = createClient(
    registrationSupabaseUrl,
    registrationSupabaseServiceRoleKey,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

module.exports = registrationSupabase;

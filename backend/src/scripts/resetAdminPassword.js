// One-off maintenance tool -- NOT a route, never imported by server.js.
// Run manually from a terminal when an admin is locked out because the
// password is unknown:
//
//     node backend/src/scripts/resetAdminPassword.js
//
// This never reads or displays password_hash -- it looks the account up
// by email, shows only name/role/is_active for you to confirm it's the
// right one, then overwrites password_hash with a fresh bcrypt hash of
// a password you type interactively (not echoed, hashed locally). There
// is no API route for this on purpose: resetting an arbitrary admin's
// password has to stay something only someone with direct access to
// this server (and therefore already to EXAM_SUPABASE_SERVICE_ROLE_KEY)
// can do -- the same trust boundary createSuperAdmin.js relies on.

require("dotenv").config();
const bcrypt = require("bcrypt");
const supabase = require("../config/examSupabase");
const { prompt, promptHidden } = require("./_cliPrompt");

async function main() {
    console.log("GTST+ Exam Admin -- password reset");
    console.log("------------------------------------------------");

    const email = (await prompt("Email of the admin to reset: ")).trim().toLowerCase();

    if (!email) {
        console.error("Email is required.");
        process.exitCode = 1;
        return;
    }

    const { data: admin, error: lookupError } = await supabase
        .from("admin_users")
        .select("id, name, email, role, is_active")
        .eq("email", email)
        .maybeSingle();

    if (lookupError) {
        console.error("Unable to look up admin:", lookupError.message);
        process.exitCode = 1;
        return;
    }

    if (!admin) {
        console.error(`No admin found with email "${email}".`);
        process.exitCode = 1;
        return;
    }

    console.log("\nFound account:");
    console.log(`  name:      ${admin.name}`);
    console.log(`  email:     ${admin.email}`);
    console.log(`  role:      ${admin.role}`);
    console.log(`  is_active: ${admin.is_active}`);
    if (!admin.is_active) {
        console.log("  (note: this account is currently inactive -- resetting the password will not by itself let it log in; it also needs is_active set back to true.)");
    }

    const confirmation = await prompt('\nType RESET to overwrite this account\'s password: ');
    if (confirmation.trim() !== "RESET") {
        console.log("Cancelled -- no changes made.");
        return;
    }

    const password = await promptHidden("\nNew password (min 10 characters, not shown): ");
    const passwordConfirm = await promptHidden("Confirm new password: ");

    if (password.length < 10) {
        console.error("Password must be at least 10 characters.");
        process.exitCode = 1;
        return;
    }

    if (password !== passwordConfirm) {
        console.error("Passwords do not match.");
        process.exitCode = 1;
        return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { error: updateError } = await supabase
        .from("admin_users")
        .update({
            password_hash: passwordHash,
            updated_at: new Date().toISOString()
        })
        .eq("id", admin.id);

    if (updateError) {
        console.error("Unable to update password:", updateError.message);
        process.exitCode = 1;
        return;
    }

    console.log(`\nPassword reset for ${admin.email}. Log in at POST /api/admin/auth/login.`);
}

main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exitCode = 1;
});

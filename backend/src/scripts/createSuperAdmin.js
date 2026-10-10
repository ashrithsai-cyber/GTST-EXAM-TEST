// One-off bootstrap tool -- NOT a route, never imported by server.js.
// Run manually, once, from a terminal:
//
//     node backend/src/scripts/createSuperAdmin.js
//
// Seeds the FIRST admin account. There is a single role ("admin") — every
// admin can do everything, including creating more admins through an
// authenticated POST /api/admin/users. Refuses to run if any admin
// already exists (checked against the database, not a local flag), so it
// can only ever seed the first one. There is deliberately no flag to
// bypass this check.
//
// The password is typed interactively (not echoed to the terminal) and
// hashed locally before the insert -- it is never written to a file, an
// env var, git, or any log.

require("dotenv").config();
const bcrypt = require("bcrypt");
const supabase = require("../config/examSupabase");
const { prompt, promptHidden } = require("./_cliPrompt");

async function main() {
    console.log("GTST+ Exam Admin -- first admin bootstrap");
    console.log("------------------------------------------------");

    const { data: existing, error: checkError } = await supabase
        .from("admin_users")
        .select("id")
        .limit(1);

    if (checkError) {
        console.error("Unable to check for an existing admin:", checkError.message);
        process.exitCode = 1;
        return;
    }

    if (existing && existing.length > 0) {
        console.error(
            "\nAn admin already exists. Refusing to create another one through this script.\n" +
            "Create additional admins through POST /api/admin/users, authenticated as an existing admin.\n" +
            "(Locked out of the existing account? Use resetAdminPassword.js instead.)\n"
        );
        process.exitCode = 1;
        return;
    }

    const name = (await prompt("Full name: ")).trim();
    const email = (await prompt("Email: ")).trim().toLowerCase();
    const password = await promptHidden("Password (min 10 characters, not shown): ");
    const passwordConfirm = await promptHidden("Confirm password: ");

    if (!name || !email) {
        console.error("Name and email are required.");
        process.exitCode = 1;
        return;
    }

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

    const { data, error } = await supabase
        .from("admin_users")
        .insert({
            name,
            email,
            password_hash: passwordHash,
            role: "admin"
        })
        .select("id, name, email, role")
        .single();

    if (error) {
        if (error.code === "23505") {
            console.error("An admin with this email already exists.");
        } else {
            console.error("Unable to create admin:", error.message);
        }
        process.exitCode = 1;
        return;
    }

    console.log("\nAdmin created successfully:");
    console.log(`  id:    ${data.id}`);
    console.log(`  name:  ${data.name}`);
    console.log(`  email: ${data.email}`);
    console.log("\nLog in at POST /api/admin/auth/login.");
}

main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exitCode = 1;
});

// Applies the REAL backend/sql migrations, in numeric order, to an empty
// PostgreSQL database. Only the Supabase platform objects the migrations
// expect to already exist are stubbed: the three API roles and the
// storage.buckets table. Test-only.
const fs = require("node:fs");
const path = require("node:path");

const SQL_DIR = path.join(__dirname, "..", "..", "sql");

const SUPABASE_PLATFORM_STUBS = `
do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create schema if not exists storage;
create table if not exists storage.buckets (
    id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[]
);
`;

function migrationFiles() {
    return fs.readdirSync(SQL_DIR).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
}

function readMigration(name) {
    return fs.readFileSync(path.join(SQL_DIR, name), "utf8");
}

// exec(sql) runs a multi-statement script on the target database.
async function applyMigrations(exec, { from = null } = {}) {
    await exec(SUPABASE_PLATFORM_STUBS);
    const applied = [];
    for (const name of migrationFiles()) {
        if (from && name < from) continue;
        try {
            await exec(readMigration(name));
        } catch (error) {
            error.message = `${name}: ${error.message}`;
            throw error;
        }
        applied.push(name);
    }
    return applied;
}

module.exports = { SUPABASE_PLATFORM_STUBS, migrationFiles, applyMigrations };

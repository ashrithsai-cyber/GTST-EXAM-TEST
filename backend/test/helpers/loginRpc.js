// Test double for migration 018. The real lease and answer transaction
// races are enforced by PostgreSQL row locks, not by this in-memory model.
function loginRpc(db, name, args) {
    const table = db.tables.student_login_sessions ||= [];
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const row = table.find((r) => r.candidate_id === args.p_candidate_id);
    const active = row && row.login_session_id === args.p_login_session_id &&
        Date.parse(row.expires_at) > now && Date.parse(row.token_expires_at) > now;

    if (name === "acquire_student_login_session") {
        if (row && row.login_session_id !== args.p_login_session_id &&
            Date.parse(row.expires_at) > now && Date.parse(row.token_expires_at) > now) {
            return { data: { active: false }, error: null };
        }
        const resumed = !!row && row.login_session_id === args.p_login_session_id;
        const next = row || { candidate_id: args.p_candidate_id };
        Object.assign(next, {
            login_session_id: args.p_login_session_id,
            created_at: resumed ? row.created_at : timestamp,
            last_seen_at: timestamp,
            token_expires_at: args.p_token_expires_at,
            expires_at: new Date(Math.min(now + 600_000, Date.parse(args.p_token_expires_at))).toISOString()
        });
        if (!row) table.push(next);
        return { data: { active: true, resumed, expiresAt: next.expires_at, serverTime: timestamp }, error: null };
    }
    if (name === "touch_student_login_session") {
        if (!active || Date.parse(args.p_token_expires_at) <= now) return { data: { active: false }, error: null };
        if (Date.parse(row.last_seen_at) <= now - 15_000 || Date.parse(args.p_token_expires_at) > Date.parse(row.token_expires_at)) {
            row.last_seen_at = timestamp;
            row.token_expires_at = new Date(Math.max(Date.parse(row.token_expires_at), Date.parse(args.p_token_expires_at))).toISOString();
            row.expires_at = new Date(Math.min(now + 600_000, Date.parse(row.token_expires_at))).toISOString();
            const presence = (db.tables.student_presence || []).find((r) => r.candidate_id === args.p_candidate_id);
            if (presence) presence.updated_at = timestamp;
        }
        return { data: { active: true, expiresAt: row.expires_at, serverTime: timestamp }, error: null };
    }
    if (name === "release_student_login_session") {
        if (row?.login_session_id !== args.p_login_session_id) return { data: false, error: null };
        db.tables.student_login_sessions = table.filter((r) => r !== row);
        const presence = (db.tables.student_presence || []).find((r) => r.candidate_id === args.p_candidate_id);
        if (presence && presence.stage !== "COMPLETED") presence.updated_at = "1970-01-01T00:00:00.000Z";
        return { data: true, error: null };
    }
    if (name === "assert_exam_login_session") return { data: !!active, error: null };
    if (name === "admin_release_student_login_session") {
        if (!row) return { data: { released: false }, error: null };
        db.tables.student_login_sessions = table.filter((r) => r !== row);
        const presence = (db.tables.student_presence || []).find((r) => r.candidate_id === args.p_candidate_id);
        if (presence && presence.stage !== "COMPLETED") presence.updated_at = "1970-01-01T00:00:00.000Z";
        return { data: { released: true, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at }, error: null };
    }
    return undefined;
}

module.exports = { loginRpc };

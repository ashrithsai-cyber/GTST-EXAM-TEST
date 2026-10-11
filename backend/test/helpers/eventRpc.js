const crypto = require('node:crypto');
function eventRpc(db, name, args) {
    if (name !== 'record_exam_event') return undefined;
    const tables = db.tables;
    const s = (tables.exam_sessions || []).find(s => s.id === args.p_session_id);
    const result = data => ({ data, error: null });
    if (!s) return result({ code: 'NOT_FOUND' });
    if (s.candidate_id !== args.p_candidate_id) return result({ code: 'FORBIDDEN' });
    const rows = tables.exam_events ||= [];
    const existing = args.p_client_event_id && rows.find(e => e.session_id === s.id && e.client_event_id === args.p_client_event_id);
    if (existing) return result({ success: true, recorded: true, duplicate: true, eventId: existing.id,
        violation: existing.is_violation, violationCount: s.proctoring_warning_count, blocked: false });
    const now = new Date().toISOString();
    const occurred = args.p_occurred_at || now;
    if (Date.parse(occurred) > Date.now() + 30000 || Date.parse(occurred) < Date.parse(s.started_at || s.created_at) - 30000) return result({ code: 'INVALID_EVENT_TIME' });
    if (s.status !== 'IN_PROGRESS' && !(s.status === 'SUBMITTED' && args.p_client_event_id && args.p_occurred_at && occurred <= s.submitted_at)) return result({ code: 'NOT_IN_PROGRESS', status: s.status });
    const ev = { id: crypto.randomUUID(), session_id: s.id, client_event_id: args.p_client_event_id,
        event_type: args.p_event_type, event_message: args.p_event_message, occurred_at: occurred,
        is_violation: args.p_is_violation, created_at: now, reviewed: false };
    rows.push(ev);
    if (ev.is_violation) s.proctoring_warning_count = (s.proctoring_warning_count || 0) + 1;
    return result({ success: true, recorded: true, eventId: ev.id, violation: ev.is_violation,
        violationCount: s.proctoring_warning_count || 0, blocked: false });
}
module.exports = { eventRpc };

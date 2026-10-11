function monitoringRpc(db, name, args) {
    const tables = db.tables;
    const sessionIds = args.p_session_ids || [];
    const result = (data) => ({ data, error: null });

    if (name === "admin_exam_attempt_progress") {
        const sessions = (tables.exam_sessions || []).filter((session) => sessionIds.includes(session.id));
        return result(sessions.map((session) => {
            const snapshot = (tables.exam_attempt_questions || []).filter((row) => row.session_id === session.id);
            const total = snapshot.length;
            const position = Math.max(0, Math.min(session.current_position || 0, total));
            const current = snapshot.find((row) => row.position === position);
            return {
                session_id: session.id,
                attempted: position,
                total,
                current_subject: total === 0 ? null :
                    session.status === "SUBMITTED" || position >= total ? "Completed" : current?.subject_name || null
            };
        }));
    }

    if (name === "admin_monitoring_event_summary") {
        const rows = (tables.exam_events || []).filter((event) => sessionIds.includes(event.session_id));
        const summaries = new Map();
        for (const event of rows) {
            let summary = summaries.get(event.session_id);
            if (!summary) {
                summary = { session_id: event.session_id, event_counts: {}, violation_count: 0, latest_event_at: null };
                summaries.set(event.session_id, summary);
            }
            summary.event_counts[event.event_type] = (summary.event_counts[event.event_type] || 0) + 1;
            const isViolation = event.is_violation ?? !["NETWORK_DISCONNECT", "NETWORK_RECONNECT"].includes(event.event_type);
            if (isViolation) summary.violation_count += 1;
            if (!summary.latest_event_at || event.created_at > summary.latest_event_at) summary.latest_event_at = event.created_at;
        }
        return result(Array.from(summaries.values()));
    }

    return undefined;
}

module.exports = { monitoringRpc };

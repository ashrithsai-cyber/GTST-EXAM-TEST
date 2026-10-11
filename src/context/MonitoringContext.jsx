import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { AuthContext } from './AuthContext';
import { ExamContext } from './ExamContext';
import { createProctoringQueue } from '../utils/proctoringQueue';
import { recordProctoringEvent } from '../services/examService';

export const MonitoringContext = createContext();
export function MonitoringProvider({ children }) {
  const { token, student } = useContext(AuthContext);
  const { sessionId } = useContext(ExamContext);
  const tokenRef = useRef(token); tokenRef.current = token;
  const [pendingCount, setPendingCount] = useState(0);
  const queue = useMemo(() => sessionId && student?.registrationId ? createProctoringQueue({
    key: `gtst_events_${student.registrationId}_${sessionId}`,
    send: event => recordProctoringEvent(tokenRef.current, { sessionId, ...event }),
  }) : null, [sessionId, student?.registrationId]);
  useEffect(() => {
    let cancelled = false;
    const flush = async () => {
      if (!queue || !navigator.onLine) return;
      try { await queue.flush(); } catch { /* Keep every unacknowledged event. */ }
      if (!cancelled) setPendingCount(queue.pending());
    };
    void flush();
    const timer = setInterval(flush, 5000);
    window.addEventListener('online', flush);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('online', flush); };
  }, [queue]);
  const reportEvent = useCallback(async (eventType, eventMessage) => {
    if (!queue) return null;
    const { flush } = queue.enqueue(eventType, eventMessage);
    setPendingCount(queue.pending());
    try { return await flush; } finally { setPendingCount(queue.pending()); }
  }, [queue]);
  return <MonitoringContext.Provider value={{ reportEvent, pendingCount }}>
    {children}
    {pendingCount > 0 && <div className="monitoring-save-status" role="status">{pendingCount} monitoring event{pendingCount === 1 ? '' : 's'} waiting to save. Keep this tab open while reconnecting.</div>}
  </MonitoringContext.Provider>;
}

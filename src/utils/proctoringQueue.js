export function createProctoringQueue({ key, storage = globalThis.sessionStorage, send, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() }) {
  let events = [];
  let busy = null;
  try { const saved = JSON.parse(storage?.getItem(key) || '[]'); if (Array.isArray(saved)) events = saved.filter(e => e?.clientEventId && e?.eventType && e?.occurredAt); } catch { /* Memory queue remains usable. */ }
  const persist = () => { try { storage?.setItem(key, JSON.stringify(events)); } catch { /* Memory fallback. */ } };
  const flush = () => {
    if (busy) return busy;
    busy = (async () => {
      const acknowledgements = new Map();
      while (events.length) {
        const event = events[0];
        const response = await send(event);
        if (!response?.success) throw new Error('Event was not acknowledged');
        acknowledgements.set(event.clientEventId, response);
        events.shift(); persist();
      }
      return acknowledgements;
    })().finally(() => { busy = null; });
    return busy;
  };
  const enqueue = (eventType, eventMessage) => {
    const event = { clientEventId: uuid(), occurredAt: now(), eventType, eventMessage };
    events.push(event); persist();
    return { event, flush: flush().then(acks => acks.get(event.clientEventId)) };
  };
  return { enqueue, flush, pending: () => events.length };
}

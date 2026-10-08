// Anchor countdowns to server durations and a monotonic browser clock.
// Changing the device's wall clock cannot add examination time.
export function createCountdown(remainingSeconds, now = performance.now()) {
  return remainingSeconds == null ? null : {
    remainingSeconds: Math.max(0, Number(remainingSeconds) || 0),
    receivedAt: now,
  };
}

export function readCountdown(anchor, now = performance.now()) {
  if (!anchor) return null;
  return Math.max(0, Math.ceil(anchor.remainingSeconds - (now - anchor.receivedAt) / 1000));
}

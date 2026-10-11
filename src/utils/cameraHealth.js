// Testable camera health check. Visibility pauses frame-stall detection;
// track ended/disabled/muted are still device signals, not face violations.
export function createCameraHealth({ graceMs = 3000, stallMs = 8000 } = {}) {
  let unavailableSince = null;
  let lastFrameAt = null;
  let lastTime = null;
  return ({ track, video, hidden = false, now }) => {
    if (!track || track.readyState === 'ended') return { ready: false, error: 'Your camera was disconnected. Reconnect it and click Retry Camera.' };
    if (!track.enabled || track.muted) {
      unavailableSince ??= now;
      if (now - unavailableSince >= graceMs) return { ready: false, error: 'Your camera is muted or disabled. Restore camera access or click Retry Camera.' };
      return null;
    }
    unavailableSince = null;
    if (hidden || !video) { lastFrameAt = now; lastTime = null; return null; }
    if (video.currentTime !== lastTime && video.readyState >= 2 && video.videoWidth > 0) {
      lastTime = video.currentTime; lastFrameAt = now;
      return { ready: true, error: '' };
    }
    lastFrameAt ??= now;
    if (now - lastFrameAt >= stallMs) return { ready: false, error: 'Your camera is not sending new frames. Check your camera and click Retry Camera.' };
    return null;
  };
}

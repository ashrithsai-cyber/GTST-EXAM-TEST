import React, { useEffect, useState } from 'react';
import Header from './Header';
import Footer from './Footer';

const RESYNC_INTERVAL_MS = 8000;

function formatCountdown(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// Shown once a student has finished the system check and proctoring
// rules and reaches the exam itself, but the admin-scheduled start time
// hasn't arrived yet (server clock). The displayed countdown is purely
// cosmetic — anchored to the server time this waiting state was fetched
// with (waitingForStart.serverTime), not this device's own clock, and
// periodically re-synced by re-calling onRefresh (ExamContext.initExam,
// i.e. the same POST /session/start the real exam start uses). The
// actual gate that decides when the exam truly becomes available is
// enforced server-side, entirely independent of anything computed here
// — so changing this device's clock cannot start the exam early.
const ExamWaitingRoom = ({ waitingForStart, onRefresh, examName }) => {
  const [secondsLeft, setSecondsLeft] = useState(null);

  useEffect(() => {
    if (!waitingForStart) return undefined;
    const offsetMs = new Date(waitingForStart.serverTime).getTime() - waitingForStart.fetchedAtClientMs;
    const targetMs = new Date(waitingForStart.examStartAt).getTime();

    const tick = () => {
      const left = Math.round((targetMs - (Date.now() + offsetMs)) / 1000);
      setSecondsLeft(Math.max(0, left));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [waitingForStart]);

  // Re-validates with the server periodically (and the instant the local
  // display reaches zero) — this is what actually flips the student into
  // the exam once it's genuinely live; the countdown above never does.
  useEffect(() => {
    if (!waitingForStart) return undefined;
    const poll = setInterval(() => onRefresh(), RESYNC_INTERVAL_MS);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingForStart]);

  useEffect(() => {
    if (secondsLeft === 0) onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft]);

  const startLabel = waitingForStart
    ? new Date(waitingForStart.examStartAt).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }) + ' IST'
    : '';

  return (
    <>
      <Header />
      <div className="tricolor"></div>
      <div className="page-wrap">
        <div className="card info-card" style={{ maxWidth: '480px', margin: '60px auto', textAlign: 'center', padding: '40px' }}>
          <h3>Your Exam Hasn't Started Yet</h3>
          <p style={{ marginTop: '10px', color: 'var(--ink-muted)' }}>
            {examName ? `${examName} is` : 'This exam is'} scheduled to start at <b>{startLabel}</b>.
            You're all checked in — please wait, the exam will begin automatically.
          </p>
          <div
            style={{
              margin: '24px auto 8px',
              fontSize: '38px',
              fontWeight: 700,
              letterSpacing: '1px',
              color: 'var(--navy)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {secondsLeft === null ? '--:--' : formatCountdown(secondsLeft)}
          </div>
          <p className="muted" style={{ fontSize: '12.5px' }}>
            Do not close or refresh this page — it will move to your exam automatically.
          </p>
        </div>
      </div>
      <Footer />
    </>
  );
};

export default ExamWaitingRoom;

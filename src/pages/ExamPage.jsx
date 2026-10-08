import React, { useState, useEffect, useContext, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { ExamContext } from '../context/ExamContext';
import { SystemCheckContext } from '../context/SystemCheckContext';
import { BrandingContext } from '../context/BrandingContext';
import { useMicrophone } from '../hooks/useMicrophone';
import { useFaceDetection } from '../hooks/useFaceDetection';
import { recordPresence, recordProctoringEvent } from '../services/examService';
import Header from '../components/common/Header';
import Footer from '../components/common/Footer';
import ExamWaitingRoom from '../components/common/ExamWaitingRoom';
import { usePreventBackNavigation } from '../hooks/usePreventBackNavigation';

const NO_FACE_GRACE_MS = 3000;
// Visual-only final-countdown warning on the overall exam timer. The
// server-side deadline and the countdown itself are unchanged.
const FINAL_WARNING_SECONDS = 20;
// Student-facing wording for each counted violation in the warning popup.
const VIOLATION_DETAILS = {
  CAMERA_DISABLED: { title: 'Camera Blocked', reason: 'Your camera was blocked, turned off or disconnected. Keep your camera on for the entire examination.' },
  MULTIPLE_FACE: { title: 'Multiple Faces Detected', reason: 'More than one face was detected in the camera frame. Only you may be visible during the examination.' },
  NO_FACE: { title: 'No Face Detected', reason: 'Your face was not visible in the camera frame. Stay in front of the camera at all times.' },
  MICROPHONE_DISABLED: { title: 'Microphone Muted', reason: 'Your microphone was muted, disabled or disconnected. Keep your microphone on for the entire examination.' },
  RIGHT_CLICK: { title: 'Right-Click Used', reason: 'Right-click is not allowed during the examination.' },
  TAB_SWITCH: { title: 'Tab Switched', reason: 'You switched away from the examination tab. Stay on this page until you submit.' },
  WINDOW_BLUR: { title: 'Exam Window Left', reason: 'The examination window lost focus because another window or application was opened.' },
  FULLSCREEN_EXIT: { title: 'Fullscreen Exited', reason: 'You exited fullscreen mode. The examination must be taken in fullscreen.' },
};
const violationDetails = (eventType) => VIOLATION_DETAILS[eventType] || { title: 'Proctoring Violation', reason: 'A proctoring rule was violated.' };
// Tab switch, window blur and fullscreen exit usually fire together for a
// single action; only the first within this window is reported (the
// backend applies the same coalescing as a second line of defence).
const FOCUS_LOSS_COALESCE_MS = 3000;

function safeUserError(error, fallback) {
  if (error?.data?.message) return error.data.message;
  if (error?.status === 0) return error.message || fallback;
  if (error?.name === 'ReferenceError' || (error?.message || '').endsWith(' is not defined')) {
    return fallback;
  }
  return error?.message || fallback;
}

const ExamPage = () => {
  const navigate = useNavigate();
  const { student, token } = useContext(AuthContext);
  const { examSettings, settingsLoaded, camera, resetSystemCheck } = useContext(SystemCheckContext);
  const { logoUrl } = useContext(BrandingContext);
  const {
    sessionId, examMeta, subjectsMeta, currentQuestion,
    timeLeft,
    submitted,
    banners, setBanners,
    saveToastOn, setSaveToastOn,
    getAns, setAns, saveAnswerDraft, questionItems, draftStatus,
    examLoading, examInitError, setExamInitError, initExam, lockAnswerAndAdvance,
    waitingForStart, examTimeLeft,
    answers, finalizeSubmission,
  } = useContext(ExamContext);

  const microphone = useMicrophone({ enabled: settingsLoaded && examSettings.microphoneRequired });
  const face = useFaceDetection(camera.videoRef, camera.ready && examSettings.faceDetectionEnabled);

  useEffect(() => {
    const video = camera.videoRef.current;
    if (!video || !camera.stream) return undefined;
    if (video.srcObject !== camera.stream) video.srcObject = camera.stream;
    video.play().catch(() => {});
    return () => {
      if (video.srcObject === camera.stream) video.srcObject = null;
    };
  }, [camera.stream]);

  const [fullscreenExited, setFullscreenExited] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const advancingRef = useRef(false);
  const questionStartRef = useRef(performance.now());
  const goNextRef = useRef(null);
  const expiredQuestionIdRef = useRef(null);
  const examDeadlineHandledRef = useRef(false);
  // Bumped after an automatic advance fails offline, so the expiry effects
  // below retry once the connection returns (the timer stays at 0 then).
  const [autoAdvanceRetry, setAutoAdvanceRetry] = useState(0);
  const lastFocusLossRef = useRef(0);

  useEffect(() => {
    if (!student) {
      navigate('/');
      return;
    }
    initExam().then((res) => {
      if (res.success && res.examComplete) {
        navigate(res.submitted ? '/success' : '/summary', { replace: true });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student]);

  useEffect(() => {
    if (!student || !token || !sessionId) return undefined;
    recordPresence(token, 'IN_EXAM').catch(() => {});
    const interval = setInterval(() => recordPresence(token, 'IN_EXAM').catch(() => {}), 10000);
    return () => clearInterval(interval);
  }, [student, token, sessionId]);

  const q = currentQuestion;
  const ans = q ? getAns(q.id) : { sel: null };
  const letters = ['A', 'B', 'C', 'D'];
  const examReady = !examLoading && !examInitError && !!q;

  const addBanner = (type, text, autoHideMs) => {
    const id = Date.now() + Math.random();
    setBanners(prev => [...prev, { id, type, text }]);
    if (autoHideMs) {
      setTimeout(() => {
        setBanners(prev => prev.filter(b => b.id !== id));
      }, autoHideMs);
    }
  };

  const dismissBanner = (id) => {
    setBanners(prev => prev.filter(b => b.id !== id));
  };

  // Reports a proctoring event to the backend. Returns whether it was
  // actually confirmed saved — callers must only tell the student
  // "this activity has been recorded" once this resolves true, never
  // unconditionally, since the whole point is that the claim has to be
  // true. A 200 response with recorded: false (an admin has disabled
  // this check in Exam Settings, so the backend intentionally didn't
  // log it) must resolve false here too, not just a thrown request.
  // The violation popup currently shown (null when none).
  const [violation, setViolation] = useState(null);

  // Resolves with the backend's response (recorded, violation,
  // violationCount), or null if the request failed.
  const reportEventDetails = useCallback(async (eventType, eventMessage) => {
    if (!sessionId) return null;
    try {
      return await recordProctoringEvent(token, { sessionId, eventType, eventMessage });
    } catch (error) {
      // This event was the one that hit (or already was past) the
      // proctoring warning limit — the backend has blocked the session.
      // Surface the same full-page "Examination Blocked" state used
      // elsewhere immediately, rather than leaving the student on a
      // question that can never be saved again until they happen to hit
      // Next (or the per-question timer eventually forces it).
      if (error.data?.blocked) {
        setViolation(null);
        setExamInitError({ message: safeUserError(error, 'The examination has been blocked.'), status: error.status,
          data: error.data });
      }
      return null;
    }
  }, [sessionId, token]);
  const reportEvent = useCallback(async (eventType, eventMessage) => {
    const response = await reportEventDetails(eventType, eventMessage);
    return !!response && response.recorded !== false;
  }, [reportEventDetails]);

  // Reports a violation and, once the backend has confirmed it was
  // recorded, shows the violation popup. Violations are captured only —
  // there is no warning limit and nothing is blocked. If it wasn't recorded (check disabled in Exam Settings, or the
  // request failed) the popup would be a false claim, so the plain
  // banner is shown instead.
  const reportViolation = useCallback(async (eventType, eventMessage, fallbackText) => {
    const response = await reportEventDetails(eventType, eventMessage);
    if (response && response.recorded !== false) {
      setViolation({ id: Date.now(), eventType });
    } else if (fallbackText) {
      addBanner('danger', fallbackText, 5000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportEventDetails]);

  // Reports a focus-loss style event (tab switch / window blur /
  // fullscreen exit) unless another one was reported moments ago for the
  // same underlying action.
  const reportFocusLoss = useCallback((eventType, eventMessage, fallbackText) => {
    const now = Date.now();
    if (now - lastFocusLossRef.current < FOCUS_LOSS_COALESCE_MS) return;
    lastFocusLossRef.current = now;
    reportViolation(eventType, eventMessage, fallbackText);
  }, [reportViolation]);

  const formatTime = (sec) => {
    sec = Math.max(0, sec);
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    return `${m}:${s}`;
  };

  const selectOption = (optIdx) => {
    if (advancingRef.current || !q || timeLeft <= 0 || examTimeLeft === 0) return;
    setAns(q.id, { sel: optIdx });
    saveAnswerDraft(q.id, ['A', 'B', 'C', 'D'][optIdx]).catch((error) => {
      addBanner('danger', safeUserError(error, 'Unable to save your answer. Please retry.'), 4000);
    });
  };

  const clearResponse = () => {
    if (!q || advancingRef.current || timeLeft <= 0 || examTimeLeft === 0) return;
    setAns(q.id, { sel: null });
    saveAnswerDraft(q.id, null).catch((error) => addBanner('danger', safeUserError(error, 'Unable to clear your response. Please retry.'), 4000));
  };

  // Locks the current question's answer (whatever it is, including
  // unanswered) and moves forward — called both by the Next button and by
  // timer expiry. advancingRef makes both paths idempotent so a rapid
  // click can never fire twice or race the auto-expiry, and the actual
  // lock/advance happens on the backend, so a network failure here leaves
  // the student able to retry rather than silently losing the answer.
  // The "Answer Saved" toast only appears once this backend call has
  // actually succeeded — never optimistically on selection.
  const goNext = async () => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    setIsAdvancing(true);

    const finishedSubjectName = q?.subjectName;
    const timeSpentSeconds = Math.max(0, Math.round((performance.now() - questionStartRef.current) / 1000));

    try {
      const res = await lockAnswerAndAdvance(timeSpentSeconds);

      setSaveToastOn(true);
      setTimeout(() => setSaveToastOn(false), 1200);

      if (res.examComplete) {
        navigate(res.autoSubmitted || res.submitted ? '/success' : '/summary', { replace: true });
        return;
      }

      if (res.sectionComplete) {
        addBanner('info', `${finishedSubjectName} section complete. Moving to the next section.`, 3000);
      }
    } catch (error) {
      advancingRef.current = false;
      setIsAdvancing(false);
      // Unreachable server: let a timer-driven advance run again when the
      // connection returns. The server keeps the timely draft and rejects
      // any selection made after the question expired.
      if (error.status === 0) {
        expiredQuestionIdRef.current = null;
        examDeadlineHandledRef.current = false;
        setTimeout(() => setAutoAdvanceRetry((count) => count + 1), 5000);
      }
      if (error.data?.status === 'SUBMITTED' || error.data?.submittedAt) {
        await initExam();
        navigate('/success', { replace: true });
        return;
      }
      // The session was blocked server-side (3rd proctoring warning hit
      // while this request was in flight, or already blocked before it).
      // Showing the generic "check your connection" banner here would be
      // actively misleading — retrying can never succeed. Route through
      // the same full-page error state initExam() already uses for a
      // SUBMITTED session, rather than leaving the student stuck
      // re-clicking Next forever.
      if (error.data?.status === 'BLOCKED') {
        setExamInitError({ message: safeUserError(error, 'The examination has been blocked.'), status: error.status, data: error.data });
        return;
      }
      // The student JWT (STUDENT_JWT_EXPIRES_IN, default 4h) has expired
      // mid-exam — studentAuth.js rejects every further call with 401.
      // This is recoverable (the IN_PROGRESS session on the server is
      // untouched; logging back in resumes it — see initExam), so this
      // must say so and point at re-login rather than showing the same
      // "check your connection" banner an expired token can never recover
      // from by retrying.
      if (error.status === 401) {
        setExamInitError({
          message: 'Your session has expired. Your progress has been saved — please log in again to continue this exam.',
          status: 401,
          data: { status: 'SESSION_EXPIRED' },
        });
        return;
      }
      // 409: the server's question pointer has moved on without this page
      // (the exam is open in another tab, or this was a duplicate
      // request). Re-sync to wherever the server actually is.
      if (error.status === 409) {
        const res = await initExam();
        if (res.success && res.examComplete) navigate(res.submitted ? '/success' : '/summary', { replace: true });
        return;
      }
      addBanner('danger', safeUserError(error, 'Unable to save your answer. Please check your connection and try again.'), 5000);
    }
  };

  // Timer callbacks outlive the render that created them — always call
  // the latest goNext so it reads the answer selected *now*, not the one
  // selected when the question first rendered.
  goNextRef.current = goNext;

  const currentQuestionId = q?.id;
  useEffect(() => {
    questionStartRef.current = performance.now();
    advancingRef.current = false;
    setIsAdvancing(false);
  }, [currentQuestionId]);

  // The context anchors these countdowns to the server using performance.now.
  // The backend enforces deadlines even if this page is offline or suspended.
  // Waits while offline; on reconnect a question that expired meanwhile
  // advances automatically instead of sitting at 0:00.
  useEffect(() => {
    if (!examReady || !isOnline || timeLeft > 0 || !currentQuestionId) return;
    if (expiredQuestionIdRef.current === currentQuestionId) return;
    expiredQuestionIdRef.current = currentQuestionId;
    goNextRef.current();
  }, [examReady, isOnline, timeLeft, currentQuestionId, autoAdvanceRetry]);

  useEffect(() => {
    if (examReady && isOnline && examTimeLeft === 0 && !examDeadlineHandledRef.current) {
      examDeadlineHandledRef.current = true;
      goNextRef.current();
    } else if (examTimeLeft !== null && examTimeLeft > 0) {
      examDeadlineHandledRef.current = false;
    }
  }, [examReady, isOnline, examTimeLeft, autoAdvanceRetry]);

  useEffect(() => {
    if (submitted) navigate('/success', { replace: true });
  }, [submitted, navigate]);

  // Browsers only honour this during a user gesture; when it's refused
  // (e.g. after a page refresh) the "Return to Full Screen" overlay below
  // gives the student a button to do it.
  const enterFullscreen = () => {
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

  // Tab switch — reports to the backend and only claims "recorded" once
  // that call actually succeeds.
  useEffect(() => {
    if (settingsLoaded && examSettings.fullscreenRequired) enterFullscreen();
    const handleVisibility = () => {
      if (document.hidden) {
        reportFocusLoss('TAB_SWITCH', 'Student switched away from the exam tab.', '⚠ You switched away from the exam window.');
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportFocusLoss, examSettings.fullscreenRequired, settingsLoaded]);

  // Window blur / focus loss — distinct from a tab switch (e.g. clicking
  // into another application without switching browser tabs).
  useEffect(() => {
    const handleBlur = () => {
      reportFocusLoss('WINDOW_BLUR', 'Exam window lost focus.', '⚠ The exam window lost focus.');
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportFocusLoss]);

  // Fullscreen exit — already shown via the blocking "Return to Full
  // Screen" overlay below, so this just logs it rather than adding a
  // second, redundant toast. Only an actual exit (a fullscreenchange
  // event) is reported: arriving on this page outside fullscreen, e.g.
  // after a refresh, just shows the overlay — refreshing is a supported
  // recovery path, not a violation.
  useEffect(() => {
    const isExited = () => settingsLoaded && examSettings.fullscreenRequired && !document.fullscreenElement;
    setFullscreenExited(isExited());
    const handleFullscreenChange = () => {
      const exited = isExited();
      setFullscreenExited(exited);
      if (exited) {
        reportFocusLoss('FULLSCREEN_EXIT', 'Student exited fullscreen mode.');
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [reportFocusLoss, examSettings.fullscreenRequired, settingsLoaded]);

  // Right-click and copy/cut/paste are blocked while a question is on
  // screen. A right-click is reported as RIGHT_CLICK (a counted warning,
  // same as before); copy/cut/paste as COPY_PASTE, which the backend
  // records for the admin without counting it as a warning. Coalesced on
  // their own clock so they never suppress a real tab-switch report.
  const lastInputBlockRef = useRef(0);
  useEffect(() => {
    if (!examReady) return undefined;
    const shouldReport = () => {
      const now = Date.now();
      if (now - lastInputBlockRef.current < FOCUS_LOSS_COALESCE_MS) return false;
      lastInputBlockRef.current = now;
      return true;
    };
    const handleContextMenu = (e) => {
      e.preventDefault();
      if (!shouldReport()) return;
      reportViolation('RIGHT_CLICK', 'Student attempted to open the context menu.', '⚠ Right-click is disabled during the exam.');
    };
    const handleClipboard = (e) => {
      e.preventDefault();
      if (!shouldReport()) return;
      reportEvent('COPY_PASTE', `Student attempted to ${e.type} exam content.`);
    };
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('copy', handleClipboard);
    document.addEventListener('cut', handleClipboard);
    document.addEventListener('paste', handleClipboard);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('copy', handleClipboard);
      document.removeEventListener('cut', handleClipboard);
      document.removeEventListener('paste', handleClipboard);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examReady, reportEvent, reportViolation]);

  // Camera loss — only fires on a genuine ready->not-ready transition,
  // never on the initial "still connecting" state at mount.
  const cameraWasReadyRef = useRef(false);
  useEffect(() => {
    if (!examSettings.cameraRequired) return;
    if (camera.ready) {
      cameraWasReadyRef.current = true;
    } else if (cameraWasReadyRef.current) {
      cameraWasReadyRef.current = false;
      reportViolation('CAMERA_DISABLED', camera.error || 'Camera feed was lost during the exam.', '⚠ Camera access was lost.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.ready, reportViolation, examSettings.cameraRequired]);

  // Network disconnect/reconnect — the disconnect moment itself is never
  // reported to the backend (a request made while genuinely offline
  // would just fail, which is exactly the false-claim problem this
  // whole audit is about); instead the reconnect event is reported once
  // connectivity is actually confirmed back, carrying how long the gap
  // was, and "recorded" is only claimed once that call actually succeeds.
  const disconnectedAtRef = useRef(null);
  useEffect(() => {
    const handleOffline = () => {
      setIsOnline(false);
      disconnectedAtRef.current = Date.now();
      addBanner('offline', '📡 Connection lost. Attempting to reconnect — your last saved answer is safe.', null);
    };
    const handleOnline = () => {
      setIsOnline(true);
      setBanners(prev => prev.filter(b => b.type !== 'offline'));
      const downForSeconds = disconnectedAtRef.current ? Math.round((Date.now() - disconnectedAtRef.current) / 1000) : null;
      disconnectedAtRef.current = null;
      reportEvent('NETWORK_RECONNECT', downForSeconds != null ? `Connection restored after ~${downForSeconds}s offline.` : 'Connection restored.').then((confirmed) => {
        addBanner('info', confirmed
          ? '✓ Connection restored. This activity has been recorded.'
          : '✓ Connection restored.', 3500);
      });
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportEvent]);

  // Navigation guard. Two paths:
  //
  // 1. Actual page unload (tab close, refresh, typing a new URL) via
  //    beforeunload — the browser's own native confirm dialog. JS is
  //    never told whether the student confirmed or cancelled it, and
  //    refresh-to-resume is a supported recovery path (see initExam), so
  //    this path deliberately reports nothing server-side. Warning only.
  //
  // 2. The browser's Back/Forward buttons — blocked outright: the exam
  //    flow is forward-only, so there is no previous step to return to.
  useEffect(() => {
    if (!examReady) return undefined;
    const handleBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [examReady]);

  usePreventBackNavigation({
    onBlocked: () => addBanner('info', 'Going back is disabled during the examination.', 3000),
  });

  // Microphone loss — only a genuinely lost/revoked device counts. Silence
  // (useMicrophone's `muted`) is normal during an exam and is never
  // reported; it's shown as "No sound" in the monitor panel only.
  const micReady = microphone.ready;
  const micWasReadyRef = useRef(false);
  useEffect(() => {
    if (!examSettings.microphoneRequired) return;
    if (micReady) {
      micWasReadyRef.current = true;
    } else if (micWasReadyRef.current) {
      micWasReadyRef.current = false;
      reportViolation('MICROPHONE_DISABLED', microphone.error || 'Microphone became unavailable during the exam.', '⚠ A microphone issue was detected.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micReady, reportViolation, examSettings.microphoneRequired]);

  // Continuous face detection for the duration of the exam (not just
  // pre-exam System Check) — reports on genuine state transitions only,
  // with a grace period on "no face" so a brief look-away doesn't fire a
  // warning immediately.
  const faceStateRef = useRef('single');
  const noFaceTimerRef = useRef(null);
  useEffect(() => {
    if (!examSettings.faceDetectionEnabled || !camera.ready || face.modelLoading || face.modelError) return undefined;

    const state = face.faceCount === 1 ? 'single' : face.faceCount === 0 ? 'none' : 'multiple';

    if (state === 'multiple') {
      if (noFaceTimerRef.current) { clearTimeout(noFaceTimerRef.current); noFaceTimerRef.current = null; }
      if (faceStateRef.current !== 'multiple') {
        faceStateRef.current = 'multiple';
        reportViolation('MULTIPLE_FACE', `${face.faceCount} faces detected in frame.`, '⚠ Multiple faces detected.');
      }
      return undefined;
    }

    if (state === 'none') {
      if (faceStateRef.current === 'none' || noFaceTimerRef.current) return undefined;
      noFaceTimerRef.current = setTimeout(() => {
        noFaceTimerRef.current = null;
        faceStateRef.current = 'none';
        reportViolation('NO_FACE', 'No face detected in camera frame.', '⚠ No face detected.');
      }, NO_FACE_GRACE_MS);
      return undefined;
    }

    // Exactly one face — cancel any pending "no face" warning and reset.
    if (noFaceTimerRef.current) { clearTimeout(noFaceTimerRef.current); noFaceTimerRef.current = null; }
    faceStateRef.current = 'single';
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [face.faceCount, face.modelLoading, face.modelError, camera.ready, reportViolation, examSettings.faceDetectionEnabled]);

  const handleReturnToFullscreen = enterFullscreen;

  // Review is read-only: the sequence stays forward-only, so it shows
  // status without offering a way back to earlier questions.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Early submission through the same secure path as the summary page
  // (finalizeSubmission waits for any in-flight answer save, then the
  // server finalizes the attempt). advancingRef keeps Next and the timer
  // auto-advance from racing it.
  const handleSubmitExam = async () => {
    if (submitting || advancingRef.current) return;
    advancingRef.current = true;
    setSubmitting(true);
    setSubmitError('');
    try {
      await finalizeSubmission();
      navigate('/success', { replace: true });
    } catch (error) {
      if (error.data?.submittedAt || error.data?.status === 'SUBMITTED') {
        await initExam();
        navigate('/success', { replace: true });
        return;
      }
      advancingRef.current = false;
      if (error.data?.status === 'BLOCKED') {
        setSubmitConfirmOpen(false);
        setExamInitError({ message: safeUserError(error, 'The examination has been blocked.'), status: error.status, data: error.data });
        return;
      }
      if (error.status === 401) {
        setSubmitConfirmOpen(false);
        setExamInitError({
          message: 'Your session has expired. Your progress has been saved — please log in again to continue this exam.',
          status: 401,
          data: { status: 'SESSION_EXPIRED' },
        });
        return;
      }
      setSubmitError(safeUserError(error, 'Unable to submit your examination. Please check your connection and try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!student) return null;

  if (waitingForStart) {
    return <ExamWaitingRoom waitingForStart={waitingForStart} onRefresh={initExam} examName={student.examName} />;
  }

  if (examLoading) {
    return (
      <>
        <Header />
        <div className="tricolor"></div>
        <div className="page-wrap">
          <div className="card loading-state" style={{ maxWidth: '480px', margin: '60px auto', textAlign: 'center', padding: '40px' }}>
            <p>Loading your examination…</p>
          </div>
        </div>
        <Footer />
      </>
    );
  }

  if (examInitError) {
    const alreadySubmitted = examInitError.data?.status === 'SUBMITTED';
    // A blocking proctoring response carries blocked: true (no status).
    const isBlocked = examInitError.data?.status === 'BLOCKED' || examInitError.data?.blocked === true;
    const isSessionExpired = examInitError.status === 401 || examInitError.data?.status === 'SESSION_EXPIRED';
    // The server has no current System Check / rules acceptance on record
    // for this student (e.g. the browser's local gates were stale or
    // forged) — the only way forward is to redo them.
    const needsPreflight = ['PREFLIGHT_REQUIRED', 'RULES_NOT_ACCEPTED'].includes(examInitError.data?.code);
    const title = alreadySubmitted
      ? 'Exam Already Submitted'
      : isBlocked
        ? 'Examination Blocked'
        : isSessionExpired
          ? 'Session Expired'
          : needsPreflight
            ? 'System Check Required'
            : 'Unable to Load Examination';
    return (
      <>
        <Header />
        <div className="tricolor"></div>
        <div className="page-wrap">
          <div className="card error-state" style={{ maxWidth: '480px', margin: '60px auto', textAlign: 'center', padding: '40px' }}>
            <h3>{title}</h3>
            <p style={{ marginTop: '10px', marginBottom: '20px' }}>{examInitError.message}</p>
            {alreadySubmitted ? (
              <button className="btn btn-primary" onClick={() => navigate('/success')}>Continue</button>
            ) : isBlocked ? (
              <button className="btn btn-primary" onClick={() => navigate('/')}>Return to Home</button>
            ) : isSessionExpired ? (
              <button className="btn btn-primary" onClick={() => navigate('/', { replace: true })}>Log In Again</button>
            ) : needsPreflight ? (
              <button className="btn btn-primary" onClick={() => { resetSystemCheck(); navigate('/system-check', { replace: true }); }}>Go to System Check</button>
            ) : (
              <button className="btn btn-primary" onClick={() => initExam()}>Retry</button>
            )}
          </div>
        </div>
        <Footer />
      </>
    );
  }

  if (!examReady) return null;

  const totalQuestions = questionItems.length || examMeta?.totalQuestions || subjectsMeta.reduce((sum, subject) => sum + subject.questionCount, 0);
  const position = questionItems.findIndex((item) => item.id === q.id);
  const currentOverallNumber = q.sequenceNumber || (position >= 0 ? position + 1 : 1);
  const completedCount = Math.max(0, currentOverallNumber - 1);
  const progressPercent = totalQuestions ? Math.round((completedCount / totalQuestions) * 100) : 0;
  const answerDisabled = isAdvancing || timeLeft <= 0 || examTimeLeft === 0;
  const draftMessage = { idle: 'Choose one answer.', saving: 'Saving answer…', saved: 'Answer saved.',
    pending: 'Answer pending. Reconnect to save.', error: 'Answer could not be saved. Select again or retry Next.' }[draftStatus];

  // Per-subject answered counts, in the attempt's own sequence order.
  // Reads the live `answers` state, so a selection updates it at once.
  const isAnswered = (questionId) => (answers[questionId]?.sel ?? null) !== null;
  const subjectSummary = [];
  const subjectByKey = new Map();
  questionItems.forEach((item) => {
    let entry = subjectByKey.get(item.subjectKey);
    if (!entry) {
      const name = item.subjectName || subjectsMeta.find((subject) => subject.subjectKey === item.subjectKey)?.subjectName
        || (item.subjectKey === q.subjectKey ? q.subjectName : item.subjectKey);
      entry = { key: item.subjectKey, name, total: 0, answered: 0, questions: [] };
      subjectByKey.set(item.subjectKey, entry);
      subjectSummary.push(entry);
    }
    entry.total += 1;
    if (isAnswered(item.id)) entry.answered += 1;
    entry.questions.push(item);
  });
  if (!subjectSummary.length) {
    subjectsMeta.filter((subject) => subject.questionCount > 0).forEach((subject) => subjectSummary.push({
      key: subject.subjectKey, name: subject.subjectName, total: subject.questionCount,
      answered: subject.subjectKey === q.subjectKey && ans.sel !== null ? 1 : 0, questions: [],
    }));
  }
  const totalAnswered = subjectSummary.reduce((sum, subject) => sum + subject.answered, 0);
  const totalUnanswered = Math.max(0, totalQuestions - totalAnswered);
  const reviewStatus = (item) => {
    const number = item.sequenceNumber ?? (item.position != null ? item.position + 1 : 0);
    if (item.id === q.id) return isAnswered(item.id) ? 'current answered' : 'current';
    if (isAnswered(item.id)) return 'answered';
    return number < currentOverallNumber ? 'unanswered' : 'upcoming';
  };

  const finalWarningActive = examTimeLeft !== null && examTimeLeft > 0 && examTimeLeft <= FINAL_WARNING_SECONDS && !submitted;
  // Same visual-only warning for the per-question countdown; off once the
  // question's time is up or the student is already moving on.
  const questionWarningActive = timeLeft != null && timeLeft > 0 && timeLeft <= FINAL_WARNING_SECONDS
    && !submitted && !isAdvancing && examTimeLeft !== 0;

  return (
    <>
      <main className="exam-shell sequential-exam">
        {banners.map((banner) => (
          <div key={banner.id} role="alert" className={`exam-notice ${banner.type}`}>
            <span>{banner.text}</span>
            {banner.type !== 'offline' && <button type="button" aria-label="Dismiss notice" onClick={() => dismissBanner(banner.id)}>×</button>}
          </div>
        ))}
        {saveToastOn && <div className="toast-fixed" role="status">Answer saved</div>}
        {(finalWarningActive || questionWarningActive) && (
          <div className="exam-final-warning" role="status" aria-live="polite" aria-atomic="true">
            {finalWarningActive && <div>⚠ Only {examTimeLeft} second{examTimeLeft === 1 ? '' : 's'} remaining in the exam!</div>}
            {questionWarningActive && <div>⚠ Only {timeLeft} second{timeLeft === 1 ? '' : 's'} remaining for this question!</div>}
          </div>
        )}
        <header className="exam-header">
          <div className="exam-header-top">
            <div className="exam-title-block">
              <img src={logoUrl} alt="Exam logo" />
              <div><h1 className="t1">{examMeta?.examName || student.examName}</h1>
                <p className="t2">Question {currentOverallNumber} of {totalQuestions} · {q.subjectName}</p>
              </div>
            </div>
            <div className="exam-timers">
              {examTimeLeft !== null && <div className={`timer-badge ${examTimeLeft <= 60 ? 'low' : ''} ${finalWarningActive ? 'timer-final' : ''}`} aria-label="Exam time remaining">
                <small>Exam remaining</small><span>{formatTime(examTimeLeft)}</span>
              </div>}
              <div className={`timer-badge ${timeLeft <= 10 ? 'low' : ''} ${questionWarningActive ? 'timer-final' : ''}`} aria-label="Question time remaining">
                <small>Question remaining</small><span>{formatTime(timeLeft)}</span>
              </div>
            </div>
            <div className="student-mini"><b>{student.name}</b><span>{student.registrationId}</span></div>
          </div>
        </header>
        <div className="exam-body">
          {/* Status only — the sequence is forward-only, so the numbers
              are not buttons and cannot reopen a question. */}
          <aside className="subject-panel" aria-label="Answered questions by subject">
            {subjectSummary.map((subject) => (
              <div key={subject.key} className={`subject-summary-card ${subject.key === q.subjectKey ? 'active' : ''}`}>
                <div className="subject-summary-head">
                  <span className="subject-summary-name">{subject.name}</span>
                  <span className="subject-summary-count"><strong>{subject.answered}</strong> / {subject.total} Answered</span>
                </div>
                <span className="subject-summary-track" aria-hidden="true">
                  <span style={{ width: `${subject.total ? Math.round((subject.answered / subject.total) * 100) : 0}%` }} />
                </span>
                {subject.questions.length > 0 && (
                  <ul className="subject-question-grid">
                    {subject.questions.map((item) => {
                      const status = reviewStatus(item);
                      const number = item.sequenceNumber ?? item.position + 1;
                      return (
                        <li key={item.id} className={`subject-question ${status}`}
                          aria-label={`Question ${number}: ${status.includes('current') ? 'current' : status === 'upcoming' ? 'not yet reached' : status === 'answered' ? 'answered' : 'not answered'}`}>
                          {number}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </aside>
          <section className="card question-panel" aria-label="Current exam question">
            <div className="q-meta-row"><span className="q-number">Question {currentOverallNumber} of {totalQuestions}</span>
              <span className="q-marks">{q.marks} mark{q.marks === 1 ? '' : 's'}</span></div>
            <div className="question-progress">
              <div className="question-progress-top"><span>{completedCount} of {totalQuestions} completed</span><strong>{progressPercent}%</strong></div>
              <div className="question-progress-track" role="progressbar" aria-valuenow={completedCount} aria-valuemin={0} aria-valuemax={totalQuestions} aria-label="Examination progress">
                <span style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
            {q.passage && <div className="q-passage">{q.passage}</div>}
            <h2 className="q-text" id="active-question">{q.questionText}</h2>
            <div className="option-list" role="radiogroup" aria-labelledby="active-question">
              {q.options.map((option, index) => (
                <label key={index} className={`option-card ${ans.sel === index ? 'selected' : ''} ${answerDisabled ? 'disabled' : ''}`}>
                  <input type="radio" name={`question-${q.id}`} value={index} checked={ans.sel === index} disabled={answerDisabled} onChange={() => selectOption(index)} />
                  <span className="option-letter">{letters[index]}</span><span className="option-text">{option}</span>
                </label>
              ))}
            </div>
            <p className={`answer-save-status ${draftStatus}`} role="status">{draftMessage}</p>
            <div className="exam-actions-row">
              <button type="button" className="btn btn-secondary btn-sm" disabled={answerDisabled || ans.sel === null} onClick={clearResponse}>Clear answer</button>
              <div className="exam-actions-right">
                <button type="button" className="btn btn-secondary" disabled={submitting} onClick={() => setReviewOpen(true)}>Review</button>
                <button type="button" className="btn btn-success" disabled={isAdvancing || submitting || !isOnline}
                  onClick={() => { setSubmitError(''); setReviewOpen(false); setSubmitConfirmOpen(true); }}>Submit</button>
                {/* Skip only moves past an unanswered question; with an
                    answer selected, Next saves it (Clear answer first to skip). */}
                <button type="button" className="btn btn-skip" disabled={isAdvancing || submitting || !isOnline || ans.sel !== null}
                  title={ans.sel !== null ? 'Clear your answer to skip this question' : undefined} onClick={() => goNext()}>Skip</button>
                <button type="button" className="btn btn-primary" disabled={isAdvancing || submitting || !isOnline} onClick={() => goNext()}>
                  {isAdvancing ? 'Saving…' : currentOverallNumber === totalQuestions ? 'Save & Submit' : 'Next'}
                </button>
              </div>
            </div>
            <p className="exam-flow-note">Answers lock when you continue. Questions advance automatically when their time expires.</p>
          </section>

          <div className="card nav-panel exam-proctor-panel">
            <h4>Proctoring Monitor</h4>

            <div className={`camera-preview exam-camera-preview ${camera.ready ? 'face-ok' : ''}`}>
              <video
                ref={(video) => {
                  camera.videoRef.current = video;
                  // Runs on every render; re-assigning the same stream
                  // reloads the element and makes the preview flicker.
                  if (video && camera.stream && video.srcObject !== camera.stream) {
                    video.srcObject = camera.stream;
                    video.play().catch(() => {});
                  }
                }}
                autoPlay
                playsInline
                muted
                aria-label="Your live camera feed"
                className="video-preview"
                onLoadedMetadata={(event) => event.currentTarget.play().catch(() => {})}
                onCanPlay={(event) => event.currentTarget.play().catch(() => {})}
              />
              {camera.error && (
                <div className="exam-camera-error" role="alert">
                  <strong>Camera Access Error</strong>
                  <span>{camera.error}</span>
                </div>
              )}
            </div>
            {camera.error ? (
              <div className="error-state" style={{ padding: '10px', fontSize: '11.5px' }}>
                <p style={{ marginBottom: '8px' }}>{camera.error}</p>
                <button className="btn btn-primary btn-sm" onClick={camera.retry}>Retry Camera</button>
              </div>
            ) : (
              <span className={`status-badge ${camera.ready ? 'success' : 'pending'}`} style={{ marginBottom: '12px' }}>
                {camera.ready ? '✓ Camera Active' : '⏳ Connecting…'}
              </span>
            )}

            <div className="exam-mic-status">
              <div className="sysreq-check-title" style={{ fontSize: '12.5px', marginBottom: '6px' }}>
                <span className="ic">🎤</span> Microphone
              </div>
              {microphone.error ? (
                <div className="error-state" style={{ padding: '10px', fontSize: '11.5px' }}>
                  <p style={{ marginBottom: '8px' }}>{microphone.error}</p>
                  <button className="btn btn-primary btn-sm" onClick={microphone.retry}>Retry Microphone</button>
                </div>
              ) : (
                <>
                  <div className="mic-meter exam-mic-meter">
                    {Array.from({ length: 14 }).map((_, i) => {
                      const threshold = ((i + 1) / 14) * 100;
                      const active = microphone.ready && microphone.level >= threshold;
                      return (
                        <div key={i} className={`mic-meter-bar ${active ? 'active' : ''}`} style={{ height: `${6 + (i / 14) * 26}px` }} />
                      );
                    })}
                  </div>
                  <span className={`status-badge ${!examSettings.microphoneRequired ? 'success' : micReady ? 'success' : 'pending'}`}>
                        {!examSettings.microphoneRequired ? '— Not Required' : !micReady ? '⏳ Connecting…' : microphone.muted ? '✓ Active (no sound)' : '✓ Active'}
                  </span>
                </>
              )}
            </div>

            {(() => {
              const issues = [];
              if (examSettings.cameraRequired && !camera.ready) issues.push('camera');
              if (examSettings.microphoneRequired && !micReady) issues.push('microphone');
              if (settingsLoaded && examSettings.fullscreenRequired && fullscreenExited) issues.push('fullscreen');
              if (!isOnline) issues.push('network');
              const allGood = issues.length === 0;
              return (
                <div className={`status-badge ${allGood ? 'success' : 'error'}`} style={{ width: '100%', justifyContent: 'center', marginBottom: '10px' }}>
                  {allGood ? '✓ Proctoring Status: All Systems Active' : `⚠ Proctoring Status: Issue — ${issues.join(', ')}`}
                </div>
              );
            })()}

            <div className="secure-note">🔒 <span>Secure Examination Mode is active. Camera and microphone are being monitored for the entire duration of the exam.</span></div>
          </div>
        </div>
      </main>

      {settingsLoaded && examSettings.fullscreenRequired && fullscreenExited && !submitted && !violation && (
        <div className="overlay">
          <div className="modal-card" style={{ textAlign: 'center' }}>
            <div className="icon-circle danger">⚠</div>
            <h3>Full-Screen Mode Required</h3>
            <p>You have exited full-screen mode. You must return to full-screen mode to continue your examination.</p>
            <div className="modal-actions" style={{ justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={handleReturnToFullscreen}>Return to Full Screen</button>
            </div>
          </div>
        </div>
      )}

      {violation && (() => {
        const details = violationDetails(violation.eventType);
        const isFullscreenExit = violation.eventType === 'FULLSCREEN_EXIT' && fullscreenExited;
        const acknowledge = () => {
          if (isFullscreenExit) enterFullscreen();
          setViolation(null);
        };
        return (
          <div className="overlay violation-overlay" role="alertdialog" aria-modal="true" aria-labelledby="violation-title" aria-describedby="violation-reason">
            <div className="modal-card violation-card" key={violation.id}>
              <div className="violation-head">
                <div className="icon-circle danger">⚠</div>
                <span className="violation-count">Violation Recorded</span>
              </div>
              <h3 id="violation-title">{details.title}</h3>
              <p id="violation-reason">{details.reason}</p>
              <p className="violation-note">
                This violation has been recorded and will be reviewed by the exam administrator.
              </p>
              <div className="modal-actions" style={{ justifyContent: 'center' }}>
                <button type="button" className="btn btn-primary" autoFocus onClick={acknowledge}>
                  {isFullscreenExit ? 'Return to Full Screen' : 'I Understand'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {reviewOpen && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="review-title">
          <div className="modal-card review-modal">
            <h3 id="review-title">Review Your Answers</h3>
            <p>
              {totalAnswered} of {totalQuestions} answered · {totalUnanswered} unanswered.
              Questions you have moved past are locked and cannot be reopened.
            </p>
            <div className="review-legend">
              <span><i className="review-dot answered" /> Answered</span>
              <span><i className="review-dot unanswered" /> Not answered</span>
              <span><i className="review-dot current" /> Current</span>
              <span><i className="review-dot upcoming" /> Not yet reached</span>
            </div>
            <div className="review-subjects">
              {subjectSummary.map((subject) => (
                <div key={subject.key} className="review-subject">
                  <div className="review-subject-head">
                    <strong>{subject.name}</strong>
                    <span>{subject.answered} / {subject.total} Answered</span>
                  </div>
                  {subject.questions.length > 0 && (
                    <ul className="review-grid">
                      {subject.questions.map((item) => {
                        const status = reviewStatus(item);
                        const number = item.sequenceNumber ?? item.position + 1;
                        return (
                          <li key={item.id} className={`review-cell ${status}`}
                            title={`Question ${number}: ${status.includes('current') ? 'current question' : status === 'upcoming' ? 'not yet reached' : status === 'answered' ? 'answered' : 'not answered'}`}>
                            {number}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setReviewOpen(false)}>Continue Exam</button>
              <button type="button" className="btn btn-success" disabled={isAdvancing || submitting || !isOnline}
                onClick={() => { setSubmitError(''); setReviewOpen(false); setSubmitConfirmOpen(true); }}>Submit</button>
            </div>
          </div>
        </div>
      )}

      {submitConfirmOpen && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="submit-title">
          <div className="modal-card">
            <h3 id="submit-title">Submit Examination?</h3>
            <p>
              You have answered {totalAnswered} of {totalQuestions} questions.
              {totalUnanswered > 0 && ` ${totalUnanswered} question${totalUnanswered === 1 ? '' : 's'} will be submitted as unanswered.`}
              {' '}Once submitted, you cannot change any answer or return to the exam.
            </p>
            {submitError && <p role="alert" style={{ color: 'var(--danger)', fontSize: '13px', marginTop: '-12px' }}>{submitError}</p>}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" disabled={submitting} onClick={() => setSubmitConfirmOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-success" disabled={submitting || !isOnline} onClick={handleSubmitExam}>
                {submitting ? 'Submitting…' : 'Confirm Submission'}
              </button>
            </div>
          </div>
        </div>
      )}

      <Footer secureMode />
    </>
  );
};

export default ExamPage;

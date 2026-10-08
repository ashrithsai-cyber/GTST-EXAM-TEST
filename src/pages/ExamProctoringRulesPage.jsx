import React, { useState, useRef, useContext, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AuthContext } from "../context/AuthContext";
import { SystemCheckContext } from "../context/SystemCheckContext";
import Header from "../components/common/Header";
import Footer from "../components/common/Footer";
import { recordPresence, fetchMockVideo, fetchProctoringRules, acceptProctoringRules } from "../services/examService";
import { usePreventBackNavigation } from "../hooks/usePreventBackNavigation";

// Bundled fallback rules — shown only until the admin-managed rules
// (Admin > Proctoring Rules, GET /api/exam/rules) resolve, or if that
// fetch returns nothing (nothing configured yet / rules table not
// migrated). Kept identical to the original hardcoded list so the page
// looks the same before the admin ever touches it.
const FALLBACK_RULES = [
  "Log in and complete all system checks only during the permitted exam window.",
  "Keep your camera and microphone switched on and unmuted for the entire duration of the exam.",
  "Remain visible within the camera frame at all times and do not leave your seat.",
  "Do not use mobile phones, books, notes, or any other external assistance.",
  "Do not communicate with any other person during the examination.",
  "Do not switch tabs, minimize the window, or exit fullscreen mode once the exam has started.",
  "Copying, screenshotting, recording or sharing exam content in any form is strictly prohibited.",
  "Report any technical issue immediately using the Help / Support option — do not close the browser.",
  "The exam will be automatically submitted once the time limit expires; no extensions will be granted.",
  "Violation of any of the above rules may lead to disqualification and cancellation of your candidature.",
];

const ExamProctoringRulesPage = () => {
  const navigate = useNavigate();
  usePreventBackNavigation();
  const { student, token } = useContext(AuthContext);
  const { completeProctoringRules, resetSystemCheck, examSettings, settingsLoaded } = useContext(SystemCheckContext);

  const [fullscreenExited, setFullscreenExited] = useState(false);
  const videoRef = useRef(null);
  const [videoSrc, setVideoSrc] = useState(null);
  const [videoLoading, setVideoLoading] = useState(true);
  const [videoError, setVideoError] = useState(false);
  const [videoCompleted, setVideoCompleted] = useState(false);
  const maxWatchedTimeRef = useRef(0);

  // The rules students must acknowledge — admin-managed (Admin >
  // Proctoring Rules). Starts as the bundled fallback and is replaced by
  // whatever the admin has marked active, in their order, once the fetch
  // resolves. A failed/empty fetch keeps the bundled list, so the page is
  // never left with no rules.
  const [rules, setRules] = useState(FALLBACK_RULES);

  useEffect(() => {
    if (!student) navigate("/");
  }, [student, navigate]);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    setVideoLoading(true);
    setVideoError(false);
    fetchMockVideo(token)
      .then((res) => {
        if (cancelled) return;
        setVideoSrc(res?.video?.url || null);
      })
      .catch(() => {
        if (!cancelled) {
          setVideoSrc(null);
          setVideoError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setVideoLoading(false);
      });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetchProctoringRules(token)
      .then((res) => {
        if (cancelled) return;
        const list = (res?.rules || []).map((r) => r.text).filter(Boolean);
        if (list.length) setRules(list);
      })
      .catch(() => {
        // Keep the bundled fallback rules — never strand the student on a
        // page with no rules over a transient fetch failure.
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Display-only ping for the admin Live Students page — never blocks or
  // delays anything on this page if it fails.
  useEffect(() => {
    if (!student || !token) return;
    recordPresence(token, "RULES").catch(() => {});
    const interval = setInterval(() => recordPresence(token, "RULES").catch(() => {}), 10000);
    return () => clearInterval(interval);
  }, [student, token]);

  useEffect(() => {
    if (!settingsLoaded || !examSettings.fullscreenRequired) return undefined;
    document.documentElement.requestFullscreen?.().catch(() => {});
    return undefined;
  }, [examSettings.fullscreenRequired, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded || !examSettings.fullscreenRequired) {
      setFullscreenExited(false);
      return undefined;
    }
    const handleFullscreenChange = () => {
      setFullscreenExited(!document.fullscreenElement);
    };
    handleFullscreenChange();
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [examSettings.fullscreenRequired, settingsLoaded]);

  const handleReturnToFullscreen = () => {
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

  const handleVideoTimeUpdate = (event) => {
    const video = event.currentTarget;
    maxWatchedTimeRef.current = Math.max(maxWatchedTimeRef.current, video.currentTime);
  };

  const handleVideoSeeking = (event) => {
    const video = event.currentTarget;
    if (video.currentTime > maxWatchedTimeRef.current + 0.5) {
      video.currentTime = maxWatchedTimeRef.current;
    }
  };

  const handleVideoEnded = () => {
    setVideoCompleted(true);
  };

  // The video gate only applies when the admin requires it AND a video
  // actually exists and plays. A missing or broken video must never lock
  // a student out of the exam.
  const videoGateActive = examSettings.videoRequired && Boolean(videoSrc) && !videoError;
  const canContinue = !videoLoading && (!videoGateActive || videoCompleted);

  // Rules acceptance is recorded server-side — the exam can't be started
  // without it — so only continue once the backend has confirmed it.
  const [continuePending, setContinuePending] = useState(false);
  const [continueError, setContinueError] = useState("");
  const handleContinue = async () => {
    if (!canContinue || continuePending) return;
    setContinuePending(true);
    setContinueError("");
    try {
      await acceptProctoringRules(token);
      completeProctoringRules();
      navigate("/exam", { replace: true });
    } catch (error) {
      if (error.data?.code === "PREFLIGHT_REQUIRED") {
        // The server has no (current) System Check on record for this
        // student — send them back through it.
        resetSystemCheck();
        navigate("/system-check", { replace: true });
        return;
      }
      setContinueError(error.message || "Unable to record your acceptance. Please try again.");
      setContinuePending(false);
    }
  };

  if (!student) return null;

  return (
    <>
      <Header />
      <div className="tricolor"></div>
      <div className="page-wrap">
        <div className="page-head">
          <h1>Exam Proctoring &amp; Rules</h1>
          <p>Review the rules carefully and confirm before you continue.</p>
        </div>

        <div style={{ maxWidth: "820px", margin: "0 auto" }}>
          {videoSrc && (
            <div className="card sysreq-card" style={{ marginBottom: "18px" }}>
              <h2 style={{ marginBottom: "4px" }}>Exam Process Video</h2>
              <p className="sysreq-hint" style={{ marginBottom: "12px" }}>
                Watch the video provided by the administrator before continuing.
              </p>
              <div className="proctoring-video-wrap">
                <video
                  ref={videoRef}
                  src={videoSrc}
                  autoPlay
                  muted
                  playsInline
                  preload="metadata"
                  className="proctoring-video"
                  controls={false}
                  controlsList="nodownload noplaybackrate nofullscreen"
                  disablePictureInPicture
                  onTimeUpdate={handleVideoTimeUpdate}
                  onSeeking={handleVideoSeeking}
                  onPause={(event) => {
                    if (!event.currentTarget.ended) event.currentTarget.play().catch(() => {});
                  }}
                  onLoadedData={(event) => event.currentTarget.play().catch(() => {})}
                  onEnded={handleVideoEnded}
                  onError={() => setVideoError(true)}
                />
              </div>
            </div>
          )}
          {videoLoading && <p className="sysreq-hint">Loading administrator video…</p>}
          {!videoLoading && videoError && (
            <p className="error-state">The instruction video could not be loaded. Please read the rules below carefully before continuing.</p>
          )}
          <div className="card sysreq-card">
            <h2 style={{ marginBottom: "4px" }}>Rules &amp; Regulations</h2>
            <p className="sysreq-hint" style={{ marginBottom: "4px" }}>
              Please read all the rules carefully before proceeding.
            </p>
            <ol className="instructions-list">
              {rules.map((rule, i) => (
                <li key={i}>
                  <span className="num">{i + 1}</span>
                  <span>{rule}</span>
                </li>
              ))}
            </ol>

            {videoGateActive && !videoCompleted && (
              <p className="sysreq-hint">Watch the complete video to continue. Skipping is disabled.</p>
            )}
          </div>

          <div style={{ marginTop: "18px" }}>
            <button
              className="btn btn-success btn-block btn-lg"
              disabled={!canContinue || continuePending}
              onClick={handleContinue}
            >
              {videoLoading
                ? "Loading…"
                : continuePending
                  ? "Confirming…"
                  : canContinue
                    ? "Continue to Exam →"
                    : "Watch the Video to Continue"}
            </button>
            {continueError && (
              <p className="error-state" role="alert" style={{ marginTop: "10px" }}>{continueError}</p>
            )}
          </div>
        </div>
      </div>

      {settingsLoaded && examSettings.fullscreenRequired && fullscreenExited && (
        <div className="overlay">
          <div className="modal-card" style={{ textAlign: "center" }}>
            <div className="icon-circle danger">⚠</div>
            <h3>Full-Screen Mode Required</h3>
            <p>You have exited full-screen mode. You must return to full-screen mode to continue.</p>
            <div className="modal-actions" style={{ justifyContent: "center" }}>
              <button className="btn btn-primary" onClick={handleReturnToFullscreen}>Return to Full Screen</button>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </>
  );
};

export default ExamProctoringRulesPage;

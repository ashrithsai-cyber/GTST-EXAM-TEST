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

// Seconds -> "m:ss" (or "h:mm:ss"); "--:--" until the length is known.
const formatVideoTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

const ExamProctoringRulesPage = () => {
  const navigate = useNavigate();
  usePreventBackNavigation();
  const { student, token } = useContext(AuthContext);
  const { completeProctoringRules, resetSystemCheck, examSettings, settingsLoaded } = useContext(SystemCheckContext);


  const videoRef = useRef(null);
  const [videoSrc, setVideoSrc] = useState(null);
  const [videoLoading, setVideoLoading] = useState(true);
  const [videoError, setVideoError] = useState('');
  const [videoRetry, setVideoRetry] = useState(0);
  const [videoCompleted, setVideoCompleted] = useState(false);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [needsPlayClick, setNeedsPlayClick] = useState(true);
  const maxWatchedTimeRef = useRef(0);
  const bufferingTimer = useRef(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const hasToken = Boolean(token);
  const registrationId = student?.registrationId;

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
    if (!hasToken) return undefined;
    let cancelled = false;
    setVideoLoading(true);
    setVideoError('');
    setVideoCompleted(false);
    setNeedsPlayClick(true);
    setVideoTime(0);
    setVideoDuration(0);
    maxWatchedTimeRef.current = 0;
    fetchMockVideo(tokenRef.current)
      .then((res) => {
        if (cancelled) return;
        setVideoSrc(res?.video?.url || null);
      })
      .catch(() => {
        if (!cancelled) {
          setVideoSrc(null);
          setVideoError('Unable to load the instruction video. Check your connection and retry.');
        }
      })
      .finally(() => {
        if (!cancelled) setVideoLoading(false);
      });
    return () => { cancelled = true; };
  }, [hasToken, registrationId, videoRetry]);

  useEffect(() => () => clearTimeout(bufferingTimer.current), []);
  const clearBuffering = () => clearTimeout(bufferingTimer.current);
  const handleBuffering = () => {
    clearBuffering();
    bufferingTimer.current = setTimeout(() => {
      setVideoError('The video stopped loading. Check your connection and retry the video.');
      setVideoCompleted(false);
    }, 20000);
  };

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

  // Plays with sound. Browsers may refuse unmuted autoplay when the page
  // has had no user interaction yet (e.g. after a reload) — then a
  // "Play with sound" button is shown and the student's click starts it.
  const playVideo = () => {
    const video = videoRef.current;
    if (!video || video.ended) return;
    video.muted = false;
    video.play()
      .then(() => setNeedsPlayClick(false))
      .catch((error) => {
        setNeedsPlayClick(true);
        if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') {
          setVideoError('This browser could not play the video. Retry in a supported browser, or contact the administrator for a compatible MP4 (H.264/AAC) video.');
        }
      });
  };

  const handleVideoTimeUpdate = (event) => {
    const video = event.currentTarget;
    // Only normal playback advances the watched mark — never a seek.
    if (!video.seeking) {
      maxWatchedTimeRef.current = Math.max(maxWatchedTimeRef.current, video.currentTime);
    }
    setVideoTime(video.currentTime);
  };

  const handleVideoSeeking = (event) => {
    const video = event.currentTarget;
    if (video.currentTime > maxWatchedTimeRef.current + 0.5) {
      video.currentTime = maxWatchedTimeRef.current;
    }
  };

  // Fast-forwarding via playback speed counts as skipping too.
  const handleVideoRateChange = (event) => {
    const video = event.currentTarget;
    if (video.playbackRate !== 1) video.playbackRate = 1;
  };

  const handleVideoEnded = (event) => {
    const video = event.currentTarget;
    // Only a video actually played through to the end counts as watched;
    // an "ended" reached by jumping ahead sends it back.
    if (Number.isFinite(video.duration) && maxWatchedTimeRef.current < video.duration - 2) {
      video.currentTime = maxWatchedTimeRef.current;
      playVideo();
      return;
    }
    maxWatchedTimeRef.current = video.duration;
    setVideoTime(video.duration);
    setVideoCompleted(true);
    clearBuffering();
  };

  const videoGateActive = examSettings.videoRequired;
  const canContinue = settingsLoaded && !videoLoading && (!videoGateActive || (Boolean(videoSrc) && !videoError && videoCompleted));

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
        <div className={`page-head ${videoSrc || videoLoading || videoError ? "rules-page-head" : ""}`}>
          <h1>Exam Proctoring &amp; Rules</h1>
          <p>Review the rules carefully and confirm before you continue.</p>
        </div>

        {/* Video on the left, rules on the right; stacked (video first) on
            narrow screens. Without any video the rules use the full width. */}
        <div className={`rules-layout ${videoSrc || videoLoading || videoError || videoGateActive ? "" : "rules-layout-single"}`}>
          {(videoSrc || videoLoading || videoError || videoGateActive) && (
          <div className="rules-video-col">
          {videoSrc && (
            <div className="card sysreq-card">
              <h2 style={{ marginBottom: "4px" }}>Exam Process Video</h2>
              <p className="sysreq-hint" style={{ marginBottom: "12px" }}>
                Watch the video provided by the administrator before continuing.
              </p>
              <div className="proctoring-video-wrap">
                <video
                  key={videoRetry}
                  ref={videoRef}
                  src={videoSrc}
                  playsInline
                  preload="metadata"
                  className="proctoring-video"
                  controls
                  controlsList="nodownload noplaybackrate nofullscreen"
                  disablePictureInPicture
                  onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration)}
                  onDurationChange={(event) => setVideoDuration(event.currentTarget.duration)}
                  onTimeUpdate={handleVideoTimeUpdate}
                  onSeeking={handleVideoSeeking}
                  onRateChange={handleVideoRateChange}
                  onPause={() => { setNeedsPlayClick(true); clearBuffering(); }}
                  onPlaying={() => { setNeedsPlayClick(false); clearBuffering(); }}
                  onWaiting={handleBuffering}
                  onStalled={handleBuffering}
                  onLoadedData={clearBuffering}
                  onEnded={handleVideoEnded}
                  onError={() => { clearBuffering(); setVideoCompleted(false); setVideoError('This video could not be played. Retry, open the exam in a supported browser, or contact the administrator for a compatible MP4 (H.264/AAC) video.'); }}
                />
                {needsPlayClick && !videoCompleted && !videoError && (
                  <button type="button" className="proctoring-video-play" onClick={playVideo}>
                    <span className="play-ic" aria-hidden="true">▶</span>
                    {videoTime > 0 ? "Resume video with sound" : "Play video with sound"}
                  </button>
                )}
              </div>
              <div
                className="proctoring-progress-bar"
                role="progressbar"
                aria-label="Video progress"
                aria-valuemin={0}
                aria-valuemax={Number.isFinite(videoDuration) ? Math.round(videoDuration) : undefined}
                aria-valuenow={Math.round(videoTime)}
                aria-valuetext={`${formatVideoTime(videoTime)} of ${formatVideoTime(videoDuration)}`}
              >
                <div
                  className="proctoring-progress-fill"
                  style={{
                    width: `${Number.isFinite(videoDuration) && videoDuration > 0
                      ? Math.min(100, (videoTime / videoDuration) * 100)
                      : 0}%`,
                  }}
                />
              </div>
              <div className="proctoring-video-time">
                <span>
                  <strong>{formatVideoTime(videoTime)}</strong> / {formatVideoTime(videoDuration)}
                </span>
                <span>
                  {videoCompleted
                    ? "Video completed"
                    : Number.isFinite(videoDuration) && videoDuration > 0
                      ? `${formatVideoTime(videoDuration - videoTime)} remaining · Skipping ahead is disabled`
                      : "Skipping ahead is disabled"}
                </span>
              </div>
            </div>
          )}
          {videoLoading && <p className="sysreq-hint">Loading administrator video…</p>}
          {!videoLoading && (videoError || (videoGateActive && !videoSrc)) && (
            <div className="error-state" role="alert">
              <p>{videoError || 'The required instruction video is unavailable. Contact the administrator or retry.'}</p>
              <button className="btn btn-primary" onClick={() => {
                clearBuffering();
                setVideoSrc(null);
                setVideoError('');
                setVideoCompleted(false);
                setVideoRetry(count => count + 1);
              }}>Retry Video</button>
            </div>
          )}
          </div>
          )}
          <div className="card sysreq-card rules-text-col">
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

          <div className="rules-actions">
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

      <Footer />
    </>
  );
};

export default ExamProctoringRulesPage;

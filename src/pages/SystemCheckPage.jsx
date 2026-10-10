import React, { useState, useEffect, useContext, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { AuthContext } from "../context/AuthContext";
import { SystemCheckContext } from "../context/SystemCheckContext";
import Header from "../components/common/Header";
import Footer from "../components/common/Footer";
import { useMicrophone } from "../hooks/useMicrophone";
import { useFullscreen } from "../hooks/useFullscreen";
import { useFaceDetection } from "../hooks/useFaceDetection";
import { recordPresence, uploadSystemCheckScreenshot, submitSystemCheck } from "../services/examService";
import { usePreventBackNavigation } from "../hooks/usePreventBackNavigation";

// Check-in photo: taken from the shared camera stream (the <video> that
// LiveCameraPreview binds to camera.videoRef) only after the student
// clicks "I Agree", following a visible 3-second countdown. Every step —
// frame readiness, encoding, decoding the result back, and the upload —
// must succeed before the student can continue; nothing is captured or
// accepted silently in the background.
const COUNTDOWN_SECONDS = 3;
const CAMERA_READY_TIMEOUT_MS = 8000;
const FRAME_READY_TIMEOUT_MS = 3000;
const CAMERA_POLL_MS = 100;
// A camera that has only just started can hand over a few pure-black
// frames before real image data arrives.
const BLANK_FRAME_RETRIES = 5;
const BLANK_FRAME_RETRY_MS = 200;
const PHOTO_UPLOAD_RETRY_DELAYS_MS = [1000, 2000];
const CAPTURE_FAILED_MESSAGE = "Photo capture failed. Please try again.";

const CAPTURE_BUSY_PHASES = new Set(["preparing", "countdown", "capturing", "uploading"]);

class PhotoCaptureError extends Error {
  constructor(userMessage, cause) {
    super(userMessage);
    this.userMessage = userMessage;
    this.cause = cause;
  }
}

function getLiveVideoTrack(video) {
  const stream = video?.srcObject;
  if (!stream || typeof stream.getVideoTracks !== "function") return null;
  return stream.getVideoTracks().find((track) => track.readyState === "live" && track.enabled && !track.muted) || null;
}

function isVideoFrameReady(video) {
  return Boolean(
    video &&
      getLiveVideoTrack(video) &&
      !video.paused &&
      !video.ended &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
  );
}

// Samples the frame for any non-black pixel — a sparse sample is plenty
// to tell a real image from an all-black warm-up frame.
function isBlankFrame(ctx, width, height) {
  try {
    const { data } = ctx.getImageData(0, 0, width, height);
    const step = 4 * 16;
    for (let i = 0; i < data.length; i += step) {
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma > 12) return false;
    }
    return true;
  } catch {
    // Pixel readback unavailable — don't block on a check we can't run.
    return false;
  }
}

// Resolves with a JPEG blob of the current frame, or null if the frame
// was blank (caller retries).
function captureVideoFrame(video) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Canvas 2D context unavailable"));
  ctx.drawImage(video, 0, 0, width, height);
  if (isBlankFrame(ctx, width, height)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode photo"))),
      "image/jpeg",
      0.9
    );
  });
}

// Proves the blob is a real, decodable image with valid dimensions.
// Resolves with { url, width, height }; url is an object URL for the
// preview (caller must revoke it).
function loadImageFromBlob(blob) {
  if (!blob || blob.size <= 0 || !blob.type.startsWith("image/")) {
    return Promise.reject(new Error("Captured photo is empty or not an image"));
  }
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({ url, width: img.naturalWidth, height: img.naturalHeight });
      } else {
        URL.revokeObjectURL(url);
        reject(new Error("Captured photo has invalid dimensions"));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Captured photo could not be decoded"));
    };
    img.src = url;
  });
}

const NO_FACE_GRACE_MS = 1200;
<<<<<<< HEAD
const MULTIPLE_FACE_REPEAT_MS = 3000;
=======
>>>>>>> origin/main
const MIC_METER_BARS = 24;

const StatusBadge = ({ state, passText = "Passed", failText = "Failed" }) => {
  if (state === "skip") {
    return <span className="status-badge success">— Not Required</span>;
  }
  if (state === "checking") {
    return <span className="status-badge pending">⏳ Checking…</span>;
  }
  if (state === "waiting") {
    return <span className="status-badge pending">Speak to Test</span>;
  }
  if (state === "pass") {
    return <span className="status-badge success">✓ {passText}</span>;
  }
  return <span className="status-badge error">✕ {failText}</span>;
};

const SystemCheckPage = () => {
  const navigate = useNavigate();
  usePreventBackNavigation();
  const { student, token } = useContext(AuthContext);
  const {
    setCameraReady,
    setMicrophoneReady,
    setFullscreenReady,
    setFaceCount,
    termsAccepted,
    setTermsAccepted,
    completeSystemCheck,
    examSettings,
    settingsLoaded,
    camera,
  } = useContext(SystemCheckContext);

  const microphone = useMicrophone({ enabled: Boolean(student && settingsLoaded && examSettings.microphoneRequired) });
  const fullscreen = useFullscreen();
  const face = useFaceDetection(camera.videoRef, camera.ready && examSettings.faceDetectionEnabled);

  const [popupError, setPopupError] = useState(null); // null | 'none' | 'multiple'
  const [popupDismissed, setPopupDismissed] = useState(false);
  const noFaceTimerRef = useRef(null);

  // Photo gate: starts unsatisfied and is flipped to true only once the
  // check-in photo has been captured, validated and saved (or turns out
  // not to apply, or is confirmed already saved). "Start Exam" stays
  // disabled until this is true.
  const [screenshotGateSatisfied, setScreenshotGateSatisfied] = useState(false);
  const screenshotStateRef = useRef("idle"); // 'idle' | 'done'
  // 'idle' | 'preparing' | 'countdown' | 'capturing' | 'uploading' | 'done' | 'failed'
  const [capturePhase, setCapturePhase] = useState("idle");
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [captureError, setCaptureError] = useState("");
  const [capturedPhotoUrl, setCapturedPhotoUrl] = useState(null);
  // Synchronous guard against double clicks / re-renders starting a
  // second capture before React has re-rendered the disabled button.
  const captureRunningRef = useRef(false);
  // Bumped on unmount so an in-flight capture stops touching state.
  const captureRunIdRef = useRef(0);
  const mountedRef = useRef(false);
  const captureTimersRef = useRef(new Set());
  const capturedPhotoUrlRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    const timers = captureTimersRef.current;
    return () => {
      mountedRef.current = false;
      captureRunIdRef.current += 1;
      captureRunningRef.current = false;
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
      if (capturedPhotoUrlRef.current) {
        URL.revokeObjectURL(capturedPhotoUrlRef.current);
        capturedPhotoUrlRef.current = null;
      }
    };
  }, []);

  // Tracked timeout so unmount can cancel it. A cancelled wait never
  // resolves, which simply abandons the capture run that awaited it.
  const captureWait = useCallback(
    (ms) =>
      new Promise((resolve) => {
        const id = setTimeout(() => {
          captureTimersRef.current.delete(id);
          resolve();
        }, ms);
        captureTimersRef.current.add(id);
      }),
    []
  );

  const replaceCapturedPhoto = (url) => {
    if (capturedPhotoUrlRef.current) URL.revokeObjectURL(capturedPhotoUrlRef.current);
    capturedPhotoUrlRef.current = url;
    setCapturedPhotoUrl(url);
  };

  useEffect(() => {
    if (!student) navigate("/");
  }, [student, navigate]);

  // Terms are accepted only by this visit's successful photo capture, so
  // a stale acceptance from an earlier visit can't lock the Agree button.
  useEffect(() => {
    setTermsAccepted(false);
  }, [setTermsAccepted]);

  // Display-only ping for the admin Live Students page — never blocks or
  // delays anything on this page if it fails.
  useEffect(() => {
    if (!student || !token) return;
    recordPresence(token, "SYSTEM_CHECK").catch(() => {});
    const interval = setInterval(() => recordPresence(token, "SYSTEM_CHECK").catch(() => {}), 10000);
    return () => clearInterval(interval);
  }, [student, token]);

  useEffect(() => {
    setCameraReady(camera.ready);
  }, [camera.ready, setCameraReady]);

  useEffect(() => {
    setMicrophoneReady(microphone.ready && microphone.inputDetected);
  }, [microphone.ready, microphone.inputDetected, setMicrophoneReady]);

  useEffect(() => {
    setFullscreenReady(fullscreen.isFullscreen);
  }, [fullscreen.isFullscreen, setFullscreenReady]);

  useEffect(() => {
    setFaceCount(face.faceCount);
  }, [face.faceCount, setFaceCount]);

<<<<<<< HEAD
  // face.faceState is smoothed over several frames (utils/faceTracker.js),
  // so a single flickering frame never changes it.
  const faceCheckActive = camera.ready && !face.modelLoading && !face.modelError;
  const faceState = faceCheckActive ? face.faceState : "checking";
=======
  const faceCheckActive = camera.ready && !face.modelLoading && !face.modelError;
  const faceState = !faceCheckActive
    ? "checking"
    : face.faceCount === 1
      ? "single"
      : face.faceCount === 0
        ? "none"
        : "multiple";
>>>>>>> origin/main

  useEffect(() => {
    if (noFaceTimerRef.current) {
      clearTimeout(noFaceTimerRef.current);
      noFaceTimerRef.current = null;
    }

    if (faceState === "multiple") {
      setPopupError("multiple");
      setPopupDismissed(false);
      return undefined;
    }

    if (faceState === "none") {
      noFaceTimerRef.current = setTimeout(() => {
        setPopupError("none");
        setPopupDismissed(false);
      }, NO_FACE_GRACE_MS);
      return () => clearTimeout(noFaceTimerRef.current);
    }

    setPopupError(null);
    return undefined;
  }, [faceState]);

<<<<<<< HEAD
  // Closing the multiple-face warning doesn't silence it: if someone else
  // is still in frame a moment later, it is shown again.
  useEffect(() => {
    if (!popupDismissed || popupError !== "multiple") return undefined;
    const timer = setTimeout(() => setPopupDismissed(false), MULTIPLE_FACE_REPEAT_MS);
    return () => clearTimeout(timer);
  }, [popupDismissed, popupError]);

=======
>>>>>>> origin/main
  const faceReady = faceState === "single";
  const micReady = microphone.ready && microphone.inputDetected;

  // Only checks the admin has actually required are counted toward
  // "ready to start" — a disabled check can never block progress, and
  // never needs to individually pass. See Admin > Exam Settings.
  const fullscreenRequired = settingsLoaded && examSettings.fullscreenRequired;
  const requiredChecks = [
    { required: examSettings.cameraRequired, ok: camera.ready },
    { required: examSettings.microphoneRequired, ok: micReady },
    { required: fullscreenRequired, ok: fullscreen.isFullscreen },
    { required: examSettings.faceDetectionEnabled, ok: faceReady },
  ].filter((c) => c.required);

  const allChecksPass = settingsLoaded && requiredChecks.every((c) => c.ok);
  const passedCount = requiredChecks.filter((c) => c.ok).length;
  const totalRequiredChecks = requiredChecks.length;
  const canProceed = allChecksPass && termsAccepted && screenshotGateSatisfied;
  const captureBusy = CAPTURE_BUSY_PHASES.has(capturePhase);

  // Polls until camera.videoRef's <video> is actually rendering frames
  // from a live track, nudging playback if the browser left it paused.
  const waitForCameraFrame = async (timeoutMs, isStale) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isStale()) return null;
      const video = camera.videoRef.current;
      if (isVideoFrameReady(video)) return video;
      if (video?.srcObject && video.paused) video.play().catch(() => {});
      await captureWait(CAMERA_POLL_MS);
    }
    throw new PhotoCaptureError(camera.error ? `Camera is not ready. ${camera.error}` : "Camera is not ready. Please try again.");
  };

  const uploadCheckInPhoto = async (blob, isStale) => {
    for (let attempt = 0; ; attempt++) {
      let result;
      try {
        result = await uploadSystemCheckScreenshot(token, blob);
      } catch (error) {
        const delay = PHOTO_UPLOAD_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          throw new PhotoCaptureError("Photo could not be saved. Please try again.", error);
        }
        await captureWait(delay);
        if (isStale()) return null;
        continue;
      }
      // captured:true is only sent after the file is in Storage and its
      // row is written. applicable:false means nothing was stored because
      // no active exam is linked to this student's class — not a success,
      // and not something a retry can fix.
      if (result?.success && result.captured === true) return result;
      throw new PhotoCaptureError(
        result?.applicable === false
          ? "Photo could not be saved because no active exam is linked to your class. Please contact the exam administrator."
          : "Photo could not be saved. Please try again."
      );
    }
  };

  // Camera ready → 3-2-1 countdown → capture → validate → upload →
  // confirm. Only a fully successful run accepts the terms and opens the
  // "Start Exam" gate. One async sequence drives every step; the
  // synchronous captureRunningRef guard means double clicks and
  // re-renders can't start a second run.
  const runPhotoCapture = async () => {
    if (captureRunningRef.current) {
      return;
    }
    if (!token) {
      return;
    }
    captureRunningRef.current = true;
    const runId = ++captureRunIdRef.current;
    const isStale = () => !mountedRef.current || captureRunIdRef.current !== runId;

    screenshotStateRef.current = "idle";
    setScreenshotGateSatisfied(false);
    setCaptureError("");
    replaceCapturedPhoto(null);
    setCapturePhase("preparing");

    try {
      if (!(await waitForCameraFrame(CAMERA_READY_TIMEOUT_MS, isStale))) return;

      setCapturePhase("countdown");
      for (let n = COUNTDOWN_SECONDS; n > 0; n--) {
        setCountdown(n);
        await captureWait(1000);
        if (isStale()) return;
      }

      setCapturePhase("capturing");
      let blob = null;
      for (let attempt = 0; attempt <= BLANK_FRAME_RETRIES && !blob; attempt++) {
        const video = await waitForCameraFrame(FRAME_READY_TIMEOUT_MS, isStale);
        if (!video) return;
        try {
          blob = await captureVideoFrame(video);
        } catch (error) {
          throw new PhotoCaptureError("Could not capture a valid camera frame. Please try again.", error);
        }
        if (!blob) await captureWait(BLANK_FRAME_RETRY_MS);
        if (isStale()) return;
      }
      if (!blob) {
        throw new PhotoCaptureError("Could not capture a valid camera frame. Please make sure nothing is covering your camera and try again.");
      }

      let photo;
      try {
        photo = await loadImageFromBlob(blob);
      } catch (error) {
        throw new PhotoCaptureError("Could not capture a valid camera frame. Please try again.", error);
      }
      if (isStale()) {
        URL.revokeObjectURL(photo.url);
        return;
      }
      replaceCapturedPhoto(photo.url);

      setCapturePhase("uploading");
      const result = await uploadCheckInPhoto(blob, isStale);
      if (!result || isStale()) return;

      screenshotStateRef.current = "done";
      setScreenshotGateSatisfied(true);
      setTermsAccepted(true);
      setCapturePhase("done");
    } catch (error) {
      if (isStale()) return;
      replaceCapturedPhoto(null);
      setCaptureError(error instanceof PhotoCaptureError ? error.userMessage : "Could not capture a valid camera frame. Please try again.");
      setCapturePhase("failed");
    } finally {
      if (captureRunIdRef.current === runId) captureRunningRef.current = false;
    }
  };

  const handleAcceptTerms = () => {
    if (!allChecksPass || termsAccepted || captureRunningRef.current) {
      return;
    }
    // Photo capture is independently controlled from the camera requirement.
    if (!examSettings.photoCaptureEnabled) {
      screenshotStateRef.current = "done";
      setScreenshotGateSatisfied(true);
      setTermsAccepted(true);
      return;
    }
    runPhotoCapture();
  };

  // The backend keeps its own record of this System Check — starting the
  // exam is refused server-side without it — so only move on once that
  // call has actually succeeded.
  const [startPending, setStartPending] = useState(false);
  const [startError, setStartError] = useState("");
  const handleStartExam = async () => {
    if (!canProceed || screenshotStateRef.current !== "done" || startPending) return;
    setStartPending(true);
    setStartError("");
    try {
      await submitSystemCheck(token, {
        camera: camera.ready,
        microphone: micReady,
        fullscreen: fullscreen.isFullscreen,
        face: faceReady,
      });
      completeSystemCheck();
      navigate("/proctoring-rules", { replace: true });
    } catch (error) {
      if (!mountedRef.current) return;
      if (error.data?.code === "CHECK_IN_PHOTO_REQUIRED") {
        // The saved photo is missing or stale — make the student retake it.
        screenshotStateRef.current = "idle";
        setScreenshotGateSatisfied(false);
        setTermsAccepted(false);
        replaceCapturedPhoto(null);
        setCapturePhase("idle");
      }
      setStartError(error.message || "Unable to confirm your system check. Please try again.");
    } finally {
      if (mountedRef.current) setStartPending(false);
    }
  };

  const cameraState = !settingsLoaded || camera.loading ? "checking" : !examSettings.cameraRequired ? "skip" : camera.ready ? "pass" : "fail";
  const micState = !settingsLoaded
    ? "checking"
    : !examSettings.microphoneRequired
      ? "skip"
      : microphone.loading
        ? "checking"
        : micReady
          ? "pass"
          : microphone.ready || microphone.needsActivation
            ? "waiting"
            : "fail";
  const micFailText = microphone.error ? "Unavailable" : "No Audio Input";
  const fullscreenState = !fullscreenRequired ? "skip" : fullscreen.isFullscreen ? "pass" : "fail";
  // Face detection runs on the camera feed — when the camera has failed it
  // can never finish, so report it as failed instead of "Checking…".
  const faceBlockedByCamera = cameraState === "fail";
  const faceRowState = !examSettings.faceDetectionEnabled
    ? "skip"
    : faceBlockedByCamera || face.modelError ? "fail" : faceState === "checking" ? "checking" : faceReady ? "pass" : "fail";
  const faceFailText = faceBlockedByCamera
    ? "Camera Unavailable"
    : face.modelError
      ? "Unavailable"
      : faceState === "multiple" ? "Multiple Faces" : "No Face Detected";

  const showPopup = Boolean(popupError) && !popupDismissed;
  const popupContent =
    popupError === "multiple"
      ? {
          title: "Multiple Faces Detected",
          message:
            "Multiple faces detected. Please ensure only one person is visible in the camera.",
        }
      : {
          title: "No Face Detected",
          message:
            "No face detected. Please position yourself in front of the camera.",
        };

  if (!student) return null;

  return (
    <>
      <Header />
      <div className="tricolor"></div>
      <div className="sysreq-wrap">
        <div className="sysreq-head">
          <h1>System Requirements Check</h1>
          <p>
            We need to verify the enabled system requirements before your exam can begin.
          </p>
        </div>

        <div className="sysreq-layout">
          <div className="card sysreq-card sysreq-panel-checks">
              <h2>System Checks</h2>

              <div className="sysreq-check-row">
                <div className="sysreq-check-row-head">
                  <div className="sysreq-check-title">
                    <span className="ic">📷</span> Camera Access
                  </div>
                  <StatusBadge state={cameraState} passText="Active" failText="Blocked" />
                </div>
                {camera.error && (
                  <p className="sysreq-hint" style={{ color: "var(--danger)" }}>
                    {camera.error}{" "}
                    <button
                      className="link-btn"
                      style={{ fontSize: "inherit" }}
                      onClick={camera.retry}
                    >
                      Retry
                    </button>
                  </p>
                )}
              </div>

              <div className="sysreq-check-row">
                <div className="sysreq-check-row-head">
                  <div className="sysreq-check-title">
                    <span className="ic">🎤</span> Microphone
                  </div>
                  <StatusBadge state={micState} passText="Sound Detected" failText={micFailText} />
                </div>
                {microphone.error ? (
                  <p className="sysreq-hint" style={{ color: "var(--danger)" }}>
                    {microphone.error}{" "}
                    <button
                      className="link-btn"
                      style={{ fontSize: "inherit" }}
                      onClick={microphone.retry}
                    >
                      Retry
                    </button>
                  </p>
                ) : examSettings.microphoneRequired && settingsLoaded && !micReady && (
                  <p className="sysreq-hint">
                    {microphone.loading
                      ? "Allow microphone access when your browser asks."
                      : microphone.needsActivation
                        ? "Click Start Microphone Test below to enable audio measurement."
                        : "Speak for a moment to confirm your microphone receives sound."}
                  </p>
                )}
              </div>

              <div className="sysreq-check-row">
                <div className="sysreq-check-row-head">
                  <div className="sysreq-check-title">
                    <span className="ic">🖥️</span> Fullscreen Mode
                  </div>
                  <StatusBadge
                    state={fullscreenState}
                    passText="Enabled"
                    failText="Not Active"
                  />
                </div>
                {fullscreenRequired && !fullscreen.isFullscreen && (
                  <>
                    <p className="sysreq-hint">
                      {fullscreen.supported
                        ? "The exam must be taken in fullscreen mode."
                        : "Fullscreen is not supported on this browser or device. Please switch to a supported desktop browser."}
                    </p>
                    {fullscreen.supported && (
                      <button
                        className="btn btn-primary btn-sm"
                        style={{ marginTop: "10px" }}
                        onClick={fullscreen.enterFullscreen}
                      >
                        Enter Fullscreen
                      </button>
                    )}
                  </>
                )}
              </div>

              <div className="sysreq-check-row">
                <div className="sysreq-check-row-head">
                  <div className="sysreq-check-title">
                    <span className="ic">🙂</span> Face Recognition
                  </div>
                  <StatusBadge
                    state={faceRowState}
                    passText="Face Detected"
                    failText={faceFailText}
                  />
                </div>
                <p className="sysreq-hint" style={face.modelError && !faceBlockedByCamera ? { color: "var(--danger)" } : undefined}>
                {!examSettings.faceDetectionEnabled
                  ? "Not Required"
                  : faceBlockedByCamera
                  ? "Face recognition needs a working camera. Fix Camera Access above, then it will run automatically."
                  : face.modelError
                  ? face.modelError
                    : faceState === "checking"
                      ? "Starting face detection…"
<<<<<<< HEAD
                      : face.lowLight
                        ? "Low light — face a window or turn on a lamp so your face is clearly visible. Exactly one face must be visible at all times."
                        : "Exactly one face must be visible at all times."}
=======
                      : "Exactly one face must be visible at all times."}
>>>>>>> origin/main
                  {face.modelError && !faceBlockedByCamera && (
                    <>
                      {" "}
                      <button className="link-btn" style={{ fontSize: "inherit" }} onClick={face.retry}>
                        Retry
                      </button>
                    </>
                  )}
                </p>
              </div>
          </div>

          <div className="card sysreq-card sysreq-panel-mic">
              <div className="sysreq-card-head">
                <div className="sysreq-check-title">
                  <span className="ic">🎤</span> Microphone Level
                </div>
                <StatusBadge state={micState} passText="Test Passed" failText={micFailText} />
              </div>
              <div className="mic-meter" role="meter" aria-label="Microphone input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={microphone.level}>
                {Array.from({ length: MIC_METER_BARS }).map((_, i) => {
                  const threshold = ((i + 1) / MIC_METER_BARS) * 100;
                  const active = microphone.ready && microphone.level >= threshold;
                  return (
                    <div
                      key={i}
                      className={`mic-meter-bar ${active ? "active" : ""}`}
                      style={{ height: `${10 + (i / MIC_METER_BARS) * 44}px` }}
                    />
                  );
                })}
              </div>
              {!settingsLoaded ? (
                <p className="sysreq-hint">Loading exam requirements…</p>
              ) : !examSettings.microphoneRequired ? (
                <p className="sysreq-hint">Not Required</p>
              ) : microphone.needsActivation ? (
                <div>
                  <p className="sysreq-hint">Your browser needs a click to start the audio test. Click below, then speak normally.</p>
                  <button className="btn btn-primary btn-sm" style={{ marginTop: "10px" }} onClick={microphone.resume}>
                    Start Microphone Test
                  </button>
                </div>
              ) : microphone.error ? (
                <div className="error-state" style={{ padding: "14px" }}>
                  <p style={{ marginBottom: "10px" }}>{microphone.error}</p>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={microphone.retry}
                  >
                    Retry Microphone Access
                  </button>
                </div>
              ) : micReady ? (
                <p className="sysreq-hint" role="status">
                  Sound detected. Your microphone test passed.
                </p>
              ) : microphone.loading ? (
                <p className="sysreq-hint">Waiting for microphone permission…</p>
<<<<<<< HEAD
              ) : microphone.ready && microphone.activity === "no-signal" ? (
                <div>
                  <p className="sysreq-hint" style={{ color: "var(--danger)" }}>
                    Your microphone is sending no sound at all. It may be muted by a switch on your headset or
                    laptop, or in your system sound settings. Unmute it, then speak normally.
                  </p>
                  <button className="btn btn-primary btn-sm" style={{ marginTop: "10px" }} onClick={microphone.retry}>
                    Retry Microphone Access
                  </button>
                </div>
              ) : microphone.muted || !microphone.ready ? (
                <div>
                  <p className="sysreq-hint" style={{ color: "var(--danger)" }}>
                    No sound detected yet. Speak normally — even a soft voice is enough. If the bars still don&apos;t
                    move, check your microphone settings.
=======
              ) : microphone.muted || !microphone.ready ? (
                <div>
                  <p className="sysreq-hint" style={{ color: "var(--danger)" }}>
                    No sound detected yet. Check your device's mute switch and microphone settings, then speak normally.
>>>>>>> origin/main
                  </p>
                  <button className="btn btn-primary btn-sm" style={{ marginTop: "10px" }} onClick={microphone.retry}>
                    Retry Microphone Access
                  </button>
                </div>
              ) : (
                <p className="sysreq-hint">
                  Speak for a moment — the bars should move with your voice. You can continue once sound is detected.
                </p>
              )}
          </div>

          <div className="card sysreq-camera-card sysreq-panel-camera">
              <div className="sysreq-card-head">
                <div className="sysreq-check-title">
                  <span className="ic">📷</span> Live Camera Preview
                </div>
                <StatusBadge state={cameraState} passText="Active" failText="Blocked" />
              </div>
              <div
                className={`camera-preview ${
                  camera.ready ? (faceReady ? "face-ok" : "face-missing") : ""
                }`}
              >
                <video
                  ref={(video) => {
                    camera.videoRef.current = video;
                    // This ref runs on every render (mic meter, face
                    // detection). Re-assigning srcObject — even to the same
                    // stream — reloads the element and makes the preview
                    // flicker, so only attach when it actually changed.
                    if (video && camera.stream && video.srcObject !== camera.stream) {
                      video.srcObject = camera.stream;
                      video.play().catch(() => {});
                    }
                  }}
                  className="video-preview"
                  autoPlay
                  muted
                  playsInline
                  aria-label="Your live camera feed"
                  onLoadedMetadata={(event) => event.currentTarget.play().catch(() => {})}
                  onCanPlay={(event) => event.currentTarget.play().catch(() => {})}
                  style={{ transform: "scaleX(-1)" }}
                />
                {captureBusy && capturePhase !== "uploading" && (
                  <div className="capture-overlay" role="status" aria-live="assertive">
                    {capturePhase === "countdown" ? (
                      <>
                        <span key={countdown} className="capture-countdown">{countdown}</span>
                        <span className="capture-overlay-label">Look at the camera — taking your photo</span>
                      </>
                    ) : (
                      <span className="capture-overlay-label">
                        {capturePhase === "preparing" ? "Preparing camera…" : "Capturing…"}
                      </span>
                    )}
                  </div>
                )}
                {capturedPhotoUrl && (capturePhase === "uploading" || capturePhase === "done") && (
                  <>
                    <img src={capturedPhotoUrl} alt="Your captured check-in photo" className="video-preview capture-photo-image" />
                    <div className="capture-photo-tag">
                      {capturePhase === "uploading" ? "⏳ Saving photo…" : "✓ Photo captured"}
                    </div>
                  </>
                )}
                {camera.ready && (
                  <span
                    className={`camera-face-badge ${
                      faceState === "single"
                        ? "ok"
                        : faceState === "checking"
                          ? ""
                          : "fail"
                    }`}
                  >
                    {examSettings.faceDetectionEnabled && faceState === "checking" && "Loading face detection…"}
                    {faceState === "single" && "✓ Face Detected"}
                    {faceState === "none" && "⚠ No Face Detected"}
                    {faceState === "multiple" && "⚠ Multiple Faces Detected"}
                  </span>
                )}
              </div>
              {camera.error ? (
                <div className="error-state" style={{ padding: "14px" }}>
                  <p style={{ marginBottom: "10px" }}>{camera.error}</p>
                  <button className="btn btn-primary btn-sm" onClick={camera.retry}>
                    Retry Camera Access
                  </button>
                </div>
              ) : (
                <p className="sysreq-hint">
                  Stay clearly visible and well-lit. This preview stays on
                  throughout verification.
                </p>
              )}
          </div>

          <div className="card sysreq-card sysreq-panel-terms">
              <div className="sysreq-card-head">
                <div className="sysreq-check-title">
                  <span className="ic">📄</span> Terms &amp; Conditions
                </div>
                {termsAccepted && <span className="status-badge success">✓ Accepted</span>}
              </div>
              <p className="sysreq-hint">
                By accepting, you confirm you will follow the examination
                rules for the full duration.{" "}
                {examSettings.photoCaptureEnabled
                  ? "When you click I Agree, a 3-second countdown starts and your check-in photo is taken from your camera."
                  : "Check-in photo capture is disabled by the exam administrator."}
              </p>
              <button
                className="btn btn-primary btn-block"
                style={{ marginTop: "10px" }}
                disabled={!allChecksPass || termsAccepted || captureBusy}
                onClick={handleAcceptTerms}
              >
                {!examSettings.photoCaptureEnabled
                  ? termsAccepted ? "✓ Terms Accepted" : "I Agree — Accept Terms & Conditions"
                  : capturePhase === "done"
                  ? "Photo Captured ✓"
                  : termsAccepted
                    ? "✓ Terms Accepted"
                    : capturePhase === "preparing"
                      ? "Preparing Camera…"
                      : capturePhase === "countdown"
                        ? String(countdown)
                        : capturePhase === "capturing"
                          ? "Capturing…"
                          : capturePhase === "uploading"
                            ? "Saving Photo…"
                            : "I Agree — Accept Terms & Conditions"}
              </button>
              {capturePhase === "failed" ? (
                <div className="error-state" style={{ padding: "14px", marginTop: "10px" }}>
                  <p style={{ marginBottom: "6px", fontWeight: 700 }}>⚠ {CAPTURE_FAILED_MESSAGE}</p>
                  <p style={{ marginBottom: "10px" }}>{captureError}</p>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!allChecksPass}
                    onClick={handleAcceptTerms}
                  >
                    Retry Capture
                  </button>
                  {!allChecksPass && (
                    <p className="sysreq-hint">Complete all system checks above to retry.</p>
                  )}
                </div>
              ) : !allChecksPass && !captureBusy ? (
                <p className="sysreq-hint">
                  Complete all system checks above to enable this.
                </p>
              ) : (
                <p className="sysreq-hint">
                  {capturePhase === "uploading"
                    ? "⏳ Saving check-in photo…"
                    : termsAccepted && screenshotGateSatisfied
                      ? "✓ Check-in photo saved"
                      : ""}
                </p>
              )}
          </div>
        </div>

        <div className={`sysreq-summary ${allChecksPass ? "ready" : ""}`}>
          <span>
            {!allChecksPass
              ? `${passedCount} of ${totalRequiredChecks} checks passed`
              : captureBusy
                ? "✓ All system checks passed — taking your check-in photo…"
                : !termsAccepted
                  ? "✓ All system checks passed — accept Terms & Conditions below to continue"
                  : "✓ All system checks passed"}
          </span>
        </div>

        <div className="sysreq-actions">
          <button
            className="btn btn-success btn-block btn-lg"
            disabled={!canProceed || startPending}
            onClick={handleStartExam}
          >
            {!allChecksPass
              ? "Complete All Checks to Continue"
              : captureBusy
                ? "Taking Check-in Photo…"
                : !termsAccepted
                  ? "Accept Terms & Conditions to Continue"
                  : startPending
                    ? "Confirming…"
                    : "Start Exam →"}
          </button>
          {startError && (
            <p className="sysreq-hint" role="alert" style={{ color: "var(--danger)" }}>
              {startError}
            </p>
          )}
        </div>
      </div>

      {showPopup && (
        <div className="overlay">
          <div className="modal-card" style={{ textAlign: "center" }}>
            <div className="icon-circle danger">⚠</div>
            <h3>{popupContent.title}</h3>
            <p>{popupContent.message}</p>
            <div className="modal-actions" style={{ justifyContent: "center" }}>
              <button
                className="btn btn-primary"
                onClick={() => setPopupDismissed(true)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </>
  );
};

export default SystemCheckPage;

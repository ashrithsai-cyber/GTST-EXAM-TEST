import React, { createContext, useContext, useState, useEffect } from 'react';
import { AuthContext } from './AuthContext';
import { fetchExamSettings } from '../services/examService';
import { useCamera } from '../hooks/useCamera';
import { useMicrophone } from '../hooks/useMicrophone';
import { useFullscreen } from '../hooks/useFullscreen';

// Fail-safe default if the settings fetch hasn't resolved yet, or fails
// entirely — identical to what every check has always required, so a
// slow/broken settings fetch can only ever make checks MORE strict
// (matching today's hardcoded behavior), never accidentally skip one a
// student was actually supposed to complete.
const DEFAULT_EXAM_SETTINGS = {
  cameraRequired: true,
  photoCaptureEnabled: true,
  microphoneRequired: true,
  fullscreenRequired: true,
  proctoringEnabled: true,
  faceDetectionEnabled: true,
  videoRequired: true,
  networkMonitoringEnabled: true,
  tabSwitchMonitoringEnabled: true,
};

export const SystemCheckContext = createContext();

export const GATES_STORAGE_KEY = 'gtst_exam_gates';

// Gates are tagged with the registrationId that earned them and only
// ever applied back to that same student. Without this, a "checks
// passed" flag left in localStorage by one student would silently wave
// a DIFFERENT student straight past System Check / Proctoring Rules if
// they logged in on the same browser (e.g. a shared lab computer) and
// deep-linked into the exam flow before clicking through the Dashboard
// (which is the only place that normally resets these).
function loadGates(registrationId) {
  try {
    const raw = localStorage.getItem(GATES_STORAGE_KEY);
    if (!raw || !registrationId) return { systemCheckComplete: false, proctoringAcknowledged: false };
    const parsed = JSON.parse(raw);
    if (parsed.registrationId !== registrationId) {
      return { systemCheckComplete: false, proctoringAcknowledged: false };
    }
    return {
      systemCheckComplete: !!parsed.systemCheckComplete,
      proctoringAcknowledged: !!parsed.proctoringAcknowledged,
    };
  } catch {
    return { systemCheckComplete: false, proctoringAcknowledged: false };
  }
}

function saveGates(registrationId, gates) {
  try {
    if (!registrationId) {
      localStorage.removeItem(GATES_STORAGE_KEY);
      return;
    }
    localStorage.setItem(GATES_STORAGE_KEY, JSON.stringify({ registrationId, ...gates }));
  } catch {
    // Storage unavailable — gates still work in memory for this tab.
  }
}

export const SystemCheckProvider = ({ children }) => {
  const { student, token } = useContext(AuthContext);
  const registrationId = student?.registrationId || null;
  const hasToken = Boolean(token);

  const [cameraReady, setCameraReady] = useState(false);
  const [microphoneReady, setMicrophoneReady] = useState(false);
  const [fullscreenReady, setFullscreenReady] = useState(false);
  const [faceCount, setFaceCount] = useState(0);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [systemCheckComplete, setSystemCheckComplete] = useState(false);
  const [proctoringAcknowledged, setProctoringAcknowledged] = useState(false);
  const [examSettings, setExamSettings] = useState(DEFAULT_EXAM_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [examFlowActive, setExamFlowActive] = useState(false);
  const [gatesHydrated, setGatesHydrated] = useState(false);
  const hydratingRegistrationIdRef = React.useRef(null);
  const camera = useCamera({ enabled: Boolean(student && settingsLoaded && examFlowActive && examSettings.cameraRequired) });
  const microphone = useMicrophone({ enabled: Boolean(student && settingsLoaded && examFlowActive && examSettings.microphoneRequired) });
  const fullscreen = useFullscreen();

  // Fetched once per login — the single source of truth for which
  // checks this exam actually requires (see backend/src/controllers/
  // settings.controller.js). Starts at the strict defaults above and
  // only ever loosens once a real response confirms it should.
  useEffect(() => {
    setSettingsLoaded(false);
    setExamSettings(DEFAULT_EXAM_SETTINGS);
    if (!student || !token) {
      // examFlowActive is deliberately NOT reset here: it's route-derived
      // and owned by LiveCameraPreview, whose effect only re-runs on a
      // route change. Resetting it here (this parent effect runs after
      // that child effect, while auth is still restoring from storage)
      // left it stuck false after a refresh on /system-check, so the
      // camera was never requested. The camera is already disabled
      // without a student via useCamera's `enabled` condition below.
      setSettingsLoaded(false);
      return;
    }
    let cancelled = false;
    fetchExamSettings(token)
      .then((res) => {
        if (!cancelled && res?.settings) setExamSettings({ ...DEFAULT_EXAM_SETTINGS, ...res.settings });
      })
      .catch(() => {
        // Keep the strict defaults — never let a failed fetch loosen
        // what a student is required to do.
      })
      .finally(() => {
        if (!cancelled) setSettingsLoaded(true);
      });
    return () => { cancelled = true; };
  }, [registrationId, hasToken]);

  // Re-derive gates whenever the authenticated student changes — covers
  // login, logout (registrationId becomes null → gates clear), and a
  // different student logging in on the same browser (their own gates,
  // never the previous student's).
  useEffect(() => {
    setCameraReady(false);
    setMicrophoneReady(false);
    setFullscreenReady(false);
    setFaceCount(0);
    setTermsAccepted(false);
    if (!registrationId) {
      setGatesHydrated(false);
      setSystemCheckComplete(false);
      setProctoringAcknowledged(false);
      return;
    }
    const gates = loadGates(registrationId);
    hydratingRegistrationIdRef.current = registrationId;
    setSystemCheckComplete(gates.systemCheckComplete);
    setProctoringAcknowledged(gates.proctoringAcknowledged);
    setGatesHydrated(true);
  }, [registrationId]);

  useEffect(() => {
    if (!gatesHydrated || !registrationId) return;
    // Skip the first write for a student. The preceding effect has just
    // restored that student's persisted values; writing here would otherwise
    // persist the initial false state during the same render cycle.
    if (hydratingRegistrationIdRef.current === registrationId) {
      hydratingRegistrationIdRef.current = null;
      return;
    }
    saveGates(registrationId, { systemCheckComplete, proctoringAcknowledged });
  }, [registrationId, systemCheckComplete, proctoringAcknowledged, gatesHydrated]);

  const resetSystemCheck = () => {
    setCameraReady(false);
    setMicrophoneReady(false);
    setFullscreenReady(false);
    setFaceCount(0);
    setTermsAccepted(false);
    setSystemCheckComplete(false);
    setProctoringAcknowledged(false);
  };

  const completeSystemCheck = () => setSystemCheckComplete(true);
  const completeProctoringRules = () => setProctoringAcknowledged(true);

  return (
    <SystemCheckContext.Provider value={{
      cameraReady, setCameraReady,
      microphoneReady, setMicrophoneReady,
      fullscreenReady, setFullscreenReady,
      faceCount, setFaceCount,
      termsAccepted, setTermsAccepted,
      systemCheckComplete,
      proctoringAcknowledged,
      gatesHydrated,
      examSettings,
      settingsLoaded,
      examFlowActive,
      setExamFlowActive,
      camera,
      microphone, fullscreen,
      resetSystemCheck, completeSystemCheck, completeProctoringRules
    }}>
      {children}
    </SystemCheckContext.Provider>
  );
};

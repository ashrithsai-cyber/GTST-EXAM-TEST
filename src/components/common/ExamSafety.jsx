import React, { useContext, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { SystemCheckContext } from '../../context/SystemCheckContext';
import { ExamContext } from '../../context/ExamContext';
import { MonitoringContext } from '../../context/MonitoringContext';

export default function ExamSafety() {
  const { pathname } = useLocation();
  const { examSettings, settingsLoaded, camera, microphone, fullscreen } = useContext(SystemCheckContext);
  const { sessionId, submitted } = useContext(ExamContext);
  const { reportEvent } = useContext(MonitoringContext);
  const reportRef = useRef(reportEvent); reportRef.current = reportEvent;
  const [warning, setWarning] = useState('');
  const guarded = ['/proctoring-rules', '/exam', '/summary'].includes(pathname) && !submitted;
  const previousMedia = useRef({ camera: camera.ready, microphone: microphone.ready });
  useEffect(() => {
    const previous = previousMedia.current;
    if (pathname === '/summary' && sessionId && !submitted) {
      if (previous.camera && !camera.ready) {
        setWarning('Camera access was lost.');
        void reportRef.current('CAMERA_DISABLED', 'Camera access was lost during summary.').catch(() => {});
      }
      if (previous.microphone && !microphone.ready && !microphone.needsActivation) {
        setWarning('Microphone access was lost.');
        void reportRef.current('MICROPHONE_DISABLED', 'Microphone access was lost during summary.').catch(() => {});
      }
    }
    previousMedia.current = { camera: camera.ready, microphone: microphone.ready };
  }, [pathname, sessionId, submitted, camera.ready, microphone.ready, microphone.needsActivation]);
  // The question page already reports these signals. Keep the same coverage
  // on Summary until the attempt has actually been finalized.
  useEffect(() => {
    if (pathname !== '/summary' || !sessionId || submitted) return undefined;
    let lastFocus = 0;
    const report = (type, message) => { setWarning(message); void reportRef.current(type, message).catch(() => {}); };
    const visibility = () => { if (document.hidden && Date.now() - lastFocus > 3000) { lastFocus = Date.now(); report('TAB_SWITCH', 'You left the examination tab.'); } };
    const focus = () => { if (Date.now() - lastFocus > 3000) { lastFocus = Date.now(); report('WINDOW_BLUR', 'The examination window lost focus.'); } };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', focus);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', focus); };
  }, [pathname, sessionId, submitted]);
  const previousFullscreen = useRef(fullscreen.isFullscreen);
  useEffect(() => {
    if (pathname === '/summary' && !submitted && sessionId && examSettings.fullscreenRequired && previousFullscreen.current && !fullscreen.isFullscreen) {
      void reportRef.current('FULLSCREEN_EXIT', 'Fullscreen exited during examination summary.').catch(() => {});
    }
    previousFullscreen.current = fullscreen.isFullscreen;
  }, [fullscreen.isFullscreen, pathname, submitted, sessionId, examSettings.fullscreenRequired]);

  if (!settingsLoaded || !guarded) return null;
  // Sequential permission prompts keep the user gesture required by each API.
  const needsFullscreen = examSettings.fullscreenRequired && !fullscreen.isFullscreen;
  const needsCamera = !sessionId && examSettings.cameraRequired && !camera.ready;
  const needsMicrophone = !sessionId && examSettings.microphoneRequired && !microphone.ready;
  if (needsFullscreen || needsCamera || needsMicrophone) return <div className="overlay" role="alertdialog" aria-modal="true" aria-labelledby="exam-safety-title">
    <div className="modal-card">
      <h3 id="exam-safety-title">{needsFullscreen ? 'Full-Screen Mode Required' : 'Restore Exam Devices'}</h3>
      <p>Enter fullscreen to continue the examination.</p>
      {warning && <p role="alert">{warning}</p>}
      {needsFullscreen ? fullscreen.supported ? <><p role="alert">{fullscreen.error}</p><button className="btn btn-primary" onClick={fullscreen.enterFullscreen}>Return to Full Screen</button></>
          : <p role="alert">This browser cannot provide fullscreen. Open the exam directly in a supported browser.</p>
          : <>{needsCamera && <><p role="alert">{camera.error || 'Connecting your camera…'}</p><button className="btn btn-primary" onClick={camera.retry}>Retry Camera</button></>}
            {needsMicrophone && <><p role="alert">{microphone.error || 'Connecting your microphone…'}</p><button className="btn btn-primary" onClick={microphone.needsActivation ? microphone.resume : microphone.retry}>{microphone.needsActivation ? 'Activate Microphone' : 'Retry Microphone Access'}</button></>}</>}
    </div>
  </div>;
  return warning && pathname === '/summary' ? <div className="monitoring-save-status" role="alert">{warning}<button onClick={() => setWarning('')}>Dismiss</button></div> : null;
}

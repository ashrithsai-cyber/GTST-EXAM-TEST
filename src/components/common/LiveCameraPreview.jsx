import React, { useContext, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { SystemCheckContext } from '../../context/SystemCheckContext';
import { ExamContext } from '../../context/ExamContext';

const CAMERA_ROUTES = new Set([
  '/system-check',
  '/proctoring-rules',
  '/exam',
  '/summary',
]);

const SUBMITTED_ROUTES = new Set(['/success', '/result']);

const LiveCameraPreview = () => {
  const { camera, setExamFlowActive } = useContext(SystemCheckContext);
  const { stop } = camera;
  const { examLoading } = useContext(ExamContext);
  const location = useLocation();
  const examRoute = CAMERA_ROUTES.has(location.pathname);

  useEffect(() => {
    setExamFlowActive(examRoute);
  }, [examRoute, setExamFlowActive]);

  useEffect(() => {
    if (SUBMITTED_ROUTES.has(location.pathname)) stop();
  }, [location.pathname, stop]);

  const needsPreview = ['/proctoring-rules', '/summary'].includes(location.pathname)
    || (location.pathname === '/exam' && examLoading);
  if (!needsPreview || !camera.stream) return null;
  return <aside className="flow-camera-preview" aria-label="Camera monitoring">
    <video autoPlay muted playsInline aria-label="Your live camera feed" ref={video => {
      camera.videoRef.current = video;
      if (video && camera.stream && video.srcObject !== camera.stream) {
        video.srcObject = camera.stream; video.play().catch(() => {});
      }
    }} />
    <span>{camera.ready ? 'Camera active' : 'Check camera'}</span>
    {camera.error && <button className="btn btn-primary btn-sm" onClick={camera.retry}>Retry Camera</button>}
  </aside>;
};

export default LiveCameraPreview;

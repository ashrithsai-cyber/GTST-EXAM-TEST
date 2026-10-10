import React, { useContext, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { SystemCheckContext } from '../../context/SystemCheckContext';

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
  const location = useLocation();
  const examRoute = CAMERA_ROUTES.has(location.pathname);

  useEffect(() => {
    setExamFlowActive(examRoute);
  }, [examRoute, setExamFlowActive]);

  useEffect(() => {
    if (SUBMITTED_ROUTES.has(location.pathname)) stop();
  }, [location.pathname, stop]);

  return null;
};

export default LiveCameraPreview;
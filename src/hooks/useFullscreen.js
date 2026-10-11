import { useState, useEffect, useCallback } from 'react';

export function useFullscreen() {
  const current = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  const [isFullscreen, setIsFullscreen] = useState(current);
  const supported = Boolean((document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)
    && document.fullscreenEnabled !== false && document.webkitFullscreenEnabled !== false);
  const [error, setError] = useState('');

  useEffect(() => {
    const handleChange = () => setIsFullscreen(current());
    document.addEventListener('fullscreenchange', handleChange);
    document.addEventListener('webkitfullscreenchange', handleChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleChange);
      document.removeEventListener('webkitfullscreenchange', handleChange);
    };
  }, []);

  const enterFullscreen = useCallback(async () => {
    try {
      const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
      if (!request) throw new Error('unsupported');
      await request.call(document.documentElement);
      const active = current();
      setIsFullscreen(active);
      setError(active ? '' : 'Fullscreen did not open. Click again or open the exam in a supported browser.');
      return active;
    } catch {
      setError('Fullscreen could not open. Allow fullscreen or open the exam directly in a supported browser.');
      return false;
    }
  }, []);

  return { isFullscreen, enterFullscreen, supported, error };
}

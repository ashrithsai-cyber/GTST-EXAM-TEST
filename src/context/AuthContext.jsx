import React, { createContext, useState, useEffect, useRef } from 'react';
import { apiPost } from '../components/utils/api';

export const AuthContext = createContext();
const STORAGE_KEY = 'gtst_student_session';
const GATES_STORAGE_KEY = 'gtst_exam_gates';
function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now();
  } catch { return true; }
}
function persist(student, token) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ student, token })); } catch { /* In-memory login remains usable. */ }
}
export const AuthProvider = ({ children }) => {
  const [student, setStudent] = useState(null);
  const [token, setToken] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const recoveryToken = useRef(null);
  const currentToken = useRef(null);
  const identityVersion = useRef(0);
  currentToken.current = token;
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved?.student && saved?.token) {
        // A signed expired token can prove ownership only at credentialed login.
        recoveryToken.current = saved.token;
        if (!isTokenExpired(saved.token)) {
          setStudent(saved.student); setToken(saved.token); setIsAuthenticated(true);
        }
      }
    } catch { /* Corrupt or inaccessible storage is treated as logged out. */ }
    setAuthLoading(false);
  }, []);

  useEffect(() => {
    if (!student || !token) return undefined;
    let cancelled = false;
    let busy = false;
    const version = identityVersion.current;
    const heartbeat = async () => {
      if (busy || !navigator.onLine) return;
      busy = true;
      try {
        const response = await apiPost('/api/exam/auth/heartbeat', undefined, currentToken.current);
        if (cancelled || identityVersion.current !== version) return;
        if (response.token) {
          recoveryToken.current = response.token; currentToken.current = response.token;
          setToken(response.token); persist(student, response.token);
        }
      } catch (error) {
        if (!cancelled && identityVersion.current === version && [401, 409].includes(error.status)) {
          recoveryToken.current = currentToken.current;
          setSessionError(error.message || 'Your session has expired. Please log in again to resume.');
          setStudent(null); setToken(null); setIsAuthenticated(false);
        }
      } finally { busy = false; }
    };
    heartbeat();
    const timer = setInterval(heartbeat, 30000);
    const visible = () => { if (!document.hidden) heartbeat(); };
    window.addEventListener('online', heartbeat);
    document.addEventListener('visibilitychange', visible);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('online', heartbeat); document.removeEventListener('visibilitychange', visible); };
  }, [student, token]);

  const login = async (credentials) => {
    setLoading(true);
    try {
      const data = await apiPost('/api/exam/auth/login', credentials, currentToken.current || recoveryToken.current);
      identityVersion.current += 1;
      recoveryToken.current = data.token; currentToken.current = data.token;
      setStudent(data.student); setToken(data.token); setIsAuthenticated(true); setSessionError('');
      persist(data.student, data.token);
      return { success: true, data: data.student };
    } catch (error) {
      return { success: false, message: error.message || 'Invalid Registration ID or Hall Ticket Number.' };
    } finally { setLoading(false); }
  };
  const logout = () => {
    const oldToken = currentToken.current || recoveryToken.current;
    if (oldToken) apiPost('/api/exam/auth/logout', undefined, oldToken).catch(() => {});
    identityVersion.current += 1;
    recoveryToken.current = null; currentToken.current = null;
    setStudent(null); setToken(null); setIsAuthenticated(false); setSessionError('');
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(GATES_STORAGE_KEY); } catch { /* State already cleared. */ }
  };
  return <AuthContext.Provider value={{ student, token, isAuthenticated, loading, authLoading, sessionError, login, logout }}>{children}</AuthContext.Provider>;
};


// Same host-detection fallback as the student frontend's
// src/components/utils/api.js — resolves to whatever host the page was
// loaded from (so it still works from a LAN IP), unless VITE_API_URL is
// set explicitly. Both frontends talk to the same single Express backend.
export const API_BASE_URL =
  import.meta.env?.VITE_API_URL ||
  (import.meta.env?.DEV
    ? `${window.location.protocol}//${window.location.hostname}:5000`
    : '');

const TOKEN_KEY = "adminToken";

// localStorage key read/written by the admin dashboard's login/logout
// flow (src/newadmin/App.tsx, src/newadmin/pages/LoginPage.tsx).
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// Fired whenever a request comes back 401 (expired/invalid/deactivated
// admin session) so App.jsx can drop back to the login screen from
// anywhere, not just from the explicit logout button.
const SESSION_EXPIRED_EVENT = "admin-session-expired";

export function onSessionExpired(handler) {
  window.addEventListener(SESSION_EXPIRED_EVENT, handler);
  return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
}

export const REQUEST_TIMEOUT_MS = 25000;

async function withTimeout(path, options, readResponse) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, { ...options, signal: controller.signal });
    if (response.status === 401) {
      clearToken();
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    return await readResponse(response);
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error('The server took too long to respond. Check your connection and retry.');
      timeoutError.status = 0;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(method, path, { body, isFormData } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!isFormData && body !== undefined) headers["Content-Type"] = "application/json";

  return withTimeout(path, {
    method,
    headers,
    body: isFormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  }, async response => {
    const data = await response.json().catch(() => {
      if (!response.ok) return {};
      throw new Error('The server returned an invalid response. Check the backend API URL and retry.');
  });

  if (!response.ok) {
    const error = new Error(data.message || "Request failed");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
  });
}

export const apiGet = (path) => request("GET", path);
export const apiPost = (path, body) => request("POST", path, { body });
export const apiPut = (path, body) => request("PUT", path, { body });
export const apiPatch = (path, body) => request("PATCH", path, { body });
export const apiDelete = (path) => request("DELETE", path);
export const apiUpload = (path, formData) => request("POST", path, { body: formData, isFormData: true });

// Authenticated binary download (e.g. the question upload template) —
// separate from request() above since the response body is a file blob,
// not JSON. Reuses the same auth header and 401 -> session-expired
// handling; triggers a normal browser save via a throwaway <a download>.
export async function apiDownload(path, filename) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const blob = await withTimeout(path, { method: "GET", headers }, async response => {
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(data.message || "Download failed");
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return response.blob();
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Authenticated binary fetch that hands back the raw Blob instead of
// triggering a save — for images displayed inline (e.g. the Captured
// Images gallery, which reads private-bucket screenshots that have no
// public URL). Same auth header + 401/session-expired handling as
// apiDownload; the caller is responsible for URL.createObjectURL/revoke.
export async function apiGetBlob(path) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  return withTimeout(path, { method: "GET", headers }, async response => {
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(data.message || "Request failed");
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return response.blob();
  });
}

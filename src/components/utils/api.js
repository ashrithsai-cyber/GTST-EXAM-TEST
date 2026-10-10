// VITE_API_URL must be set for any deployed build. The fallback (same
// protocol and host as the page, port 5000) keeps local and LAN testing
// working, e.g. opening the dev server from a phone on the same network.
export const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:5000`
    : '');

async function apiRequest(method, path, { body, token, isFormData } = {}) {
  const headers = {};
  if (!isFormData) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const init = { method, headers, signal: controller.signal };
    if (isFormData) init.body = body;
    else if (body !== undefined) init.body = JSON.stringify(body);
    response = await fetch(`${API_BASE_URL}${path}`, init);
  } catch {
    const error = new Error('Unable to reach the exam server. Please check your internet connection and try again.');
    error.status = 0;
    error.data = {};
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || "Request failed");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export function apiGet(path, token) {
  return apiRequest("GET", path, { token });
}

export function apiPost(path, body, token) {
  return apiRequest("POST", path, { body, token });
}

// FormData body — the browser sets its own multipart Content-Type
// (with boundary), so it's deliberately omitted from headers above.
export function apiUpload(path, formData, token) {
  return apiRequest("POST", path, { body: formData, token, isFormData: true });
}

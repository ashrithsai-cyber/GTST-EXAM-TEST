import { apiGet, apiPost, getToken, setToken, clearToken } from "./apiClient";

export async function login(email, password) {
  const data = await apiPost("/api/admin/auth/login", { email, password });
  setToken(data.token);
  return data.admin;
}

export async function fetchCurrentAdmin() {
  const data = await apiGet("/api/admin/auth/me");
  return data.admin;
}

export function isLoggedIn() {
  return Boolean(getToken());
}

export function logout() {
  clearToken();
}

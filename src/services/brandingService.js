import { apiGet } from '../components/utils/api';

// The exam name + logo shown across the entire portal (header, footer,
// login page, exam-taking header) — admin-controlled via Admin > Settings
// > Exam Branding (backend/src/controllers/branding.controller.js).
// Intentionally called with no token: this route is public (see
// exam.routes.js) because the Landing/login page needs it before any
// student is authenticated.
export function fetchBranding() {
  return apiGet('/api/exam/branding');
}

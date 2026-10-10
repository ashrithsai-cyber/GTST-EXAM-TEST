import React, { createContext, useState, useEffect } from 'react';
import logoGtst from '../assets/logos/logo-gtst.png';
import { fetchBranding } from '../services/brandingService';

export const BrandingContext = createContext();

// Used only until the real value loads from the backend, or if the
// request fails — never a substitute for the admin-controlled value,
// just what the branding already was before this became editable, so
// nothing ever renders broken/blank while the fetch is in flight. See
// backend/sql/009_exam_branding.sql, which seeds this exact same string
// as the real starting row.
const FALLBACK_EXAM_NAME = 'Global Talent Scholarship Test Plus · South India Level';

export const BrandingProvider = ({ children }) => {
  const [examName, setExamName] = useState(FALLBACK_EXAM_NAME);
  const [logoUrl, setLogoUrl] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchBranding()
      .then((data) => {
        if (cancelled || !data.branding) return;
        if (data.branding.examName) setExamName(data.branding.examName);
        if (data.branding.logoUrl) setLogoUrl(data.branding.logoUrl);
      })
      .catch(() => {
        // Keep the bundled defaults.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keeps the browser tab title in sync with the admin-controlled exam
  // name too — no hardcoded exam name left anywhere, including here.
  useEffect(() => {
    document.title = examName;
  }, [examName]);

  return (
    <BrandingContext.Provider value={{ examName, logoUrl: logoUrl || logoGtst, loading }}>
      {children}
    </BrandingContext.Provider>
  );
};

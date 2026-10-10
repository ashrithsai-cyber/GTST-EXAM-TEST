import React, { useContext } from "react";
import { BrandingContext } from "../../context/BrandingContext";

// Same official portal SuccessPage redirects to.
const OFFICIAL_SITE_URL = "https://www.givelaurelsfoundation.com/";
const OFFICIAL_SITE_LABEL = "www.givelaurelsfoundation.com";

// Helpline numbers shown on every page. `tel` is the dialable form.
const CONTACT_NUMBERS = [
  { label: "93478 23942", tel: "+919347823942" },
  { label: "93478 23943", tel: "+919347823943" },
  { label: "93478 13943", tel: "+919347813943" },
];

// `secureMode` is set on the live exam screen: the site and phone numbers
// are shown as plain text there, because opening a link mid-exam switches
// tabs / apps and would be recorded as a proctoring violation.
const Footer = ({ secureMode = false }) => {
  const { examName } = useContext(BrandingContext);
  return (
    <footer className="site-footer">
      <div className="footer-bar">
        <span className="footer-site">
          {secureMode ? (
            <span className="footer-help-site">{OFFICIAL_SITE_LABEL}</span>
          ) : (
            <a href={OFFICIAL_SITE_URL} target="_blank" rel="noopener noreferrer">
              {OFFICIAL_SITE_LABEL}
            </a>
          )}
        </span>
        <div className="footer-help" aria-label="Help and contact">
          <span className="footer-help-label">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
            Need help?
          </span>
          <span className="footer-contact">
            {CONTACT_NUMBERS.map(({ label, tel }, i) => (
              <React.Fragment key={tel}>
                {i > 0 && <span className="footer-contact-sep" aria-hidden="true">·</span>}
                {secureMode ? (
                  <span className="footer-help-site">{label}</span>
                ) : (
                  <a href={`tel:${tel}`}>{label}</a>
                )}
              </React.Fragment>
            ))}
          </span>
        </div>
        <span className="footer-copy">
          © {new Date().getFullYear()} · {examName}
        </span>
      </div>
    </footer>
  );
};

export default Footer;

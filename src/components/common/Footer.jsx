import React, { useContext } from "react";
import { BrandingContext } from "../../context/BrandingContext";

// Same official portal SuccessPage redirects to. No phone number or email
// is recorded anywhere in this project, so none is shown here.
const OFFICIAL_SITE_URL = "https://www.givelaurelsfoundation.com/";
const OFFICIAL_SITE_LABEL = "www.givelaurelsfoundation.com";

// `secureMode` is set on the live exam screen: the site is shown as plain
// text there, because opening a link mid-exam switches tabs and would be
// recorded as a proctoring violation.
const Footer = ({ secureMode = false }) => {
  const { examName } = useContext(BrandingContext);
  return (
    <footer className="site-footer">
      <div className="footer-help" aria-label="Help and contact">
        <strong>Need help?</strong>
        <span>
          For any issue with your details, login or examination, contact your
          exam coordinator or the exam administrator.
        </span>
        <span>
          Official website:{" "}
          {secureMode ? (
            <span className="footer-help-site">{OFFICIAL_SITE_LABEL}</span>
          ) : (
            <a href={OFFICIAL_SITE_URL} target="_blank" rel="noopener noreferrer">
              {OFFICIAL_SITE_LABEL}
            </a>
          )}
        </span>
      </div>
      <div className="footer-copy">
        © {new Date().getFullYear()} · {examName}
      </div>
    </footer>
  );
};

export default Footer;

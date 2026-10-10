import React, { useState, useContext } from "react";
import { useNavigate } from "react-router-dom";
import { AuthContext } from "../context/AuthContext";
import { BrandingContext } from "../context/BrandingContext";
import Header from "../components/common/Header";
import Footer from "../components/common/Footer";

const Landing = () => {
  const { login, loading, sessionError } = useContext(AuthContext);
  const { examName, logoUrl } = useContext(BrandingContext);
  const navigate = useNavigate();
  const [registrationId, setRegistrationId] = useState("");
  const [hallTicketNumber, setHallTicketNumber] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    const result = await login({ registrationId, hallTicketNumber });
    if (result.success) {
      navigate("/student-confirm", { replace: true });
    } else {
      setError(result.message);
    }
  };

  return (
    <>
      <Header />
      <main className="landing-main">
        <div className="landing-login-wrap">
          <div className="card login-card login-card-large">
            <div className="login-head">
              <div className="login-brand-row">
                <img
                  src={logoUrl}
                  alt={`${examName} logo`}
                  className="login-brand-logo"
                />
              </div>
              <h2>Student Login</h2>
              <p>Enter your Registration ID and Hall Ticket Number to begin</p>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="registrationId">Registration ID</label>
                <input
                  id="registrationId"
                  type="text"
                  placeholder="e.g. GTST24-093157"
                  value={registrationId}
                  onChange={(e) => setRegistrationId(e.target.value)}
                  autoComplete="off"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="hallTicket">Hall Ticket Number</label>
                <input
                  id="hallTicket"
                  type="text"
                  placeholder="Enter your hall ticket number"
                  value={hallTicketNumber}
                  onChange={(e) => setHallTicketNumber(e.target.value)}
                  autoComplete="off"
                  required
                />
              </div>
              {(error || sessionError) && (
                <div
                  role="alert"
                  className="notice-box"
                  style={{
                    background: "var(--danger-tint)",
                    borderColor: "#F0BDB6",
                    color: "#8B291F",
                  }}
                >
                  ⚠ {error || sessionError}
                </div>
              )}
              <button
                type="submit"
                className="btn btn-primary btn-block btn-lg"
                disabled={loading}
              >
                {loading ? "Verifying..." : "Login"}
              </button>
            </form>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
};

export default Landing;

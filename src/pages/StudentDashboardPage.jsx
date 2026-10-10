import React, { useState, useContext, useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { AuthContext } from "../context/AuthContext";
import { SystemCheckContext } from "../context/SystemCheckContext";
import { BrandingContext } from "../context/BrandingContext";
import Header from "../components/common/Header";
import Footer from "../components/common/Footer";
import { SECTION_META } from "../utils/constants";
import { fetchExamInfo, fetchMyResult } from "../services/examService";
import { usePreventBackNavigation } from "../hooks/usePreventBackNavigation";

const StudentDashboardPage = () => {
  const { student, token } = useContext(AuthContext);
  const { resetSystemCheck } = useContext(SystemCheckContext);
  const { examName } = useContext(BrandingContext);
  const navigate = useNavigate();
  usePreventBackNavigation();
  const [agreed, setAgreed] = useState(false);

  // Live from GET /api/exam/info — duration, question/section counts and
  // marks all come from the exams/subjects/questions tables the admin
  // dashboard manages, fetched fresh on every visit (no cache), so an
  // admin's change (renamed subject, added questions, changed the
  // per-question timer) shows up here without restarting anything.
  const [examInfo, setExamInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [completed, setCompleted] = useState(false);
  const [completionLoaded, setCompletionLoaded] = useState(false);

  useEffect(() => {
    if (!student) return;
    let cancelled = false;

    setCompletionLoaded(false);
    fetchMyResult(token).then((data) => { if (!cancelled) setCompleted(!!data.submitted); })
      .catch(() => {}).finally(() => { if (!cancelled) setCompletionLoaded(true); });
    fetchExamInfo(token)
      .then((data) => {
        if (cancelled) return;
        setExamInfo(data);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error.message || "Unable to load exam details.");
      });

    return () => {
      cancelled = true;
    };
  }, [student, token]);

  const handleStart = () => {
    resetSystemCheck();
    navigate("/system-check", { replace: true });
  };

  if (!student) {
    return <Navigate to="/" replace />;
  }

  const totalMinutes = examInfo
    ? Math.round(examInfo.exam.totalDurationSeconds / 60)
    : null;

  const instructions = examInfo
    ? [
        `Total examination duration is ${totalMinutes} minutes.`,
        `The examination contains ${examInfo.exam.totalQuestions} questions across ${examInfo.subjects.length} sections.`,
        `Each question has a fixed ${examInfo.exam.secondsPerQuestion}-second timer and advances automatically once time expires.`,
        `The examination carries ${examInfo.exam.totalMarks} marks in total. There is no negative marking.`,
        "Questions follow a fixed sequence. Once you continue, you cannot return to a question.",
        "If you refresh or reconnect, your saved progress and remaining time will be restored.",
        "Use one device for your exam. Another device cannot take over your active session.",
        "Ensure your internet connectivity remains stable throughout.",
        "The examination will be automatically submitted when time expires.",
      ]
    : [];

  return (
    <>
      <Header />
      <div className="tricolor"></div>
      <div className="page-wrap">
        <div className="page-head">
          <h1>{examName} Student Portal</h1>
          <p>
            Review your exam details and instructions carefully before you
            begin.
          </p>
        </div>

        {loadError && !examInfo && (
          <div className="card info-card" style={{ marginBottom: "16px" }}>
            <p style={{ color: "var(--danger)" }}>{loadError}</p>
            <p className="muted" style={{ fontSize: "12.5px" }}>
              Exam details must load before you begin. Please reload to retry.
            </p>
          </div>
        )}

        <div className="dash-grid">
          <div className="card info-card">
            <h3>📋 Important Instructions</h3>
            {examInfo ? (
              <ol className="instructions-list">
                {instructions.map((text, i) => (
                  <li key={i}>
                    <span className="num">{i + 1}</span>
                    <span>{text}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">Loading exam instructions…</p>
            )}
            {completed && <div className="notice-box" role="status">Your examination has been completed and submitted.</div>}
            {!completed && <label className="check-row">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              I have read and understood all examination instructions.
            </label>}
            <button
              className="btn btn-primary btn-block btn-lg"
              disabled={!completionLoaded || (!completed && (!agreed || !examInfo))}
              onClick={completed ? () => navigate("/success", { replace: true }) : handleStart}
            >
              {completed ? "View Completion" : "Start Examination"}
            </button>
          </div>
          <div className="card info-card">
            <h3>🗂️ Exam Information</h3>
            {examInfo ? (
              <>
                <div className="stat-mini-grid">
                  <div className="stat-mini">
                    <b>{totalMinutes}</b>
                    <span>MINUTES</span>
                  </div>
                  <div className="stat-mini">
                    <b>{examInfo.exam.totalQuestions}</b>
                    <span>QUESTIONS</span>
                  </div>
                  <div className="stat-mini">
                    <b>{examInfo.exam.totalMarks}</b>
                    <span>MARKS</span>
                  </div>
                </div>
                <div className="section-pattern-mini">
                  {examInfo.subjects.map((s) => {
                    const meta = SECTION_META.find((m) => m.key === s.subjectKey);
                    return (
                      <div className="row" key={s.subjectKey}>
                        <span>
                          {meta?.icon || "•"} {s.subjectName}
                        </span>
                        <b>
                          {s.questionCount} Q · {Math.round(s.durationSeconds / 60)} min
                        </b>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="muted">Loading exam details…</p>
            )}
            <div
              style={{
                marginTop: "16px",
                paddingTop: "14px",
                borderTop: "1px solid var(--border-soft)",
                fontSize: "12.3px",
                color: "var(--ink-muted)",
                lineHeight: "1.6",
              }}
            >
              <b style={{ color: "var(--navy)" }}>{student.examName}</b>
              <br />
              Class {student.class}
              <br />
              Scheduled: {student.examDate}
            </div>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
};

export default StudentDashboardPage;

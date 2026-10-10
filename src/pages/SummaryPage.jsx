import React, { useContext, useState, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { ExamContext } from '../context/ExamContext';
import Header from '../components/common/Header';
import Footer from '../components/common/Footer';
import { usePreventBackNavigation } from '../hooks/usePreventBackNavigation';

const SummaryPage = () => {
  const navigate = useNavigate();
  usePreventBackNavigation();
  const { student } = useContext(AuthContext);
  const {
    subjectsMeta, answeredCountFor, showSubmitConfirm, setShowSubmitConfirm, finalizeSubmission,
    examInitError, initExam, submitted,
  } = useContext(ExamContext);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // A fresh page load (e.g. a refresh landing directly on /summary) starts
  // with an empty ExamContext — reload the session from the backend
  // rather than assuming the student already finished every question.
  useEffect(() => {
    if (!student) return;
    if (submitted) { navigate('/success', { replace: true }); return; }
    initExam().then((res) => {
      if (res.success && res.submitted) navigate('/success', { replace: true });
      else if (res.success && !res.examComplete) navigate('/exam', { replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student]);

  if (!student) {
    return <Navigate to="/" replace />;
  }

  if (!subjectsMeta.length) {
    // The scheduled exam window can end (Exam Timing's overall deadline)
    // while a student is sitting unsubmitted right here — the backend
    // auto-submits it on the next server touch, which for a page sitting
    // idle is this very reload. Mirrors ExamPage's identical
    // already-submitted handling instead of just showing a dead-end error.
    const autoSubmitted = examInitError?.data?.status === 'SUBMITTED';
    return (
      <>
        <Header />
        <div className="tricolor"></div>
        <div className="page-wrap">
          <div className="card loading-state" style={{ maxWidth: '480px', margin: '60px auto', textAlign: 'center', padding: '40px' }}>
            <p>{examInitError ? examInitError.message : 'Loading your examination summary…'}</p>
            {examInitError && (
              autoSubmitted ? (
                <button className="btn btn-primary" style={{ marginTop: '16px' }} onClick={() => navigate('/success', { replace: true })}>Continue</button>
              ) : (
                <button className="btn btn-primary" style={{ marginTop: '16px' }} onClick={() => initExam()}>Retry</button>
              )
            )}
          </div>
        </div>
        <Footer />
      </>
    );
  }

  const rows = subjectsMeta.filter((subject) => subject.questionCount > 0).map((subject) => {
    const total = subject.questionCount;
    const done = Math.min(answeredCountFor(subject.subjectKey), total);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return { subject, done, total, unattempted: total - done, pct };
  });

  const totalDone = rows.reduce((a, r) => a + r.done, 0);
  const totalQ = rows.reduce((a, r) => a + r.total, 0);
  const totalUnattempted = totalQ - totalDone;

  const handleConfirmSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await finalizeSubmission();
      setShowSubmitConfirm(false);
      navigate('/success', { replace: true });
    } catch (error) {
      // The Exam Timing deadline can force-submit this session between
      // this page loading and the student clicking Submit (see
      // session/answer controllers) — the backend then reports "already
      // submitted" here, which is really a success from the student's
      // point of view, not an error to surface.
      if (error.data?.submittedAt) {
        setShowSubmitConfirm(false);
        navigate('/success', { replace: true });
        return;
      }
      setSubmitError(error.message || 'Unable to submit your examination. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Header />
      <div className="tricolor"></div>
      <div className="page-wrap">
        <div className="page-head" style={{ textAlign: 'center' }}>
          <h1>Examination Summary</h1>
          <p>Your question sequence is complete. Submit your saved attempt.</p>
        </div>
        <div className="summary-grid">
          <div className="card" style={{ padding: '8px 22px' }}>
            <table className="summary-table">
              <thead><tr><th>Section</th><th>Attempted</th><th>Unattempted</th><th>Progress</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.subject.subjectId}>
                    <td className="subj">{r.subject.subjectName}</td>
                    <td>{r.done} / {r.total}</td>
                    <td>{r.unattempted}</td>
                    <td><div className="progress-mini"><i style={{ width: `${r.pct}%`, background: r.pct === 100 ? 'var(--success)' : 'var(--warning)' }}></i></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="total-row">
            <span className="lbl">Total Attempted</span>
            <span className="val">{totalDone} / {totalQ}</span>
          </div>
          <div className="total-row">
            <span className="lbl">Total Unattempted</span>
            <span className="val">{totalUnattempted} / {totalQ}</span>
          </div>
          <div className="card" style={{ padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '14px' }}>
            <div className="muted" style={{ fontSize: '13px', maxWidth: '420px' }}>Once submitted, you will not be able to make any further changes to your answers. Your saved answers will be submitted securely.</div>
            <button className="btn btn-primary btn-lg" onClick={() => setShowSubmitConfirm(true)}>Submit Examination</button>
          </div>
        </div>
      </div>

      {showSubmitConfirm && (
        <div className="overlay">
          <div className="modal-card">
            <h3>Confirm Submission</h3>
            <p>Are you sure you want to submit your examination? You will not be able to make changes after submission.</p>
            {submitError && (
              <p style={{ color: 'var(--danger)', fontSize: '13px', marginTop: '8px' }}>{submitError}</p>
            )}
            <div className="modal-actions">
              <button className="btn btn-secondary" disabled={submitting} onClick={() => setShowSubmitConfirm(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={submitting} onClick={handleConfirmSubmit}>
                {submitting ? 'Submitting…' : 'Confirm Submission'}
              </button>
            </div>
          </div>
        </div>
      )}
      <Footer />
    </>
  );
};

export default SummaryPage;

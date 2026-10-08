import React, { useContext, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import Header from '../components/common/Header';
import Footer from '../components/common/Footer';
import { fetchMyResult } from '../services/examService';

// Scores are computed and stored server-side at submission time (see
// backend/src/controllers/session.controller.js submitExam). This page
// never computes a score itself — it only shows what GET /api/exam/result
// returns, and that endpoint returns nothing score-related until the
// administrator publishes results for the exam.
const ResultPage = () => {
  const navigate = useNavigate();
  const { student, token } = useContext(AuthContext);
  const [state, setState] = useState({ loading: true, error: '', data: null });

  useEffect(() => {
    if (!student || !token) return undefined;
    let cancelled = false;
    fetchMyResult(token)
      .then((data) => { if (!cancelled) setState({ loading: false, error: '', data }); })
      .catch((error) => { if (!cancelled) setState({ loading: false, error: error.message || 'Unable to load your result.', data: null }); });
    return () => { cancelled = true; };
  }, [student, token]);

  if (!student) {
    return <Navigate to="/" replace />;
  }

  const result = state.data?.published ? state.data.result : null;

  return (
    <>
      <Header />
      <div className="tricolor"></div>
      <div className="page-wrap">
        <div className="page-head" style={{ textAlign: 'center' }}>
          <h1>Examination Result</h1>
          <p>{result?.examName || student.examName}</p>
        </div>
        <div className="summary-grid">
          <div className="card" style={{ padding: '32px 26px', textAlign: 'center' }}>
            <div className="faint" style={{ fontSize: '11.5px', textTransform: 'uppercase', fontWeight: '700', marginBottom: '6px' }}>Student</div>
            <div style={{ fontWeight: '700', fontSize: '16px', marginBottom: '4px' }}>{student.name}</div>
            <div className="muted mono" style={{ fontSize: '12.5px', marginBottom: '22px' }}>{student.registrationId} · Class {student.class}</div>
            {state.loading ? (
              <p style={{ fontSize: '14px', color: 'var(--ink-muted)' }}>Loading your result…</p>
            ) : state.error ? (
              <p style={{ fontSize: '14px', color: 'var(--danger)' }}>{state.error}</p>
            ) : result ? (
              <>
                <div style={{ fontSize: '32px', fontWeight: '800', color: 'var(--navy)' }}>
                  {result.totalScore} / {result.maxScore}
                </div>
                <div className="muted" style={{ fontSize: '13px', marginBottom: '18px' }}>{result.percentage}%</div>
                <div className="stat-mini-grid">
                  <div className="stat-mini"><b>{result.correctAnswers}</b><span>CORRECT</span></div>
                  <div className="stat-mini"><b>{result.wrongAnswers}</b><span>WRONG</span></div>
                  <div className="stat-mini"><b>{result.unanswered}</b><span>UNANSWERED</span></div>
                </div>
              </>
            ) : (
              <p style={{ fontSize: '14px', color: 'var(--ink-muted)' }}>
                {state.data?.submitted === false
                  ? 'No submitted examination was found for your account.'
                  : 'Your result has not been published yet. Results are released on the official portal once the administrator enables result publication.'}
              </p>
            )}
            <button className="btn btn-secondary" style={{ marginTop: '18px' }} onClick={() => navigate('/profile')}>
              Back to Profile
            </button>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
};

export default ResultPage;

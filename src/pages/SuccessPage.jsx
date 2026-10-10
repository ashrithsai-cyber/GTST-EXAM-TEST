import React, { useContext, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { ExamContext } from '../context/ExamContext';
import { BrandingContext } from '../context/BrandingContext';
import { fetchMyResult } from '../services/examService';
import Header from '../components/common/Header';
import Footer from '../components/common/Footer';
import { usePreventBackNavigation } from '../hooks/usePreventBackNavigation';

const REDIRECT_URL = 'https://www.givelaurelsfoundation.com/';
const SuccessPage = () => {
  const { student, token } = useContext(AuthContext);
  const { submitTime, totalAnsweredCount, subjectsMeta } = useContext(ExamContext);
  const { examName } = useContext(BrandingContext);
  const navigate = useNavigate();
  usePreventBackNavigation();
  const [completion, setCompletion] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    let redirect;
    setError(null);
    fetchMyResult(token).then((data) => {
      if (cancelled) return;
      if (!data.submitted) { navigate('/dashboard', { replace: true }); return; }
      setCompletion(data.completion || data.result || {});
      redirect = setTimeout(() => { if (!cancelled) window.location.assign(REDIRECT_URL); }, 3000);
    }).catch((failure) => { if (!cancelled) setError(failure.message || 'Unable to confirm your submission.'); });
    return () => { cancelled = true; clearTimeout(redirect); };
  }, [token, navigate, retry]);
  if (!student) return <Navigate to="/" replace />;
  const submittedAt = completion?.submittedAt || submitTime;
  const time = submittedAt ? new Date(submittedAt).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  }) : 'Recorded by the examination server';
  const total = completion?.totalQuestions ?? subjectsMeta.reduce((sum, subject) => sum + subject.questionCount, 0);
  const attempted = completion?.attemptedQuestions ?? totalAnsweredCount();
  return <>
    <Header />
    <main className="page-wrap">
      <div className="card success-card">
        {completion ? <>
          <div className="success-tick">✓</div>
          <h2>Exam Completed Successfully</h2><p>Your examination has been submitted securely.</p>
          <div className="success-info">
            <div className="row"><span>Student Name</span><span>{student.name}</span></div>
            <div className="row"><span>Registration Number</span><span className="mono">{student.registrationId}</span></div>
            <div className="row"><span>Exam Name</span><span>{completion.examName || examName}</span></div>
            <div className="row"><span>Submission Time (IST)</span><span>{time}</span></div>
            {total > 0 && <div className="row"><span>Questions Attempted</span><span>{attempted} / {total}</span></div>}
          </div>
          <p>Thank you for participating in the examination.</p>
          <p className="faint">Redirecting to the official portal…</p>
        </> : <>
          <h2>Confirming Examination Submission</h2>
          <p role={error ? 'alert' : 'status'}>{error || 'Checking your attempt with the examination server…'}</p>
          {error && <button type="button" className="btn btn-primary" onClick={() => setRetry((value) => value + 1)}>Retry verification</button>}
        </>}
      </div>
    </main>
    <Footer />
  </>;
};
export default SuccessPage;


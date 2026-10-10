import React, { useContext } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { SystemCheckContext } from '../context/SystemCheckContext';
import Header from '../components/common/Header';
import Footer from '../components/common/Footer';
import { usePreventBackNavigation } from '../hooks/usePreventBackNavigation';

const StudentConfirmPage = () => {
  const { student } = useContext(AuthContext);
  const { resetSystemCheck } = useContext(SystemCheckContext);
  const navigate = useNavigate();
  usePreventBackNavigation();

  if (!student) {
    return <Navigate to="/" replace />;
  }

  const handleContinue = () => {
    resetSystemCheck();
    navigate('/dashboard', { replace: true });
  };

  return (
    <>
      <Header />
      <div className="tricolor"></div>
      <div className="page-wrap">
        <div className="page-head" style={{ textAlign: 'center' }}>
          <h1>Welcome, {student.name.split(' ')[0]}</h1>
          <p>Please verify your details before proceeding to the examination.</p>
        </div>
        <div className="card confirm-card">
          <div className="student-info-grid">
            <div className="info-item"><div className="k">Student Name</div><div className="v">{student.name}</div></div>
            <div className="info-item"><div className="k">Registration ID</div><div className="v mono">{student.registrationId}</div></div>
            <div className="info-item"><div className="k">Hall Ticket Number</div><div className="v mono">{student.hallTicketNumber}</div></div>
            <div className="info-item"><div className="k">Class</div><div className="v">{student.class}</div></div>
            <div className="info-item"><div className="k">Exam Date</div><div className="v">{student.examDate}</div></div>
          </div>
          <div className="notice-box">✔️ <span>Please verify your details. Contact your exam coordinator immediately if anything is incorrect.</span></div>
          <button className="btn btn-primary btn-block btn-lg" onClick={handleContinue}>Continue to Dashboard →</button>
        </div>
      </div>
      <Footer />
    </>
  );
};

export default StudentConfirmPage;
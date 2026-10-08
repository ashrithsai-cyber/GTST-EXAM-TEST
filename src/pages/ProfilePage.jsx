import React, { useContext } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { BrandingContext } from '../context/BrandingContext';
import Header from '../components/common/Header';
import Footer from '../components/common/Footer';

const ProfilePage = () => {
  const navigate = useNavigate();
  const { student } = useContext(AuthContext);
  const { examName } = useContext(BrandingContext);

  if (!student) {
    return <Navigate to="/" replace />;
  }

  return (
    <>
      <Header />
      <div className="tricolor"></div>
      <div className="page-wrap">
        <div className="page-head"><h1>Student Profile</h1><p>Your registration details.</p></div>
        <div className="dash-grid">
          <div className="card info-card">
            <h3>👤 Profile Details</h3>
            <div className="student-info-grid">
              <div className="info-item"><div className="k">Student Name</div><div className="v">{student.name}</div></div>
              <div className="info-item"><div className="k">Registration ID</div><div className="v mono">{student.registrationId}</div></div>
              <div className="info-item"><div className="k">Hall Ticket Number</div><div className="v mono">{student.hallTicketNumber}</div></div>
              <div className="info-item"><div className="k">Class</div><div className="v">{student.class}</div></div>
              <div className="info-item"><div className="k">Examination</div><div className="v">{examName}</div></div>
              <div className="info-item"><div className="k">Exam Date</div><div className="v">{student.examDate}</div></div>
            </div>
          </div>
          <div className="card info-card">
            <h3>📄 Result</h3>
            <p className="muted" style={{ fontSize: '13px', marginBottom: '16px' }}>
              Results are released on the official portal once the administrator publishes them.
            </p>
            <button className="btn btn-primary btn-block" onClick={() => navigate('/result')}>View Result Status</button>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
};

export default ProfilePage;

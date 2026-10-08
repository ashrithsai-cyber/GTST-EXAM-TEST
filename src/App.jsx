import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { SystemCheckProvider } from './context/SystemCheckContext';
import { ExamProvider } from './context/ExamContext';
import { BrandingProvider } from './context/BrandingContext';

import Landing from './pages/Landing';
import StudentConfirmPage from './pages/StudentConfirmPage';
import StudentDashboardPage from './pages/StudentDashboardPage';
import SystemCheckPage from './pages/SystemCheckPage';
import ExamProctoringRulesPage from './pages/ExamProctoringRulesPage';
import ExamPage from './pages/ExamPage';
import SummaryPage from './pages/SummaryPage';
import SuccessPage from './pages/SuccessPage';
import ProfilePage from './pages/ProfilePage';
import ResultPage from './pages/ResultPage';
import ProtectedRoute from './components/common/ProtectedRoute';
import SystemCheckRoute from './components/common/SystemCheckRoute';
import ProctoringRoute from './components/common/ProctoringRoute';
import LiveCameraPreview from './components/common/LiveCameraPreview';

import './App.css';

function App() {
  return (
    <BrandingProvider>
      <AuthProvider>
        <SystemCheckProvider>
          <ExamProvider>
            <Router>
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/student-login" element={<Navigate to="/" replace />} />

                <Route element={<ProtectedRoute />}>
                  <Route path="/student-confirm" element={<StudentConfirmPage />} />
                  <Route path="/dashboard" element={<StudentDashboardPage />} />
                  <Route path="/system-check" element={<SystemCheckPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="/result" element={<ResultPage />} />
                  <Route path="/success" element={<SuccessPage />} />

                  <Route element={<SystemCheckRoute />}>
                    <Route path="/proctoring-rules" element={<ExamProctoringRulesPage />} />

                    <Route element={<ProctoringRoute />}>
                      <Route path="/exam" element={<ExamPage />} />
                      <Route path="/summary" element={<SummaryPage />} />
                    </Route>
                  </Route>
                </Route>

                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              <LiveCameraPreview />
            </Router>
          </ExamProvider>
        </SystemCheckProvider>
      </AuthProvider>
    </BrandingProvider>
  );
}

export default App;

import React, { useContext } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { AuthContext } from '../../context/AuthContext';

const ProtectedRoute = () => {
  const { isAuthenticated, authLoading } = useContext(AuthContext);

  // Wait for the localStorage restore check before deciding — otherwise a
  // page refresh briefly sees isAuthenticated=false and bounces an
  // already-logged-in student back to the login page.
  if (authLoading) {
    return null;
  }

  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
};

export default ProtectedRoute;

import React, { useContext } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { AuthContext } from "../../context/AuthContext";
import { SystemCheckContext } from "../../context/SystemCheckContext";

const SystemCheckRoute = () => {
  const { isAuthenticated } = useContext(AuthContext);
  const { systemCheckComplete, gatesHydrated } = useContext(SystemCheckContext);
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/" replace state={{ from: location }} />;
  }

  if (!gatesHydrated) {
    return null;
  }

  if (!systemCheckComplete && location.pathname !== "/system-check") {
    return <Navigate to="/system-check" replace />;
  }

  return <Outlet />;
};

export default SystemCheckRoute;

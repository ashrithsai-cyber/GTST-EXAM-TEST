import React, { useContext } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { SystemCheckContext } from "../../context/SystemCheckContext";

const ProctoringRoute = () => {
  const { proctoringAcknowledged } = useContext(SystemCheckContext);

  if (!proctoringAcknowledged) {
    return <Navigate to="/proctoring-rules" replace />;
  }

  return <Outlet />;
};

export default ProctoringRoute;

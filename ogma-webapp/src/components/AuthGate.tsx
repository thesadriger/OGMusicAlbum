// src/components/AuthGate.tsx
import React from "react";

/** Больше не показываем никаких экранов — просто рендерим детей */
export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return <>{children}</>;
};
import React from "react";
import { createRoot } from "react-dom/client";
import DeadPoetPlatform from "./DeadPoetPlatform.jsx";
import "./index.css";
createRoot(document.getElementById("root")).render(
  <React.StrictMode><DeadPoetPlatform /></React.StrictMode>
);

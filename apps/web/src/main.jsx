// NOTE: no top-level await anywhere in this entry chunk. TLA here deadlocks
// Vite/Rollup's dynamic import() loading, and the post-quantum crypto backends
// are loaded that way — see packages/crypto/src/mls.js.
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

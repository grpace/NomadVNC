import React from "react";
import { createRoot } from "react-dom/client";
// Inter is bundled locally via @fontsource/inter (OFL) — no runtime CDN.
// Weights match the font-weight values used in styles.css.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import { App } from "./App";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Missing root container");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

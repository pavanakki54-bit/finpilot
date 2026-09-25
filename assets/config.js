// Runtime configuration for the web UI.
//
// apiBase:
//   ""          -> try the FastAPI backend on the same origin (Docker / Render),
//                  and fall back to the in-browser engine if it isn't there.
//   "https://…/" -> call a backend hosted elsewhere (e.g. GitHub Pages UI + Render API).
//   "browser"   -> always use the in-browser engine (no network calls).
window.FINPILOT_CONFIG = Object.assign(
  {
    apiBase: "",
    repoUrl: "https://github.com/pavanakki54-bit/finpilot",
  },
  window.FINPILOT_CONFIG || {}
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

// WakeOverlay starts a microphone/WebSocket session as soon as it mounts. React
// StrictMode intentionally mounts effects twice in development, which races the
// first socket's cleanup against the second start. Keep StrictMode for the main
// app while giving the one-shot wake window a single initialization.
const isWakeWindow = new URLSearchParams(window.location.search).has("wake") || new URLSearchParams(window.location.search).has("voice-wake");
createRoot(document.getElementById("root")!).render(isWakeWindow ? <App /> : <StrictMode><App /></StrictMode>);

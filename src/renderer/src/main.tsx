import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/electron/renderer";
import { App } from "./App.js";
import "./styles.css";

const sentryDsn = window.secagent.telemetryConfig.sentryDsn;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    sendDefaultPii: false,
    beforeSend: (event) => {
      if (event.request) {
        delete event.request.headers;
        if (event.request.url) event.request.url = event.request.url.replace(/[?&](?:token|key|code|state)=[^&]*/gi, "");
      }
      for (const exception of event.exception?.values || []) {
        if (exception.value) exception.value = exception.value.replace(/[\r\n\t]+/g, " ").slice(0, 1000);
      }
      return event;
    }
  });
}

// WakeOverlay starts a microphone/WebSocket session as soon as it mounts. React
// StrictMode intentionally mounts effects twice in development, which races the
// first socket's cleanup against the second start. Keep StrictMode for the main
// app while giving the one-shot wake window a single initialization.
const isWakeWindow = new URLSearchParams(window.location.search).has("wake") || new URLSearchParams(window.location.search).has("voice-wake");
createRoot(document.getElementById("root")!).render(isWakeWindow ? <App /> : <StrictMode><App /></StrictMode>);

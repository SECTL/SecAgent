import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/electron/renderer";
import { App } from "./App.js";
import "./styles.css";

const sentryDsn = window.secagent.telemetryConfig.sentryDsn;
let sentryTelemetryEnabled = window.secagent.telemetryConfig.enabled;
let sentryInitialized = false;
const normalizeSentryMessage = (value: string) => value.replace(/[\r\n\t]+/g, " ").replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>").replace(/[A-Za-z]:\\[^ )]+/g, "<path>").replace(/(?:file|https?):\/\/[^\s]+/gi, "<url>").replace(/\s+/g, " ").trim().slice(0, 1000);
function initializeSentry(): void {
  if (!sentryDsn || !sentryTelemetryEnabled || sentryInitialized) return;
  Sentry.init({
    dsn: sentryDsn,
    sendDefaultPii: false,
    beforeSend: (event) => {
      if (!sentryTelemetryEnabled) return null;
      if (event.request) {
        delete event.request.headers;
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.query_string;
        if (event.request.url) event.request.url = event.request.url.replace(/[?&](?:token|key|code|state)=[^&]*/gi, "");
      }
      delete event.user;
      delete event.extra;
      delete event.breadcrumbs;
      if (event.message) event.message = normalizeSentryMessage(event.message);
      if (event.transaction) event.transaction = normalizeSentryMessage(event.transaction);
      for (const exception of event.exception?.values || []) {
        if (exception.value) exception.value = normalizeSentryMessage(exception.value);
      }
      return event;
    }
  });
  sentryInitialized = true;
}
initializeSentry();
window.secagent.onSettingsChanged((settings) => {
  if (!settings || typeof settings !== "object" || !("telemetry" in settings)) return;
  const telemetry = (settings as { telemetry?: { enabled?: unknown } }).telemetry;
  if (telemetry && typeof telemetry.enabled === "boolean") {
    sentryTelemetryEnabled = telemetry.enabled;
    initializeSentry();
  }
});

// WakeOverlay starts a microphone/WebSocket session as soon as it mounts. React
// StrictMode intentionally mounts effects twice in development, which races the
// first socket's cleanup against the second start. Keep StrictMode for the main
// app while giving the one-shot wake window a single initialization.
const isWakeWindow = new URLSearchParams(window.location.search).has("wake") || new URLSearchParams(window.location.search).has("voice-wake");
createRoot(document.getElementById("root")!).render(isWakeWindow ? <App /> : <StrictMode><App /></StrictMode>);

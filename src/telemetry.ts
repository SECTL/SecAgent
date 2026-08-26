import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { SessionData, SessionRuntimeEvent } from "./session-store.js";

export const TELEMETRY_SCHEMA_VERSION = 1;
export const TELEMETRY_EVENT_BATCH_LIMIT = 100;
export const TELEMETRY_EVENT_BATCH_BYTES = 256 * 1024;
export const TELEMETRY_DIAGNOSTIC_COMPRESSED_LIMIT = 10 * 1024 * 1024;
export const TELEMETRY_DIAGNOSTIC_RAW_LIMIT = 50 * 1024 * 1024;

export interface TelemetryEvent {
  schemaVersion: number;
  eventId: string;
  type: string;
  occurredAt: string;
  installId: string;
  instanceId: string;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  locale: string;
  count?: number;
  context: Record<string, unknown>;
  error?: { name?: string; code?: string; message?: string; stack?: string };
  breadcrumbs?: Array<{ at: string; stage: string; status?: string; sizes?: Record<string, number> }>;
}

interface TelemetryIdentity {
  installId: string;
}

export interface TelemetryFailure {
  type: string;
  error?: unknown;
  context?: Record<string, unknown>;
}

export interface TelemetryClientOptions {
  baseUrl: string;
  storageDirectory: string;
  appVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
  locale?: string;
  enabled: boolean;
  getAuthToken?: () => string | undefined;
}

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function asError(error: unknown): { name?: string; code?: string; message?: string; stack?: string } {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown };
    return {
      name: error.name.slice(0, 120),
      ...(typeof candidate.code === "string" ? { code: candidate.code.slice(0, 120) } : {}),
      message: normalizeMessage(error.message),
      ...(error.stack ? { stack: sanitizeStack(error.stack) } : {})
    };
  }
  return { message: normalizeMessage(String(error)) };
}

export function normalizeMessage(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z]:\\[^ ]+/g, "<path>")
    .replace(/(?:file|https?):\/\/[^\s]+/gi, "<url>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/\s+/g, " ").trim().slice(0, 1000);
}

export function sanitizeStack(value: string): string {
  return normalizeMessage(value).replace(/<path>[^ ]*/g, "<path>").slice(0, 12_000);
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function hashIdentifier(value: string): string { return hash(value); }

function readOrCreateIdentity(storageDirectory: string): TelemetryIdentity {
  fs.mkdirSync(storageDirectory, { recursive: true });
  const file = path.join(storageDirectory, "telemetry-identity.json");
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TelemetryIdentity>;
    if (typeof current.installId === "string" && current.installId.length >= 16) return { installId: current.installId };
  } catch { /* Generate a new identity below. */ }
  const identity = { installId: crypto.randomUUID() };
  try { fs.writeFileSync(file, `${JSON.stringify(identity)}\n`, { encoding: "utf8", mode: 0o600 }); } catch { /* Telemetry remains best effort. */ }
  return identity;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function breadcrumb(event: SessionRuntimeEvent): NonNullable<TelemetryEvent["breadcrumbs"]>[number] {
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  const sizes: Record<string, number> = {};
  for (const [key, candidate] of Object.entries(data)) {
    if (!/(length|bytes|characters|count|tokens)/i.test(key)) continue;
    const number = safeNumber(candidate);
    if (number !== undefined) sizes[key] = number;
  }
  const status = typeof data.status === "string" ? data.status.slice(0, 80) : typeof data.kind === "string" ? data.kind.slice(0, 80) : undefined;
  return { at: event.at, stage: event.stage.slice(0, 120), ...(status ? { status } : {}), ...(Object.keys(sizes).length ? { sizes } : {}) };
}

export function redactTraceEvent(event: SessionRuntimeEvent): { at: string; sequence: number; stage: string; data: Record<string, unknown> } {
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  const safe: Record<string, unknown> = {};
  for (const key of ["name", "provider", "model", "status", "reason", "kind", "turn", "attempt", "maxRetries", "waitMs", "toolCount", "server", "pluginId", "ruleName"]) {
    const value = data[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") safe[key] = typeof value === "string" ? value.slice(0, 160) : value;
  }
  for (const key of ["text", "content", "instruction", "arguments", "result", "body", "inputSchema", "path", "systemMessage", "message"]) {
    const value = data[key];
    if (typeof value === "string") safe[`${key}Length`] = value.length;
    else if (value !== undefined && value !== null) {
      try { safe[`${key}Bytes`] = Buffer.byteLength(JSON.stringify(value)); } catch { /* Ignore unserializable data. */ }
    }
  }
  return { at: event.at, sequence: event.sequence, stage: event.stage.slice(0, 120), data: safe };
}

export class TelemetryClient {
  readonly installId: string;
  readonly instanceId = crypto.randomUUID();
  private readonly baseUrl: string;
  private readonly queueFile: string;
  private readonly appVersion: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly locale: string;
  private readonly getAuthToken?: () => string | undefined;
  private enabled: boolean;
  private readonly queue: TelemetryEvent[] = [];
  private readonly suppressed = new Map<string, number>();
  private readonly lastSent = new Map<string, number>();
  private readonly breadcrumbs: Array<{ at: string; stage: string; status?: string; sizes?: Record<string, number> }> = [];
  private readonly activeControllers = new Set<AbortController>();
  private flushTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private flushPromise?: Promise<void>;

  constructor(options: TelemetryClientOptions) {
    this.installId = readOrCreateIdentity(options.storageDirectory).installId;
    this.baseUrl = cleanBaseUrl(options.baseUrl);
    this.queueFile = path.join(options.storageDirectory, "telemetry-events.json");
    this.appVersion = options.appVersion;
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.locale = options.locale || Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
    this.enabled = options.enabled;
    this.getAuthToken = options.getAuthToken;
    if (this.enabled) this.queue.push(...readQueuedEvents(this.queueFile, this.installId, this.instanceId, this.appVersion).slice(-1_000));
    else writeQueuedEvents(this.queueFile, []);
  }

  start(): void {
    if (!this.enabled || !this.baseUrl) return;
    void this.sendHeartbeat();
    void this.flush();
    this.flushTimer = setInterval(() => { void this.flush(); }, 30_000);
    this.flushTimer.unref?.();
    this.scheduleHeartbeat();
  }

  stop(clearQueue = false): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.flushTimer = undefined;
    this.heartbeatTimer = undefined;
    for (const controller of this.activeControllers) controller.abort();
    if (clearQueue) this.queue.length = 0;
    writeQueuedEvents(this.queueFile, this.queue);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.stop(!enabled);
    if (enabled) this.start();
  }

  isEnabled(): boolean { return this.enabled && Boolean(this.baseUrl); }

  addBreadcrumb(event: SessionRuntimeEvent): void {
    if (!this.isEnabled()) return;
    this.breadcrumbs.push(breadcrumb(event));
    if (this.breadcrumbs.length > 50) this.breadcrumbs.splice(0, this.breadcrumbs.length - 50);
  }

  recordFailure(failure: TelemetryFailure): void {
    if (!this.isEnabled()) return;
    const error = asError(failure.error);
    const context = { ...(failure.context || {}) };
    const signature = hash(`${failure.type}|${error.name || ""}|${error.code || ""}|${error.message || ""}`);
    const now = Date.now();
    const last = this.lastSent.get(signature);
    if (last !== undefined && now - last < 10 * 60_000) {
      this.suppressed.set(signature, (this.suppressed.get(signature) || 1) + 1);
      return;
    }
    this.lastSent.set(signature, now);
    const count = (this.suppressed.get(signature) || 0) + 1;
    this.suppressed.delete(signature);
    const event: TelemetryEvent = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: crypto.randomUUID(),
      type: failure.type,
      occurredAt: new Date().toISOString(),
      installId: this.installId,
      instanceId: this.instanceId,
      appVersion: this.appVersion,
      platform: this.platform,
      arch: this.arch,
      locale: this.locale,
      ...(count > 1 ? { count } : {}),
      context: sanitizeContext(context),
      error,
      breadcrumbs: [...this.breadcrumbs]
    };
    this.queue.push(event);
    writeQueuedEvents(this.queueFile, this.queue);
    if (this.queue.length >= TELEMETRY_EVENT_BATCH_LIMIT) void this.flush();
  }

  async uploadDiagnostic(session: SessionData, runtimeEvents: SessionRuntimeEvent[]): Promise<{ bytes: number }> {
    if (!this.isEnabled()) throw new Error("遥测已关闭");
    const payload = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      kind: "session-diagnostic",
      eventId: crypto.randomUUID(),
      installId: this.installId,
      instanceId: this.instanceId,
      appVersion: this.appVersion,
      platform: this.platform,
      arch: this.arch,
      uploadedAt: new Date().toISOString(),
      session: {
        meta: session.meta,
        autoLoadedSkills: session.autoLoadedSkills,
        messages: session.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          stopped: message.stopped,
          toolCalls: message.toolCalls
        }))
      },
      runtime: runtimeEvents.map(redactTraceEvent)
    };
    const raw = Buffer.from(JSON.stringify(payload), "utf8");
    if (raw.length > TELEMETRY_DIAGNOSTIC_RAW_LIMIT) throw new Error("诊断包解压后超过 50 MB 限制");
    const compressed = gzipSync(raw, { level: 6 });
    if (compressed.length > TELEMETRY_DIAGNOSTIC_COMPRESSED_LIMIT) throw new Error("诊断包超过 10 MB 限制");
    await this.post("/telemetry/v1/diagnostics", compressed, { "Content-Type": "application/gzip", "Content-Encoding": "gzip", "X-SecAgent-Diagnostic": "session" });
    return { bytes: compressed.length };
  }

  private scheduleHeartbeat(): void {
    if (!this.isEnabled()) return;
    const jitter = Math.floor(Math.random() * 90_000);
    this.heartbeatTimer = setTimeout(() => {
      void this.sendHeartbeat().finally(() => this.scheduleHeartbeat());
    }, 10 * 60_000 + jitter);
    this.heartbeatTimer.unref?.();
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.isEnabled()) return;
    await this.post("/telemetry/v1/heartbeat", JSON.stringify({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      installId: this.installId,
      instanceId: this.instanceId,
      appVersion: this.appVersion,
      platform: this.platform,
      arch: this.arch,
      locale: this.locale,
      at: new Date().toISOString()
    }), { "Content-Type": "application/json" }).catch(() => undefined);
  }

  private async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushOnce().finally(() => { this.flushPromise = undefined; });
    return this.flushPromise;
  }

  private async flushOnce(): Promise<void> {
    if (!this.isEnabled() || !this.queue.length) return;
    const events = this.queue.splice(0, TELEMETRY_EVENT_BATCH_LIMIT);
    const body = JSON.stringify({ schemaVersion: TELEMETRY_SCHEMA_VERSION, events });
    if (Buffer.byteLength(body) > TELEMETRY_EVENT_BATCH_BYTES) {
      this.queue.unshift(...events.slice(0, Math.max(1, Math.floor(events.length / 2))));
      writeQueuedEvents(this.queueFile, this.queue);
      return;
    }
    writeQueuedEvents(this.queueFile, this.queue);
    await this.post("/telemetry/v1/events", body, { "Content-Type": "application/json" }).catch(() => {
      if (this.enabled) { this.queue.unshift(...events.slice(0, 20)); writeQueuedEvents(this.queueFile, this.queue); }
    });
    writeQueuedEvents(this.queueFile, this.queue);
  }

  private async post(endpoint: string, body: string | Buffer, headers: Record<string, string>): Promise<void> {
    if (!this.baseUrl) return;
    const authorization = this.getAuthToken?.();
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, { method: "POST", body: body as unknown as BodyInit, headers: { ...headers, ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) }, signal: controller.signal });
      if (!response.ok) throw new Error(`telemetry HTTP ${response.status}`);
    } finally { clearTimeout(timer); this.activeControllers.delete(controller); }
  }
}

function readQueuedEvents(file: string, installId: string, instanceId: string, appVersion: string): TelemetryEvent[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((event): event is TelemetryEvent => Boolean(event && typeof event === "object" && (event as TelemetryEvent).installId === installId && typeof (event as TelemetryEvent).eventId === "string" && typeof (event as TelemetryEvent).type === "string"))
      .map((event) => ({ ...event, instanceId: event.instanceId || instanceId, appVersion: event.appVersion || appVersion }));
  } catch { return []; }
}

function writeQueuedEvents(file: string, events: TelemetryEvent[]): void {
  try {
    fs.writeFileSync(file, `${JSON.stringify(events.slice(-1_000))}\n`, { encoding: "utf8", mode: 0o600 });
  } catch { /* Offline persistence is best effort and must not affect the app. */ }
}

function sanitizeContext(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const blocked = /^(text|content|instruction|body|arguments|result|prompt|response|token|apiKey|authorization|cookie|dataUrl)$/i;
  for (const [key, candidate] of Object.entries(value)) {
    if (blocked.test(key)) {
      if (typeof candidate === "string") result[`${key}Length`] = candidate.length;
      else if (candidate !== undefined && candidate !== null) {
        try { result[`${key}Bytes`] = Buffer.byteLength(JSON.stringify(candidate)); } catch { /* Ignore. */ }
      }
      continue;
    }
    if (typeof candidate === "string") result[key] = normalizeMessage(candidate);
    else if (typeof candidate === "number" || typeof candidate === "boolean" || candidate === null) result[key] = candidate;
  }
  return result;
}

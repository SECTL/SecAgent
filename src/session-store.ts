import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface SessionMeta { id: string; title: string; createdAt: string; updatedAt: string }
export interface ToolCallRecord { name: string; arguments: unknown; result?: unknown }
export type AssistantActivity =
  | { kind: "thinking" | "summary" | "answer"; content: string; turn?: number }
  | { kind: "tool"; name: string; arguments: unknown; result?: unknown };
export interface SessionMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string; toolCalls?: ToolCallRecord[]; activities?: AssistantActivity[] }
export interface SessionData { meta: SessionMeta; messages: SessionMessage[] }

export class SessionStore {
  private root: string;
  constructor(workspace: string) {
    this.root = path.join(workspace, "sessions");
    fs.mkdirSync(this.root, { recursive: true });
  }
  list(): SessionMeta[] {
    const index = this.readIndex();
    return index.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  create(title = "新会话"): SessionData {
    const now = new Date().toISOString();
    const meta: SessionMeta = { id: randomUUID(), title, createdAt: now, updatedAt: now };
    const data: SessionData = { meta, messages: [] };
    fs.mkdirSync(this.sessionDir(meta.id), { recursive: true });
    this.writeSession(data);
    this.writeIndex([meta, ...this.readIndex()]);
    return data;
  }
  get(id: string): SessionData {
    const file = path.join(this.sessionDir(id), "session.json");
    if (!fs.existsSync(file)) throw new Error(`会话不存在：${id}`);
    const session = JSON.parse(fs.readFileSync(file, "utf8")) as SessionData;
    if (this.hydrateLegacyToolCalls(session)) this.writeSession(session);
    return session;
  }
  delete(id: string): void {
    const sessions = this.readIndex();
    if (!sessions.some((item) => item.id === id)) throw new Error(`会话不存在：${id}`);
    fs.rmSync(this.sessionDir(id), { recursive: true, force: true });
    this.writeIndex(sessions.filter((item) => item.id !== id));
  }
  appendMessage(id: string, role: SessionMessage["role"], content: string, toolCalls?: ToolCallRecord[], activities?: AssistantActivity[]): SessionData {
    const session = this.get(id);
    const now = new Date().toISOString();
    session.messages.push({ id: randomUUID(), role, content, createdAt: now, ...(toolCalls?.length ? { toolCalls } : {}), ...(activities?.length ? { activities } : {}) });
    session.meta.updatedAt = now;
    if (role === "user" && session.meta.title === "新会话") session.meta.title = content.replace(/\s+/g, " ").slice(0, 28) || "新会话";
    this.writeSession(session);
    this.writeIndex(this.readIndex().map((item) => item.id === id ? session.meta : item));
    return session;
  }
  appendRuntimeEvent(id: string, event: { stage: string; data: unknown }): void {
    const entry = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
    fs.appendFileSync(path.join(this.sessionDir(id), "runtime.jsonl"), entry, "utf8");
  }
  private readIndex(): SessionMeta[] {
    const file = path.join(this.root, "index.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as SessionMeta[] : [];
  }
  private writeIndex(index: SessionMeta[]): void { fs.writeFileSync(path.join(this.root, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8"); }
  private writeSession(session: SessionData): void { fs.writeFileSync(path.join(this.sessionDir(session.meta.id), "session.json"), JSON.stringify(session, null, 2) + "\n", "utf8"); }
  private sessionDir(id: string): string { return path.join(this.root, id); }
  /** Backfill sessions created before tool calls were attached directly to assistant messages. */
  private hydrateLegacyToolCalls(session: SessionData): boolean {
    const log = path.join(this.sessionDir(session.meta.id), "runtime.jsonl");
    if (!fs.existsSync(log)) return false;
    const events = fs.readFileSync(log, "utf8").split("\n").flatMap((line) => {
      try { return line ? [JSON.parse(line) as { stage?: string; data?: unknown }] : []; } catch { return []; }
    });
    let changed = false;
    let assistantIndex = 0;
    let pending: ToolCallRecord[] = [];
    for (const event of events) {
      if (event.stage === "mcp.tools/call") {
        const data = event.data as { name?: unknown; arguments?: unknown };
        if (typeof data.name === "string") pending.push({ name: data.name, arguments: data.arguments ?? {} });
      }
      if (event.stage === "mcp.tools/result") {
        const data = event.data as { name?: unknown; result?: unknown };
        if (typeof data.name === "string") {
          const call = [...pending].reverse().find((item) => item.name === data.name && !("result" in item));
          if (call) call.result = data.result;
        }
      }
      if (event.stage === "assistant.response" || event.stage === "runtime.error") {
        while (assistantIndex < session.messages.length && session.messages[assistantIndex].role !== "assistant") assistantIndex++;
        const assistant = session.messages[assistantIndex];
        if (assistant && !assistant.toolCalls?.length && pending.length) {
          assistant.toolCalls = pending;
          changed = true;
        }
        pending = [];
        assistantIndex++;
      }
    }
    return changed;
  }
}

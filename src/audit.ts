import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuditRecord, PendingAction } from "./types.js";

export class AuditStore {
  private db: DatabaseSync;
  constructor(workspace: string, private redactSensitiveFields = true) {
    fs.mkdirSync(path.join(workspace, "audit"), { recursive: true });
    this.db = new DatabaseSync(path.join(workspace, "audit", "secagent.sqlite"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit_records (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, tool TEXT NOT NULL, request TEXT, params TEXT, result TEXT, confirmation_id TEXT, undo_of TEXT);
      CREATE TABLE IF NOT EXISTS pending_actions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, preview TEXT NOT NULL, consumed_at TEXT);`);
  }
  log(record: { id: string; status: string; tool: string; request?: string; params?: unknown; result?: unknown; confirmationId?: string; undoOf?: string }): void {
    this.db.prepare("INSERT INTO audit_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(record.id, new Date().toISOString(), record.status, record.tool, record.request ?? null, record.params === undefined ? null : JSON.stringify(this.redact(record.params)), record.result === undefined ? null : JSON.stringify(this.redact(record.result)), record.confirmationId ?? null, record.undoOf ?? null);
  }
  private redact(value: unknown): unknown {
    if (!this.redactSensitiveFields || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => this.redact(item));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) =>
      /password|secret|token|api.?key|phone|email/i.test(key) ? [key, "[REDACTED]"] : [key, this.redact(item)]
    ));
  }
  savePending(action: PendingAction): void {
    this.db.prepare("INSERT INTO pending_actions VALUES (?, ?, ?, ?, ?, ?, NULL)").run(action.id, action.createdAt, action.expiresAt, action.action, JSON.stringify(action.payload), JSON.stringify(action.preview));
  }
  consumePending(id: string): PendingAction {
    const row = this.db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!row) throw new Error("确认令牌不存在");
    if (row.consumed_at) throw new Error("确认令牌已经使用，不能重复执行");
    if (new Date(row.expires_at!).getTime() < Date.now()) throw new Error("确认令牌已过期，请重新发起操作");
    this.db.prepare("UPDATE pending_actions SET consumed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return { id: row.id!, action: row.action! as "score.adjust", payload: JSON.parse(row.payload!), preview: JSON.parse(row.preview!), createdAt: row.created_at!, expiresAt: row.expires_at! };
  }
  getRecord(id: string): AuditRecord | undefined {
    const row = this.db.prepare("SELECT * FROM audit_records WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    return row ? { id: row.id!, createdAt: row.created_at!, status: row.status!, tool: row.tool!, request: row.request, params: row.params, result: row.result, confirmationId: row.confirmation_id, undoOf: row.undo_of } : undefined;
  }
  list(limit = 20): AuditRecord[] {
    return (this.db.prepare("SELECT * FROM audit_records ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, string | null>[]).map((row) => ({ id: row.id!, createdAt: row.created_at!, status: row.status!, tool: row.tool!, request: row.request, params: row.params, result: row.result, confirmationId: row.confirmation_id, undoOf: row.undo_of }));
  }
  close(): void { this.db.close(); }
}

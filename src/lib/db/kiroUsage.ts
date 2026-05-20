import { getDbInstance } from "./core";

export interface KiroUsageRow {
  id?: number;
  timestamp: string;
  connection_id?: string | null;
  conversation_id?: string | null;
  provider?: string | null;
  model?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  raw?: string | null;
}

let ensured: unknown = null;
function ensureTable() {
  const db = getDbInstance();
  if (ensured === db) return;
  db.exec(
    `
    CREATE TABLE IF NOT EXISTS kiro_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      connection_id TEXT,
      conversation_id TEXT,
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      raw TEXT
    )
  `
  );
  ensured = db;
}

export function insertKiroUsageRow(row: KiroUsageRow): void {
  const db = getDbInstance();
  ensureTable();
  db.prepare(
    `
    INSERT INTO kiro_usage (
      timestamp, connection_id, conversation_id, provider, model,
      prompt_tokens, completion_tokens, total_tokens, raw
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    row.timestamp,
    row.connection_id ?? null,
    row.conversation_id ?? null,
    row.provider ?? null,
    row.model ?? null,
    row.prompt_tokens ?? null,
    row.completion_tokens ?? null,
    row.total_tokens ?? null,
    row.raw ?? null
  );
}

export default { insertKiroUsageRow };

/**
 * 持久化存储（SQLite，零依赖）。
 *
 * 采用**事件溯源**：Agent 运行的每一个事件都被追加写入，运行结束后再物化一份结果快照。
 * 这样做的关键收益是**可恢复性** —— 进程崩溃、机器重启后，可以从事件流重建现场，
 * 而不是让用户从头再烧一遍 token。这也是长时间运行的 Agent 从「玩具」走向「生产」的分水岭。
 *
 * 存储实现直接复用 Node 22 内置的 `node:sqlite`（基于成熟 SQLite），
 * 不引入任何原生依赖 —— 安装即用，不需要 node-gyp 编译。
 */

import { createRequire } from "node:module";

import type { Message } from "../models/types.js";
import type { RunResult } from "../agent/types.js";

/**
 * 惰性加载 Node 内置的 node:sqlite。
 *
 * 为什么用 createRequire 而不是静态 import：部分打包器（esbuild）的内置模块清单
 * 尚未收录 `node:sqlite`，静态 import 会被错误重写为 `require("sqlite")` 导致
 * 运行时 MODULE_NOT_FOUND。运行时按字符串加载可以完全绕开打包器的静态分析。
 */
interface StatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

const nodeRequire = createRequire(`${process.cwd()}/`);

function openDatabase(path: string): DatabaseLike {
  const sqlite = nodeRequire("node:sqlite") as {
    DatabaseSync: new (location: string) => DatabaseLike;
  };
  if (typeof sqlite?.DatabaseSync !== "function") {
    throw new Error(
      "node:sqlite is unavailable. AetherFlow requires Node.js >= 22.5.0 for the event store.",
    );
  }
  return new sqlite.DatabaseSync(path);
}

export interface StoredEvent {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly ts: number;
}

export interface RunRecord {
  readonly runId: string;
  readonly agentName: string;
  readonly startedAt: number;
  readonly finishedAt: number | undefined;
  readonly finishReason: string | undefined;
  readonly result: RunResult<unknown> | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  agent_name    TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  finish_reason TEXT,
  steps         INTEGER DEFAULT 0,
  cost_usd      REAL DEFAULT 0,
  result        TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  type    TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  payload TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  messages   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_unfinished ON runs(finished_at);
`;

export interface EventStoreOptions {
  /** 数据库文件路径；默认为内存库（用于测试）。 */
  readonly path?: string;
  /** 是否开启 WAL（提升并发写入性能）。仅对文件库生效。 */
  readonly wal?: boolean;
}

export class EventStore {
  private readonly db: DatabaseLike;
  private readonly counters = new Map<string, number>();

  constructor(options: EventStoreOptions = {}) {
    this.db = openDatabase(options.path ?? ":memory:");
    this.db.exec(SCHEMA);
    if (options.path && options.wal !== false) {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec("PRAGMA synchronous = NORMAL;");
  }

  /** 追加一个事件。seq 由存储自动递增，保证同一 run 内全序。 */
  append(runId: string, type: string, payload: unknown): number {
    const seq = (this.counters.get(runId) ?? 0) + 1;
    this.counters.set(runId, seq);
    this.db
      .prepare("INSERT INTO events (run_id, seq, type, ts, payload) VALUES (?, ?, ?, ?, ?)")
      .run(runId, seq, type, Date.now(), safeStringify(payload));
    if (type === "run_start") {
      const agentName =
        typeof payload === "object" && payload !== null && "agentName" in payload
          ? String((payload as { agentName: unknown }).agentName)
          : "unknown";
      this.db
        .prepare("INSERT OR REPLACE INTO runs (run_id, agent_name, started_at) VALUES (?, ?, ?)")
        .run(runId, agentName, Date.now());
    }
    return seq;
  }

  /** 读取某个 run 的全部事件（按 seq 升序）。 */
  events(runId: string): readonly StoredEvent[] {
    const rows = this.db
      .prepare("SELECT seq, type, ts, payload FROM events WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as Array<{ seq: number; type: string; ts: number; payload: string | null }>;
    return rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      ts: row.ts,
      payload: row.payload ? safeParse(row.payload) : null,
    }));
  }

  /** 物化运行结果快照。 */
  saveResult(runId: string, result: RunResult<unknown>): void {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, finish_reason = ?, steps = ?, cost_usd = ?, result = ?
         WHERE run_id = ?`,
      )
      .run(
        Date.now(),
        result.finishReason,
        result.steps,
        result.costUsd,
        safeStringify(result),
        runId,
      );
  }

  loadResult(runId: string): RunResult<unknown> | undefined {
    const row = this.db
      .prepare("SELECT result FROM runs WHERE run_id = ?")
      .get(runId) as { result: string | null } | undefined;
    if (!row?.result) return undefined;
    return safeParse(row.result) as RunResult<unknown>;
  }

  /** 列出未正常结束的 run —— 崩溃恢复的入口。 */
  listUnfinishedRuns(olderThanMs = 0): readonly string[] {
    const cutoff = Date.now() - olderThanMs;
    const rows = this.db
      .prepare("SELECT run_id FROM runs WHERE finished_at IS NULL AND started_at <= ?")
      .all(cutoff) as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  record(runId: string): RunRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT run_id, agent_name, started_at, finished_at, finish_reason, result FROM runs WHERE run_id = ?",
      )
      .get(runId) as
      | {
          run_id: string;
          agent_name: string;
          started_at: number;
          finished_at: number | null;
          finish_reason: string | null;
          result: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id,
      agentName: row.agent_name,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      finishReason: row.finish_reason ?? undefined,
      result: row.result ? (safeParse(row.result) as RunResult<unknown>) : undefined,
    };
  }

  /** 保存会话消息，用于多轮对话续接。 */
  saveSession(sessionId: string, messages: readonly Message[]): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, messages, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
      )
      .run(sessionId, safeStringify(messages), Date.now());
  }

  loadSession(sessionId: string): readonly Message[] {
    const row = this.db.prepare("SELECT messages FROM sessions WHERE session_id = ?").get(sessionId) as
      | { messages: string }
      | undefined;
    if (!row) return [];
    return safeParse(row.messages) as Message[];
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 把 Agent 事件流接入存储：实时落盘 + 结束时物化快照。
 * 注意这里用 tee 语义等价的「边消费边写」方式：事件既向下游传递，也被持久化。
 */
export async function persistRun(
  store: EventStore,
  runId: string,
  events: AsyncIterable<{ readonly type: string }>,
): Promise<void> {
  for await (const event of events) {
    store.append(runId, event.type, event);
    if (event.type === "run_end") {
      const result = (event as unknown as { result: RunResult<unknown> }).result;
      store.saveResult(runId, result);
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  rename,
  readdir,
  stat,
  copyFile,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { HarnessPaths } from "@harness/core";

/* ─── Types ─── */

export interface SessionTokenTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  costTotal?: number;
}

export interface SessionTurnTokens {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionTurnCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionTurnToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface SessionTurnToolResult {
  toolCallId: string;
  name: string;
  result: string;
  isError: boolean;
}

export interface SessionTurnTiming {
  startedAt: string;
  latencyMs: number;
}

export interface SessionTurn {
  id: string;
  /** A persisted completed turn represents the assistant response role. */
  role: "assistant";
  /** Final assistant text content. */
  content: string;
  /** The user message that triggered this turn. */
  userContent: string;
  /** Tool calls made by the assistant in this turn. */
  tool_calls?: SessionTurnToolCall[];
  /** Tool results for this turn. */
  tool_results?: SessionTurnToolResult[];
  /** Token usage for the whole turn. */
  tokens: SessionTurnTokens;
  /** Optional cost estimate (in currency units) for the turn. */
  cost?: SessionTurnCost;
  /** Timing metadata. */
  timing: SessionTurnTiming;
  /** Model identifier used for this turn. */
  model: string;
  /** ISO timestamp when the turn was persisted. */
  timestamp: string;
  /**
   * Full message slice for this turn (user + assistant + tool results).
   * Stored to enable exact resume of the conversation context.
   */
  messages?: Message[];
}

export type SessionStatus = "active" | "idle" | "suspended" | "ended";

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  model: string;
  tokenTotals: SessionTokenTotals;
  parentSessionId?: string;
  transcriptPath: string;
  status: SessionStatus;
  /** ISO timestamp when the session was explicitly ended. Absent for active/idle/suspended. */
  endedAt?: string;
  /** Agent profile the session runs under. Absent for pre-profile sessions (treated as "default"). */
  profile?: string;
}

export interface SessionIndexEntry {
  sessionId: string;
  created: string;
  lastActivity: string;
  model: string;
  tokenTotals: SessionTokenTotals;
  parentSessionId?: string;
  title: string;
  status: SessionStatus;
  /** ISO timestamp when the session was explicitly ended. Absent for active/idle/suspended. */
  endedAt?: string;
  /** Agent profile the session runs under. Absent for pre-profile sessions (treated as "default"). */
  profile?: string;
}

interface SessionIndexLoadResult {
  entries: SessionIndexEntry[];
  /** True when the index file is missing or structurally invalid. */
  corrupt: boolean;
}

/** Marker appended to the transcript when a session is explicitly ended. */
export interface SessionEndMarker {
  type: "session-end";
  endedAt: string;
}

/** Session metadata record stored at the start of a transcript. */
export interface SessionMetaRecord {
  type: "session-meta";
  title: string;
  updatedAt: string;
}

export interface CreateSessionOptions {
  model: string;
  title?: string;
  parentSessionId?: string;
  /** Agent profile name — persisted so resume restores the same profile. */
  profile?: string;
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ListSessionsRange {
  /** Inclusive ISO date/time lower bound. */
  from?: string;
  /** Inclusive ISO date/time upper bound. */
  to?: string;
}

/* ─── Token thresholds ─── */

/**
 * Sessions whose reconstructed message history is estimated above this
 * threshold require explicit user confirmation before being resumed.
 */
export const SESSION_LOAD_WARN_THRESHOLD = 50_000;

/**
 * Sessions below this threshold are loaded without any confirmation prompt.
 */
export const SESSION_LOAD_SILENT_MAX = 30_000;

/* ─── Logging seam ─── */

/** Single internal warning sink. Replace here if session.ts ever gets a logger. */
function warn(message: string, context?: Record<string, unknown>): void {
  console.warn(`[session] ${message}`, context ?? "");
}

/* ─── Paths ─── */

function sessionDateFromId(sessionId: string): string {
  const match = sessionId.match(/^(\d{4})(\d{2})(\d{2})T/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return new Date().toISOString().slice(0, 10);
}

function sessionTranscriptPath(paths: HarnessPaths, sessionId: string): string {
  return join(
    paths.sessions,
    sessionDateFromId(sessionId),
    `${sessionId}.jsonl`,
  );
}

function legacySessionTranscriptPath(
  paths: HarnessPaths,
  sessionId: string,
): string {
  return join(paths.sessions, `${sessionId}.jsonl`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the transcript path for a session id.
 * Prefers the dated layout (`YYYY-MM-DD/{id}.jsonl`), falls back to the
 * legacy flat layout (`{id}.jsonl`), and finally scans all dated folders.
 */
async function findTranscriptPath(
  paths: HarnessPaths,
  sessionId: string,
): Promise<string | undefined> {
  const dated = sessionTranscriptPath(paths, sessionId);
  if (await fileExists(dated)) return dated;

  const legacy = legacySessionTranscriptPath(paths, sessionId);
  if (await fileExists(legacy)) return legacy;

  try {
    const entries = await readdir(paths.sessions, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(paths.sessions, entry.name, `${sessionId}.jsonl`);
      if (await fileExists(candidate)) return candidate;
    }
  } catch {
    // Directory may not exist yet.
  }

  return undefined;
}

function sessionsIndexPath(paths: HarnessPaths): string {
  return join(paths.sessions, "sessions.json");
}

/* ─── ID Generation ─── */

/**
 * Generates a sortable, human-readable session id: `<timestamp>-<shortuuid>`.
 * Example: `20260625T163720-abc123`
 */
export function createSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const shortUuid = randomUUID().slice(0, 6);
  return `${timestamp}-${shortUuid}`;
}

/* ─── Cost Calculation ─── */

export function calculateTurnCost(
  tokens: SessionTurnTokens,
  costPer1M?: ModelCost
): SessionTurnCost | undefined {
  if (!costPer1M) return undefined;
  const input = (tokens.input / 1_000_000) * costPer1M.input;
  const output = (tokens.output / 1_000_000) * costPer1M.output;
  const cacheRead = (tokens.cacheRead / 1_000_000) * costPer1M.cacheRead;
  const cacheWrite = (tokens.cacheWrite / 1_000_000) * costPer1M.cacheWrite;
  const total = input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

function addCost(
  totals: SessionTokenTotals,
  cost: SessionTurnCost
): SessionTokenTotals {
  return {
    ...totals,
    costInput: (totals.costInput ?? 0) + cost.input,
    costOutput: (totals.costOutput ?? 0) + cost.output,
    costCacheRead: (totals.costCacheRead ?? 0) + cost.cacheRead,
    costCacheWrite: (totals.costCacheWrite ?? 0) + cost.cacheWrite,
    costTotal: (totals.costTotal ?? 0) + cost.total,
  };
}

/* ─── Index Management ─── */

// Serializes read-modify-write cycles on the sessions index PER sessions
// directory. Turns on DIFFERENT sessions run in parallel (per-session turn
// queues), so concurrent upsertIndexEntry calls would otherwise interleave
// load → modify → save and silently lose each other's updates.
// The queue is keyed by the resolved sessions path so trailing slashes,
// relative paths, or symlinks pointing to the same directory share one queue.
const indexUpdateQueues = new Map<string, Promise<void>>();

function normalizeSessionsDir(sessionsDir: string): string {
  return resolve(sessionsDir);
}

function getIndexQueue(sessionsDir: string): Promise<void> {
  const key = normalizeSessionsDir(sessionsDir);
  if (!indexUpdateQueues.has(key)) {
    indexUpdateQueues.set(key, Promise.resolve());
  }
  return indexUpdateQueues.get(key)!;
}

function setIndexQueue(sessionsDir: string, queue: Promise<void>): void {
  indexUpdateQueues.set(normalizeSessionsDir(sessionsDir), queue);
}

function isValidIndexEntry(item: unknown): item is SessionIndexEntry {
  if (item === null || typeof item !== "object") return false;
  const e = item as Record<string, unknown>;
  return (
    typeof e.sessionId === "string" &&
    typeof e.created === "string" &&
    typeof e.lastActivity === "string" &&
    typeof e.model === "string" &&
    typeof e.title === "string" &&
    typeof e.status === "string" &&
    e.tokenTotals !== null &&
    typeof e.tokenTotals === "object"
  );
}

async function loadIndex(paths: HarnessPaths): Promise<SessionIndexLoadResult> {
  const idxPath = sessionsIndexPath(paths);
  let raw: string;
  try {
    raw = await readFile(idxPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Fresh installation: no index file yet. Not corrupt.
      return { entries: [], corrupt: false };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], corrupt: true };
  }

  if (!Array.isArray(parsed)) {
    return { entries: [], corrupt: true };
  }

  const entries: SessionIndexEntry[] = [];
  let corrupt = false;
  for (const item of parsed) {
    if (isValidIndexEntry(item)) {
      entries.push(item);
    } else {
      corrupt = true;
      warn("Skipping corrupt sessions.json entry", { item });
    }
  }

  return { entries, corrupt };
}

async function saveIndex(
  paths: HarnessPaths,
  index: SessionIndexEntry[]
): Promise<void> {
  await mkdir(paths.sessions, { recursive: true });
  // Unique tmp name: two harness processes sharing $HARNESS_STATE must
  // not clobber each other's tmp file (rename would fail with ENOENT).
  const tmpPath = `${sessionsIndexPath(paths)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  await rename(tmpPath, sessionsIndexPath(paths));
}

async function backupCorruptIndex(paths: HarnessPaths): Promise<void> {
  const idxPath = sessionsIndexPath(paths);
  const backupPath = `${idxPath}.corrupt-${Date.now()}`;
  try {
    await copyFile(idxPath, backupPath);
  } catch (err) {
    warn("Failed to backup corrupt sessions index", { idxPath, error: err });
  }
}

async function upsertIndexEntry(
  paths: HarnessPaths,
  entry: SessionIndexEntry
): Promise<void> {
  const queue = getIndexQueue(paths.sessions);
  const op = queue.then(async () => {
    const { entries: index } = await loadIndex(paths);
    const idx = index.findIndex((e) => e.sessionId === entry.sessionId);
    if (idx === -1) {
      index.push(entry);
    } else {
      index[idx] = entry;
    }
    await saveIndex(paths, index);
  });
  // Keep the queue alive even when this update failed.
  setIndexQueue(paths.sessions, op.catch(() => {}));
  return op;
}

function sessionToIndexEntry(session: Session): SessionIndexEntry {
  return {
    sessionId: session.id,
    created: session.createdAt,
    lastActivity: session.lastActivityAt,
    model: session.model,
    tokenTotals: session.tokenTotals,
    parentSessionId: session.parentSessionId,
    title: session.title,
    status: session.status,
    endedAt: session.endedAt,
    profile: session.profile,
  };
}

/* ─── Session Lifecycle ─── */

export async function createSession(
  paths: HarnessPaths,
  options: CreateSessionOptions
): Promise<Session> {
  const id = createSessionId();
  const now = new Date().toISOString();
  const title =
    options.title ??
    (options.parentSessionId
      ? `Sub-Agent Session from ${options.parentSessionId}`
      : "CLI Session");

  const transcriptPath = sessionTranscriptPath(paths, id);

  const session: Session = {
    id,
    title,
    createdAt: now,
    lastActivityAt: now,
    model: options.model,
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    parentSessionId: options.parentSessionId,
    transcriptPath,
    status: "active",
    profile: options.profile,
  };

  await mkdir(dirname(transcriptPath), { recursive: true });
  const meta: SessionMetaRecord = { type: "session-meta", title, updatedAt: now };
  await writeFile(session.transcriptPath, JSON.stringify(meta) + "\n", "utf-8");
  await upsertIndexEntry(paths, sessionToIndexEntry(session));

  return session;
}

export async function createSubAgentSession(
  parentSessionId: string,
  paths: HarnessPaths,
  model: string
): Promise<Session> {
  return createSession(paths, {
    model,
    parentSessionId,
    title: `Sub-Agent Session from ${parentSessionId}`,
  });
}

export async function endSession(
  session: Session,
  paths: HarnessPaths
): Promise<Session> {
  const endedAt = new Date().toISOString();
  // Write end marker to transcript so the boundary is visible without the index.
  const marker: SessionEndMarker = { type: "session-end", endedAt };
  await appendFile(session.transcriptPath, JSON.stringify(marker) + "\n", "utf-8");

  const ended: Session = { ...session, status: "ended", endedAt };
  await upsertIndexEntry(paths, sessionToIndexEntry(ended));
  return ended;
}

/**
 * Suspends a session: marks it as "suspended" in the index without
 * writing an end marker. Used on daemon shutdown — suspended sessions
 * are resumable, unlike explicitly ended sessions.
 */
export async function suspendSession(
  session: Session,
  paths: HarnessPaths
): Promise<Session> {
  const suspended: Session = { ...session, status: "suspended" };
  await upsertIndexEntry(paths, sessionToIndexEntry(suspended));
  return suspended;
}

export interface DeleteSessionOptions {
  /** If true, permanently removes the transcript file. Default is soft-delete. */
  permanent?: boolean;
}

/**
 * Renames a session by writing a new meta-record to the transcript and
 * updating the index entry. The title survives an index rebuild because it
 * is stored in the transcript itself.
 */
export async function renameSession(
  session: Session,
  newTitle: string,
  paths: HarnessPaths
): Promise<Session> {
  const updatedAt = new Date().toISOString();
  const meta: SessionMetaRecord = { type: "session-meta", title: newTitle, updatedAt };
  await appendFile(session.transcriptPath, JSON.stringify(meta) + "\n", "utf-8");

  const renamed: Session = { ...session, title: newTitle };
  await upsertIndexEntry(paths, sessionToIndexEntry(renamed));
  return renamed;
}

/**
 * Deletes a session. By default the transcript is moved to the `deleted/`
 * subdirectory and the index entry is removed. Pass `{ permanent: true }` to
 * remove the transcript file entirely.
 */
export async function deleteSession(
  sessionId: string,
  paths: HarnessPaths,
  options?: DeleteSessionOptions
): Promise<void> {
  const tPath = await findTranscriptPath(paths, sessionId);

  if (tPath) {
    if (options?.permanent) {
      await unlink(tPath);
    } else {
      const deletedDir = join(paths.sessions, "deleted");
      await mkdir(deletedDir, { recursive: true });
      const fileName = basename(tPath);
      let destPath = join(deletedDir, fileName);
      if (await fileExists(destPath)) {
        const ext = ".jsonl";
        const base = fileName.slice(0, -ext.length);
        destPath = join(deletedDir, `${base}.${Date.now()}${ext}`);
      }
      await rename(tPath, destPath);
    }
  }

  // Remove from index
  const queue = getIndexQueue(paths.sessions);
  const op = queue.then(async () => {
    const { entries: index } = await loadIndex(paths);
    const filtered = index.filter((e) => e.sessionId !== sessionId);
    await saveIndex(paths, filtered);
  });
  setIndexQueue(paths.sessions, op.catch(() => {}));
  await op;
}

/**
 * Marks all sessions currently in "active" status as "idle".
 * Called on daemon start to clean up orphaned active markers from
 * a crash or unclean shutdown. "active" = in-memory only; anything
 * not loaded in the daemon is "idle" (crashed, resumable),
 * "suspended" (graceful shutdown, resumable), or "ended" (explicitly stopped).
 */
export async function markActiveSessionsIdle(paths: HarnessPaths): Promise<number> {
  const { entries: index } = await loadIndex(paths);
  let changed = 0;
  for (const entry of index) {
    if (entry.status === "active") {
      entry.status = "idle";
      changed++;
    }
  }
  if (changed > 0) {
    await saveIndex(paths, index);
  }
  return changed;
}

/* ─── Turn Recording ─── */

export async function recordTurn(
  session: Session,
  turn: SessionTurn,
  paths: HarnessPaths
): Promise<Session> {
  // 1. Append turn to transcript first (source of truth).
  const line = JSON.stringify(turn) + "\n";
  await appendFile(session.transcriptPath, line, "utf-8");

  // 2. Update in-memory totals.
  let tokenTotals: SessionTokenTotals = {
    inputTokens: session.tokenTotals.inputTokens + turn.tokens.input,
    outputTokens: session.tokenTotals.outputTokens + turn.tokens.output,
    totalTokens: session.tokenTotals.totalTokens + turn.tokens.total,
    cacheRead: session.tokenTotals.cacheRead + turn.tokens.cacheRead,
    cacheWrite: session.tokenTotals.cacheWrite + turn.tokens.cacheWrite,
  };
  if (turn.cost) {
    tokenTotals = addCost(tokenTotals, turn.cost);
  }

  const updated: Session = {
    ...session,
    lastActivityAt: turn.timestamp,
    tokenTotals,
  };

  // 3. Update lightweight index.
  await upsertIndexEntry(paths, sessionToIndexEntry(updated));

  return updated;
}

/* ─── Tool Data Extraction ─── */

/**
 * Extracts structured `tool_calls` and `tool_results` from a message slice
 * produced by the agent loop. Called by both `DaemonRuntime` and
 * `InProcessBackend` to populate the corresponding `SessionTurn` fields
 * without duplicating extraction logic.
 *
 * - `tool_calls` are collected from `toolCall` content blocks on assistant messages.
 * - `tool_results` are collected from `toolResult`-role messages.
 */
export function extractToolData(messages: Message[]): {
  tool_calls: SessionTurnToolCall[];
  tool_results: SessionTurnToolResult[];
} {
  const tool_calls: SessionTurnToolCall[] = [];
  const tool_results: SessionTurnToolResult[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === "object" && (part as { type?: string }).type === "toolCall") {
          const tc = part as { id: string; name: string; arguments: unknown };
          tool_calls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
        }
      }
    } else if (msg.role === "toolResult") {
      const tr = msg as {
        toolCallId: string;
        toolName: string;
        content: Array<{ type: string; text?: string }>;
        isError: boolean;
      };
      const resultText = (tr.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      tool_results.push({
        toolCallId: tr.toolCallId,
        name: tr.toolName,
        result: resultText,
        isError: tr.isError,
      });
    }
  }

  return { tool_calls, tool_results };
}

/* ─── Read API ─── */

/**
 * Reads turns and the latest title from a JSONL transcript.
 * Skips end markers, meta records, and corrupt lines.
 */
async function readTranscript(
  tPath: string
): Promise<{ turns: SessionTurn[]; title?: string }> {
  let raw: string;
  try {
    raw = await readFile(tPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { turns: [] };
    throw err;
  }

  const turns: SessionTurn[] = [];
  let title: string | undefined;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        title?: string;
      } & SessionTurn;
      // Skip end-marker and meta-record lines — they are not turns.
      if (parsed.type === "session-end") continue;
      if (parsed.type === "session-meta") {
        if (typeof parsed.title === "string") {
          title = parsed.title;
        }
        continue;
      }
      turns.push(parsed as SessionTurn);
    } catch {
      // Skip corrupt lines silently.
    }
  }
  return { turns, title };
}

/**
 * Rebuilds a `SessionIndexEntry` from transcript data when the session is
 * missing from the index file. Uses the first and last turns to derive
 * `created`/`lastActivity`/`model` and reconstructs token totals from all
 * turns. Falls back to epoch timestamps when no turns exist.
 */
function reconstructIndexEntry(
  sessionId: string,
  turns: SessionTurn[],
  title?: string
): SessionIndexEntry {
  const totals: SessionTokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let lastActivity = "";
  let model = "unknown";
  for (const turn of turns) {
    totals.inputTokens += turn.tokens.input;
    totals.outputTokens += turn.tokens.output;
    totals.totalTokens += turn.tokens.total;
    totals.cacheRead += turn.tokens.cacheRead;
    totals.cacheWrite += turn.tokens.cacheWrite;
    if (turn.cost) {
      totals.costInput = (totals.costInput ?? 0) + turn.cost.input;
      totals.costOutput = (totals.costOutput ?? 0) + turn.cost.output;
      totals.costCacheRead = (totals.costCacheRead ?? 0) + turn.cost.cacheRead;
      totals.costCacheWrite = (totals.costCacheWrite ?? 0) + turn.cost.cacheWrite;
      totals.costTotal = (totals.costTotal ?? 0) + turn.cost.total;
    }
    if (!lastActivity) lastActivity = turn.timing?.startedAt ?? turn.timestamp;
    const stamp = turn.timestamp;
    if (stamp > lastActivity) lastActivity = stamp;
    if (turn.model) model = turn.model;
  }
  if (!lastActivity) {
    // No turns: fall back to epoch timestamps when the transcript is empty.
    lastActivity = new Date(0).toISOString();
  }
  const created = turns[0]?.timing?.startedAt
    ?? turns[0]?.timestamp
    ?? lastActivity;
  return {
    sessionId,
    created,
    lastActivity,
    model,
    tokenTotals: totals,
    title: title ?? `Recovered Session ${sessionId.slice(-6)}`,
    status: "idle",
  };
}

/**
 * Scans the sessions directory for transcript files and rebuilds index entries.
 * Checks dated folders first, then legacy flat files.
 */
async function reconstructSessionsFromTranscripts(
  paths: HarnessPaths
): Promise<SessionIndexEntry[]> {
  const entries = new Map<string, SessionIndexEntry>();

  try {
    const dirEntries = await readdir(paths.sessions, { withFileTypes: true });

    // 1. Dated folders: YYYY-MM-DD/<id>.jsonl
    for (const dirEntry of dirEntries) {
      if (!dirEntry.isDirectory()) continue;
      const dateDir = join(paths.sessions, dirEntry.name);
      let files: string[];
      try {
        files = await readdir(dateDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = file.slice(0, -".jsonl".length);
        const tPath = join(dateDir, file);
        const { turns, title } = await readTranscript(tPath);
        entries.set(sessionId, reconstructIndexEntry(sessionId, turns, title));
      }
    }

    // 2. Legacy flat transcripts: <id>.jsonl directly in sessions root
    for (const file of dirEntries) {
      if (!file.isFile()) continue;
      if (!file.name.endsWith(".jsonl")) continue;
      const sessionId = file.name.slice(0, -".jsonl".length);
      const tPath = join(paths.sessions, file.name);
      const { turns, title } = await readTranscript(tPath);
      entries.set(sessionId, reconstructIndexEntry(sessionId, turns, title));
    }
  } catch {
    // Directory may not exist yet.
  }

  return [...entries.values()];
}

/**
 * Loads a session's index entry and all turns from disk.
 *
 * Reads the JSONL transcript file, skipping `session-end` markers.
 * Returns `null` if the session is not in the index or the transcript
 * file does not exist.
 *
 * @param sessionId  The session id to load.
 * @param paths      Harness paths (resolves `$HARNESS_STATE`).
 * @returns `{ session, turns }` or `null` if not found.
 */
export async function readSession(
  sessionId: string,
  paths: HarnessPaths
): Promise<{ session: SessionIndexEntry; turns: SessionTurn[] } | null> {
  const { entries: index } = await loadIndex(paths);
  let entry = index.find((e) => e.sessionId === sessionId);

  const tPath = await findTranscriptPath(paths, sessionId);
  if (!tPath) return null;

  const { turns, title } = await readTranscript(tPath);

  // Fallback: if the session is not in the index (e.g. the index file is
  // corrupt or the entry was lost), reconstruct a minimal index entry from
  // the transcript so the session remains visible.
  if (!entry) {
    entry = reconstructIndexEntry(sessionId, turns, title);
  }

  return { session: entry, turns };
}

/**
 * Counts turns in a session's transcript by counting non-empty JSONL lines.
 * Faster than readSession for listing, since no JSON parsing is needed.
 */
export async function countTurnsInTranscript(
  sessionId: string,
  paths: HarnessPaths
): Promise<number> {
  const tPath = await findTranscriptPath(paths, sessionId);
  if (!tPath) return 0;
  try {
    const raw = await readFile(tPath, "utf-8");
    return raw.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        const parsed = JSON.parse(trimmed) as { type?: string };
        // Skip structural records; only count actual turns.
        if (parsed.type === "session-end" || parsed.type === "session-meta") {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    }).length;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    throw err;
  }
}

/**
 * Lists all sessions from the index, optionally filtered by `lastActivity`
 * range.
 *
 * The filter uses `lastActivity` (the timestamp of the most recent turn),
 * not `createdAt`, so that a session started on a previous day but active
 * today is included in a "today" range.
 *
 * If the index file is corrupt, it is backed up and rebuilt from transcripts
 * so sessions remain visible. A missing or empty index is treated as a fresh
 * installation and does not trigger a full transcript scan.
 *
 * @param paths  Harness paths.
 * @param range  Optional `{ from?, to? }` inclusive ISO date/time bounds on `lastActivity`.
 */
export async function listSessions(
  paths: HarnessPaths,
  range?: ListSessionsRange
): Promise<SessionIndexEntry[]> {
  const { entries: index, corrupt } = await loadIndex(paths);

  let sessions = index;
  if (corrupt) {
    warn("Sessions index is corrupt; backing up and rebuilding from transcripts", {
      sessionsDir: paths.sessions,
    });
    await backupCorruptIndex(paths);
    const reconstructed = await reconstructSessionsFromTranscripts(paths);
    const byId = new Map(index.map((e) => [e.sessionId, e]));
    for (const rec of reconstructed) {
      if (!byId.has(rec.sessionId)) {
        byId.set(rec.sessionId, rec);
      }
    }
    sessions = [...byId.values()];
    await saveIndex(paths, sessions);
  }

  if (!range) return sessions;

  return sessions.filter((entry) => {
    if (range.from && entry.lastActivity < range.from) return false;
    if (range.to && entry.lastActivity > range.to) return false;
    return true;
  });
}

export interface SessionListDetail extends SessionIndexEntry {
  turnCount: number;
  tokenEstimate: number;
}

export async function listSessionsWithDetails(
  paths: HarnessPaths,
  range?: ListSessionsRange
): Promise<SessionListDetail[]> {
  const index = await listSessions(paths, range);
  const details: SessionListDetail[] = [];
  for (const entry of index) {
    const loaded = await readSession(entry.sessionId, paths);
    const turns = loaded?.turns ?? [];
    details.push({
      ...entry,
      turnCount: turns.length,
      tokenEstimate: estimateContextTokens(turnsToMessages(turns)),
    });
  }
  return details;
}

/* ─── Resume Helper ─── */

/**
 * Normalizes assistant message content to a content-block array.
 * Older persisted turns may have string content — pi-ai's transformMessages
 * expects an array and calls `.flatMap()` on it.
 */
function normalizeAssistantContent(content: unknown): Array<{ type: string; text: string }> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) return content as Array<{ type: string; text: string }>;
  return [{ type: "text", text: "" }];
}

/**
 * Reconstructs the LLM-visible message context from a list of persisted turns.
 * Falls back to synthesized user/assistant messages if `messages` was not stored.
 * Normalizes string content on assistant messages to content-block arrays
 * so pi-ai's transformMessages (which calls `.flatMap`) doesn't crash.
 */
export function turnsToMessages(turns: SessionTurn[]): Message[] {
  const messages: Message[] = [];
  for (const turn of turns) {
    if (turn.messages && turn.messages.length > 0) {
      // Normalize any assistant messages with string content from old data.
      for (const msg of turn.messages) {
        if (msg.role === "assistant" && typeof msg.content === "string") {
          (msg as unknown as { content: unknown }).content = normalizeAssistantContent(msg.content);
        }
      }
      messages.push(...turn.messages);
      continue;
    }

    messages.push({
      role: "user",
      content: turn.userContent,
      timestamp: new Date(turn.timing.startedAt).getTime(),
    } as Message);

    if (turn.content || (turn.tool_calls && turn.tool_calls.length > 0)) {
      messages.push({
        role: "assistant",
        content: normalizeAssistantContent(turn.content),
        timestamp: new Date(turn.timestamp).getTime(),
      } as unknown as Message);
    }
  }
  return messages;
}

/**
 * Rough token estimate for a reconstructed message history.
 * Uses ~4 characters per token plus a small per-message overhead.
 */
export function estimateContextTokens(messages: Message[]): number {
  const CHARS_PER_TOKEN = 4;
  const MESSAGE_OVERHEAD = 3;

  let total = 0;
  for (const msg of messages) {
    if (!msg) continue;

    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          text += part.text;
        } else {
          text += JSON.stringify(part);
        }
      }
    } else {
      text = JSON.stringify(msg);
    }

    total += MESSAGE_OVERHEAD + Math.ceil(text.length / CHARS_PER_TOKEN);
  }
  return total;
}

/**
 * Loads a session ready for resume, including the reconstructed message history
 * and a token estimate for confirmation prompts.
 */
export async function loadSession(
  sessionId: string,
  paths: HarnessPaths
): Promise<{ session: Session; turns: SessionTurn[]; tokenEstimate: number } | null> {
  const loaded = await readSession(sessionId, paths);
  if (!loaded) return null;

  const transcriptPath =
    (await findTranscriptPath(paths, sessionId)) ??
    sessionTranscriptPath(paths, sessionId);

  const session: Session = {
    id: loaded.session.sessionId,
    title: loaded.session.title,
    createdAt: loaded.session.created,
    lastActivityAt: loaded.session.lastActivity,
    model: loaded.session.model,
    tokenTotals: loaded.session.tokenTotals,
    parentSessionId: loaded.session.parentSessionId,
    transcriptPath,
    status: loaded.session.status,
    endedAt: loaded.session.endedAt,
    profile: loaded.session.profile,
  };

  const messages = turnsToMessages(loaded.turns);
  return {
    session,
    turns: loaded.turns,
    tokenEstimate: estimateContextTokens(messages),
  };
}

/* ─── Legacy Migration ─── */

/**
 * One-shot migration of legacy flat transcript files into the dated folder
 * layout. Returns the session ids that were moved and any that could not be
 * moved.
 */
export async function migrateLegacySessionFiles(
  paths: HarnessPaths
): Promise<{ moved: string[]; skipped: string[] }> {
  const moved: string[] = [];
  const skipped: string[] = [];

  let entries: Dirent[] = [];
  try {
    entries = await readdir(paths.sessions, { withFileTypes: true });
  } catch {
    return { moved, skipped };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === "sessions.json") continue;
    if (!entry.name.endsWith(".jsonl")) continue;

    const sessionId = entry.name.slice(0, -".jsonl".length);
    const src = join(paths.sessions, entry.name);
    const destDir = join(paths.sessions, sessionDateFromId(sessionId));
    const dest = join(destDir, entry.name);

    if (src === dest) continue;

    try {
      await mkdir(destDir, { recursive: true });
      await rename(src, dest);
      moved.push(sessionId);
    } catch {
      skipped.push(sessionId);
    }
  }

  return { moved, skipped };
}

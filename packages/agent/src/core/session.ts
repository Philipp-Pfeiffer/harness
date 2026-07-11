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
} from "node:fs/promises";
import { dirname, join } from "node:path";
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

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  model: string;
  tokenTotals: SessionTokenTotals;
  parentSessionId?: string;
  transcriptPath: string;
  status: "active" | "idle" | "ended";
}

export interface SessionIndexEntry {
  sessionId: string;
  created: string;
  lastActivity: string;
  model: string;
  tokenTotals: SessionTokenTotals;
  parentSessionId?: string;
  title: string;
  status: "active" | "idle" | "ended";
}

export interface CreateSessionOptions {
  model: string;
  title?: string;
  parentSessionId?: string;
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

async function loadIndex(paths: HarnessPaths): Promise<SessionIndexEntry[]> {
  try {
    const raw = await readFile(sessionsIndexPath(paths), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as SessionIndexEntry[];
    return [];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    // Treat corrupt JSON as empty index; caller will rebuild it.
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

async function saveIndex(
  paths: HarnessPaths,
  index: SessionIndexEntry[]
): Promise<void> {
  await mkdir(paths.sessions, { recursive: true });
  const tmpPath = sessionsIndexPath(paths) + ".tmp";
  await writeFile(tmpPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  await rename(tmpPath, sessionsIndexPath(paths));
}

async function upsertIndexEntry(
  paths: HarnessPaths,
  entry: SessionIndexEntry
): Promise<void> {
  const index = await loadIndex(paths);
  const idx = index.findIndex((e) => e.sessionId === entry.sessionId);
  if (idx === -1) {
    index.push(entry);
  } else {
    index[idx] = entry;
  }
  await saveIndex(paths, index);
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
  };

  await mkdir(dirname(transcriptPath), { recursive: true });
  await writeFile(session.transcriptPath, "", "utf-8");
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
  const ended: Session = { ...session, status: "ended" };
  await upsertIndexEntry(paths, sessionToIndexEntry(ended));
  return ended;
}

/**
 * Marks all sessions currently in "active" status as "idle".
 * Called on daemon start to clean up orphaned active markers from
 * a crash or unclean shutdown. "active" = in-memory only; anything
 * not loaded in the daemon is "idle" (resumable) or "ended" (explicitly stopped).
 */
export async function markActiveSessionsIdle(paths: HarnessPaths): Promise<number> {
  const index = await loadIndex(paths);
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

/* ─── Read API ─── */

export async function readSession(
  sessionId: string,
  paths: HarnessPaths
): Promise<{ session: SessionIndexEntry; turns: SessionTurn[] } | null> {
  const index = await loadIndex(paths);
  const entry = index.find((e) => e.sessionId === sessionId);
  if (!entry) return null;

  const tPath = await findTranscriptPath(paths, sessionId);
  if (!tPath) return null;

  let raw: string;
  try {
    raw = await readFile(tPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }

  const turns: SessionTurn[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      turns.push(JSON.parse(trimmed) as SessionTurn);
    } catch {
      // Skip corrupt lines silently.
    }
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
    return raw.split("\n").filter((line) => line.trim()).length;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    throw err;
  }
}

export async function listSessions(
  paths: HarnessPaths,
  range?: ListSessionsRange
): Promise<SessionIndexEntry[]> {
  const index = await loadIndex(paths);
  if (!range) return index;

  return index.filter((entry) => {
    if (range.from && entry.created < range.from) return false;
    if (range.to && entry.created > range.to) return false;
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

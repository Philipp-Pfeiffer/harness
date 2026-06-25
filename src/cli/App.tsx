import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout, useStdin, Static } from "ink";
import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { randomUUID } from "node:crypto";
import { createAgent } from "../core/agent.js";
import { createMailbox } from "../core/mailbox.js";
import { loadCoreMemoryRaw, composeSystemPrompt } from "../core/coreMemory.js";
import { resolveModel, resolveModelFromConfig } from "../core/resolveModel.js";
import { loadTools } from "../tools/registry.js";
import { prompt } from "../prompts.js";
import type { Message, Model, Api } from "@mariozechner/pi-ai";
import type { AgentEvent, RunResult } from "../core/agent.js";
import type { Mailbox } from "../core/mailbox.js";
import { slashCommands, filterCommands, type SlashCommandInfo } from "./commands.js";
import { loadConfig, type ConfigModel } from "./config.js";
import { createMetricsRecorder, type MetricsRecorder } from "../core/metrics.js";
import { isStatusCommand, handleStatusCommand } from "./statusCommand.js";
import { resolveHarnessPaths, type HarnessPaths } from "../config/paths.js";
import {
  createSession,
  endSession,
  recordTurn,
  calculateTurnCost,
  loadSession,
  listSessionsWithDetails,
  turnsToMessages,
  SESSION_LOAD_WARN_THRESHOLD,
  type Session,
  type SessionTurn,
  type SessionListDetail,
} from "../core/session.js";
import {
  isSessionCommand,
  parseSessionCommand,
  formatSessionLoadWarning,
} from "./sessionCommand.js";

/* ─── marked config ─── */

marked.use(
  markedTerminal({
    tab: 2,
    showSectionPrefix: false,
    firstHeading: chalk.cyan.bold.underline,
    heading: chalk.cyan.bold,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: (text: string) => chalk.gray(`\`${text}\``),
    code: chalk.gray,
    blockquote: chalk.gray.italic,
    hr: chalk.gray,
    table: chalk.reset,
    link: chalk.blue,
    href: chalk.blue.underline,
    width: process.stdout.columns || 80,
  }) as any
);

function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string;
  return raw.replace(/^(\s*)\* /gm, "$1• ");
}

/* ─── Types ─── */

export type ToolItem = {
  id: string;
  name: string;
  status: "pending" | "done" | "error";
  args?: unknown;
  preview: string;
  result?: string;
  expanded?: boolean;
};

export type CompletedTurn = {
  id: string;
  userText: string;
  assistantText: string;
  assistantRendered: boolean;
  tools: ToolItem[];
  toolOffsets: number[];
  aborted: boolean;
  error?: string;
  help?: boolean;
};

type ActiveTurn = {
  userText: string;
  assistantText: string;
  tools: ToolItem[];
  toolOffsets: number[];
  status: "streaming" | "thinking" | "tool" | "aborted" | "error" | "complete";
  steers: string[];
};

/* ─── Helpers ─── */

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function turnToCompletedTurn(turn: SessionTurn): CompletedTurn {
  const tools: ToolItem[] = (turn.tool_calls ?? []).map((call) => {
    const result = turn.tool_results?.find((r) => r.toolCallId === call.id);
    return {
      id: call.id,
      name: call.name,
      status: result ? (result.isError ? "error" : "done") : "done",
      args: call.arguments,
      preview: result ? truncate(result.result, 80) : "",
      result: result?.result,
      expanded: false,
    };
  });

  return {
    id: turn.id,
    userText: turn.userContent,
    assistantText: turn.content,
    assistantRendered: true,
    tools,
    toolOffsets: [],
    aborted: false,
  };
}

/**
 * Generates a short summary of what a tool was called with, based on its args.
 * Used in the ToolCard title to show *what* the tool did (e.g. which file, which command).
 */
function toolArgsSummary(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;

  switch (name) {
    case "exec":
      return `$ ${a.command ?? ""}`;
    case "readFile": {
      const path = String(a.path ?? "");
      const start = a.lineStart;
      const end = a.lineEnd;
      if (start && end) return `${path} (L${start}-${end})`;
      if (start) return `${path} (L${start}+)`;
      return path;
    }
    case "write":
      return String(a.path ?? "");
    case "edit": {
      const edits = Array.isArray(a.edits) ? a.edits : [];
      return `${a.path ?? ""} (${edits.length} edit${edits.length === 1 ? "" : "s"})`;
    }
    case "search_memory":
      return `"${a.query ?? ""}"`;
    case "process":
      return `${a.action ?? ""}${a.sessionId ? ` ${a.sessionId}` : ""}`;
    default:
      return "";
  }
}

function findLastPendingToolIndex(tools: ToolItem[], name: string): number {
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].name === name && tools[i].status === "pending") {
      return i;
    }
  }
  return -1;
}

function useForceUpdate() {
  const [, setState] = useState(0);
  return useCallback(() => setState((s) => s + 1), []);
}

/* ─── Sub-components ─── */

function StatusBar({ modelId, status, usage, lastCallTokens, contextWindow }: { modelId: string; status: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; lastCallTokens?: number; contextWindow?: number }) {
  const statusColor =
    status === "ready"
      ? "green"
      : status === "thinking"
        ? "yellow"
        : status === "aborted"
          ? "gray"
          : "cyan";

  const cwd = process.cwd();
  const used = lastCallTokens ?? usage?.totalTokens ?? 0;
  const usedStr = formatTokens(used);
  const maxStr = contextWindow ? formatTokens(contextWindow) : "?";

  let counterColor: string | undefined;
  if (contextWindow) {
    const ratio = used / contextWindow;
    if (ratio > 0.95) counterColor = "red";
    else if (ratio > 0.8) counterColor = "yellow";
  }

  const sessionTotal = usage?.totalTokens;
  const showSession = sessionTotal !== undefined && sessionTotal !== used;

  return (
    <Box width="100%" height={1}>
      <Text bold color="cyan">
        harness
      </Text>
      <Text dimColor> · </Text>
      <Text dimColor>{modelId}</Text>
      <Text dimColor> · </Text>
      <Text color={statusColor}>{status}</Text>
      {used > 0 && (
        <>
          <Text dimColor> · </Text>
          <Text color={counterColor}>{usedStr} / {maxStr}</Text>
        </>
      )}
      {showSession && (
        <>
          <Text dimColor> · </Text>
          <Text dimColor>Ses: {formatTokens(sessionTotal)}</Text>
        </>
      )}
      <Text dimColor> · </Text>
      <Text dimColor>{cwd}</Text>
    </Box>
  );
}

function wrapLines(text: string, maxWidth: number): string[] {
  const result: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= maxWidth) {
      result.push(rawLine);
    } else {
      for (let i = 0; i < rawLine.length; i += maxWidth) {
        result.push(rawLine.slice(i, i + maxWidth));
      }
    }
  }
  return result;
}

export function ToolCard({ item, isLast }: { item: ToolItem; isLast: boolean }) {
  const symbol = item.status === "pending" ? "▸" : item.status === "done" ? "✓" : "✗";
  const borderFn = item.status === "error" ? chalk.red : item.status === "done" ? chalk.green : chalk.gray;
  const iconColor = item.status === "error" ? "red" : item.status === "done" ? "green" : "yellow";
  const innerWidth = Math.max(20, (process.stdout.columns || 80) - 4);
  const contentWidth = innerWidth;

  const summary = toolArgsSummary(item.name, item.args);
  const titleBase = summary ? `${symbol} ${item.name}: ${summary}` : `${symbol} ${item.name}`;
  const ctrlHint = isLast ? " ── Ctrl+O ─" : "";
  let titleContent = `${titleBase}${ctrlHint}`;
  if (titleContent.length > innerWidth - 4) {
    titleContent = titleContent.slice(0, innerWidth - 7) + "...";
  }
  const titleFill = Math.max(1, innerWidth - titleContent.length - 3);
  const titleLine = `${borderFn("┌─")} ${titleContent} ${borderFn("─".repeat(titleFill) + "┐")}`;
  const bottomLine = borderFn("└" + "─".repeat(innerWidth) + "┘");

  const body = item.expanded && item.result
    ? wrapLines(item.result, contentWidth).map((line) => `${borderFn("│")} ${line}`).join("\n")
    : item.expanded && item.preview
      ? wrapLines(item.preview, contentWidth).map((line) => `${borderFn("│")} ${line}`).join("\n")
      : null;

  const previewLine = !item.expanded && item.preview
    ? wrapLines(item.preview, contentWidth).map((line) => `${borderFn("│")} ${line}`).join("\n")
    : null;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={iconColor}>{titleLine}</Text>
      {previewLine && <Text>{previewLine}</Text>}
      {body && <Text>{body}</Text>}
      <Text>{bottomLine}</Text>
    </Box>
  );
}

function HelpCard() {
  return (
    <Box flexDirection="column" marginY={1} paddingX={1} borderStyle="single" borderColor="gray">
      <Text bold>Commands</Text>
      {slashCommands.map((cmd) => (
        <Text key={cmd.name}>  {cmd.name}  – {cmd.description}</Text>
      ))}
      <Text bold>Keybinds</Text>
      <Text>  Ctrl+O  – Toggle last tool card</Text>
      <Text>  Ctrl+E  – Selection mode (scroll & copy)</Text>
      <Text>  Ctrl+L  – Clear screen</Text>
      <Text>  Ctrl+C  – Abort stream / double-tap to exit</Text>
    </Box>
  );
}

export function renderTurnContent(
  assistantText: string,
  tools: ToolItem[],
  toolOffsets: number[],
  assistantRendered: boolean
): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  let textStart = 0;

  for (let i = 0; i < tools.length; i++) {
    const offset = toolOffsets[i] ?? textStart;
    const textSlice = assistantText.slice(textStart, offset);
    if (textSlice) {
      elements.push(
        <Box key={`pre-${tools[i].id}`}>
          <Text>{assistantRendered ? renderMarkdown(textSlice) : textSlice}</Text>
        </Box>
      );
    }
    elements.push(<ToolCard key={tools[i].id} item={tools[i]} isLast={i === tools.length - 1} />);
    textStart = offset;
  }

  const remainingText = assistantText.slice(textStart);
  if (remainingText) {
    elements.push(
      <Box key="post-final" marginTop={elements.length > 0 ? 0 : 1}>
        <Text>{assistantRendered ? renderMarkdown(remainingText) : remainingText}</Text>
      </Box>
    );
  }

  return elements;
}

function TurnView({ turn }: { turn: CompletedTurn }) {
  const content = renderTurnContent(turn.assistantText, turn.tools, turn.toolOffsets, turn.assistantRendered);

  return (
    <Box flexDirection="column">
      <Text color="cyan">❯ {turn.userText}</Text>
      {content.length > 0 ? content : null}
      {turn.error && (
        <Text color="red">
          [Fehler]: {turn.error}
        </Text>
      )}
      {turn.aborted && (
        <Text italic color="gray">
          [abgebrochen]
        </Text>
      )}
      {turn.help && <HelpCard />}
    </Box>
  );
}

function ActiveTurnView({ turn }: { turn: ActiveTurn }) {
  const content = renderTurnContent(turn.assistantText, turn.tools, turn.toolOffsets, false);

  return (
    <Box flexDirection="column">
      <Text color="cyan">❯ {turn.userText}</Text>
      {content.length > 0 ? content : null}
      {turn.steers.length > 0 && (
        <Box flexDirection="column" marginY={1}>
          <Text italic color="gray">[steer]</Text>
          {turn.steers.map((steer, idx) => (
            <Text key={`steer-${idx}`} italic color="gray">  {steer}</Text>
          ))}
        </Box>
      )}
      {turn.status === "aborted" && (
        <Text italic color="gray">
          [abgebrochen]
        </Text>
      )}
      {turn.status === "error" && (
        <Text color="red">
          [Fehler]
        </Text>
      )}
    </Box>
  );
}

/* ─── PromptInput with selection + Ctrl+Backspace ─── */

function PromptInput({
  onSubmit,
  history,
  commands,
  paused = false,
}: {
  onSubmit: (v: string) => void;
  history: string[];
  commands?: SlashCommandInfo[];
  paused?: boolean;
}) {
  const [, setRenderTick] = useState(0);
  const valueRef = useRef("");
  const cursorOffsetRef = useRef(0);
  const selStartRef = useRef(-1);
  const selEndRef = useRef(-1);
  const historyIndexRef = useRef(-1);
  const blinkRef = useRef(true);
  const historyRef = useRef(history);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      blinkRef.current = !blinkRef.current;
      setRenderTick((t) => t + 1);
    }, 530);
    return () => clearInterval(id);
  }, [paused]);

  function hasSelection(): boolean {
    return selStartRef.current !== -1 && selEndRef.current !== -1 && selStartRef.current !== selEndRef.current;
  }

  function selectionRange(): [number, number] {
    if (!hasSelection()) return [cursorOffsetRef.current, cursorOffsetRef.current];
    const s = Math.min(selStartRef.current, selEndRef.current);
    const e = Math.max(selStartRef.current, selEndRef.current);
    return [s, e];
  }

  function clearSelection() {
    selStartRef.current = -1;
    selEndRef.current = -1;
  }

  function deleteSelection(): boolean {
    if (!hasSelection()) return false;
    const [s, e] = selectionRange();
    const before = valueRef.current.slice(0, s);
    const after = valueRef.current.slice(e);
    valueRef.current = before + after;
    cursorOffsetRef.current = s;
    clearSelection();
    return true;
  }

  function deleteWordBeforeCursor() {
    const text = valueRef.current;
    let pos = cursorOffsetRef.current;
    if (pos <= 0) return;
    // delete trailing whitespace
    while (pos > 0 && /\s/.test(text[pos - 1])) pos--;
    // delete word chars
    while (pos > 0 && !/\s/.test(text[pos - 1])) pos--;
    valueRef.current = text.slice(0, pos) + text.slice(cursorOffsetRef.current);
    cursorOffsetRef.current = pos;
  }

  useInput((inputStr, key) => {
    if (key.ctrl && (inputStr === "c" || inputStr === "l" || inputStr === "o" || inputStr === "e")) {
      return;
    }

    let changed = false;
    const currentValue = valueRef.current;

    if (commands && pickerOpen) {
      const filtered = filterCommands(valueRef.current);
      if (key.upArrow && !key.shift) {
        setPickerIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow && !key.shift) {
        setPickerIndex((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (key.escape) {
        setPickerOpen(false);
        setPickerIndex(0);
        return;
      }
      if ((key.return || key.tab) && filtered.length > 0) {
        const cmd = filtered[pickerIndex] ?? filtered[0];
        valueRef.current = cmd.name;
        cursorOffsetRef.current = cmd.name.length;
        clearSelection();
        setPickerOpen(false);
        setPickerIndex(0);
        setRenderTick((t) => t + 1);
        return;
      }
    }

    // Ctrl+Backspace / Alt+Backspace / Ctrl+H → delete word
    // Note: many terminals send \x08 (BS) for Ctrl+Backspace, which Ink parses as input='h' + ctrl=true
    if ((key.ctrl || key.meta) && (key.backspace || key.delete)) {
      if (deleteSelection()) {
        changed = true;
      } else {
        deleteWordBeforeCursor();
        changed = true;
      }
    } else if (inputStr === 'h' && key.ctrl) {
      if (deleteSelection()) {
        changed = true;
      } else {
        deleteWordBeforeCursor();
        changed = true;
      }
    } else if (key.ctrl && inputStr === "a") {
      // Ctrl+A → select all
      selStartRef.current = 0;
      selEndRef.current = currentValue.length;
      cursorOffsetRef.current = currentValue.length;
      changed = true;
    } else if (key.return && key.shift) {
      if (deleteSelection()) changed = true;
      const before = valueRef.current.slice(0, cursorOffsetRef.current);
      const after = valueRef.current.slice(cursorOffsetRef.current);
      valueRef.current = before + "\n" + after;
      cursorOffsetRef.current++;
      clearSelection();
      changed = true;
    } else if (key.return) {
      onSubmit(currentValue);
      valueRef.current = "";
      cursorOffsetRef.current = 0;
      clearSelection();
      historyIndexRef.current = -1;
      changed = true;
    } else if (key.upArrow) {
      if (key.shift) {
        if (!hasSelection()) {
          selStartRef.current = cursorOffsetRef.current;
        }
        // Move cursor to previous line start or up one line
        const prevNewline = currentValue.lastIndexOf("\n", cursorOffsetRef.current - 1);
        cursorOffsetRef.current = prevNewline >= 0 ? prevNewline : 0;
        selEndRef.current = cursorOffsetRef.current;
        changed = true;
      } else {
        const newIndex = Math.min(historyIndexRef.current + 1, historyRef.current.length - 1);
        if (newIndex >= 0 && newIndex !== historyIndexRef.current) {
          historyIndexRef.current = newIndex;
          valueRef.current = historyRef.current[historyRef.current.length - 1 - newIndex];
          cursorOffsetRef.current = valueRef.current.length;
          clearSelection();
          changed = true;
        }
      }
    } else if (key.downArrow) {
      if (key.shift) {
        if (!hasSelection()) {
          selStartRef.current = cursorOffsetRef.current;
        }
        const nextNewline = currentValue.indexOf("\n", cursorOffsetRef.current);
        cursorOffsetRef.current = nextNewline >= 0 ? nextNewline + 1 : currentValue.length;
        selEndRef.current = cursorOffsetRef.current;
        changed = true;
      } else {
        const newIndex = Math.max(historyIndexRef.current - 1, -1);
        if (newIndex !== historyIndexRef.current) {
          historyIndexRef.current = newIndex;
          valueRef.current = newIndex === -1 ? "" : historyRef.current[historyRef.current.length - 1 - newIndex];
          cursorOffsetRef.current = valueRef.current.length;
          clearSelection();
          changed = true;
        }
      }
    } else if (key.leftArrow) {
      if (key.shift) {
        if (!hasSelection()) {
          selStartRef.current = cursorOffsetRef.current;
        }
        cursorOffsetRef.current = Math.max(0, cursorOffsetRef.current - 1);
        selEndRef.current = cursorOffsetRef.current;
        changed = true;
      } else {
        cursorOffsetRef.current = Math.max(0, cursorOffsetRef.current - 1);
        clearSelection();
        changed = true;
      }
    } else if (key.rightArrow) {
      if (key.shift) {
        if (!hasSelection()) {
          selStartRef.current = cursorOffsetRef.current;
        }
        cursorOffsetRef.current = Math.min(currentValue.length, cursorOffsetRef.current + 1);
        selEndRef.current = cursorOffsetRef.current;
        changed = true;
      } else {
        cursorOffsetRef.current = Math.min(currentValue.length, cursorOffsetRef.current + 1);
        clearSelection();
        changed = true;
      }
    } else if (key.backspace || key.delete) {
      if (deleteSelection()) {
        changed = true;
      } else if (cursorOffsetRef.current > 0) {
        const before = valueRef.current.slice(0, cursorOffsetRef.current - 1);
        const after = valueRef.current.slice(cursorOffsetRef.current);
        valueRef.current = before + after;
        cursorOffsetRef.current--;
        changed = true;
      }
    } else if (inputStr && !key.ctrl && !key.meta) {
      if (deleteSelection()) changed = true;
      const before = valueRef.current.slice(0, cursorOffsetRef.current);
      const after = valueRef.current.slice(cursorOffsetRef.current);
      valueRef.current = before + inputStr + after;
      cursorOffsetRef.current += inputStr.length;
      clearSelection();
      changed = true;
    }

    if (changed) {
      setRenderTick((t) => t + 1);
      if (commands) {
        const shouldOpen = valueRef.current.startsWith("/") && !valueRef.current.includes(" ") && filterCommands(valueRef.current).length > 0;
        if (shouldOpen && !pickerOpen) {
          setPickerOpen(true);
          setPickerIndex(0);
        } else if (!shouldOpen && pickerOpen) {
          setPickerOpen(false);
          setPickerIndex(0);
        }
      }
    }
  });

  const filteredCommands = pickerOpen && commands ? filterCommands(valueRef.current) : [];

  // Build display lines with selection highlighting
  const fullText = valueRef.current;
  const lines = fullText.split("\n");
  const [selStart, selEnd] = selectionRange();
  const cursorOffset = cursorOffsetRef.current;

  return (
    <Box flexDirection="column">
      {lines.map((line, lineIndex) => {
        const lineStartOffset = fullText.split("\n").slice(0, lineIndex).join("\n").length + (lineIndex > 0 ? 1 : 0);
        const lineEndOffset = lineStartOffset + line.length;
        const isCursorLine = cursorOffset >= lineStartOffset && cursorOffset <= lineEndOffset;
        const lineCursorCol = cursorOffset - lineStartOffset;

        // Determine selection within this line
        const lineSelStart = Math.max(0, selStart - lineStartOffset);
        const lineSelEnd = Math.min(line.length, selEnd - lineStartOffset);
        const hasLineSel = lineSelStart < lineSelEnd;

        // Build segments: [normal, selected, normal, cursor, normal]
        type Segment = { text: string; selected: boolean; isCursor: boolean };
        const segments: Segment[] = [];

        if (!hasLineSel && !isCursorLine) {
          segments.push({ text: line, selected: false, isCursor: false });
        } else if (!hasLineSel && isCursorLine) {
          const before = line.slice(0, lineCursorCol);
          const char = line[lineCursorCol] || " ";
          const after = line.slice(lineCursorCol + 1);
          if (before) segments.push({ text: before, selected: false, isCursor: false });
          segments.push({ text: char, selected: false, isCursor: true });
          if (after) segments.push({ text: after, selected: false, isCursor: false });
        } else if (hasLineSel && !isCursorLine) {
          if (lineSelStart > 0) segments.push({ text: line.slice(0, lineSelStart), selected: false, isCursor: false });
          segments.push({ text: line.slice(lineSelStart, lineSelEnd), selected: true, isCursor: false });
          if (lineSelEnd < line.length) segments.push({ text: line.slice(lineSelEnd), selected: false, isCursor: false });
        } else {
          // Both selection and cursor on this line
          const parts = [0, lineSelStart, lineSelEnd, lineCursorCol, lineCursorCol + 1, line.length].filter((v, i, a) => v >= 0 && v <= line.length && (i === 0 || v >= a[i - 1])).sort((a, b) => a - b);
          const uniqueParts = Array.from(new Set(parts));
          for (let i = 0; i < uniqueParts.length - 1; i++) {
            const start = uniqueParts[i];
            const end = uniqueParts[i + 1];
            const text = line.slice(start, end);
            const selected = start >= lineSelStart && end <= lineSelEnd;
            const isCursor = start === lineCursorCol;
            if (text || isCursor) {
              segments.push({ text: text || " ", selected, isCursor });
            }
          }
        }

        return (
          <Box key={`line-${lineIndex}`} flexDirection="row">
            <Text color="cyan">❯ </Text>
            {segments.map((seg, segIdx) => {
              if (seg.isCursor) {
                return (
                  <Text key={`seg-${lineIndex}-${segIdx}`}>{blinkRef.current ? chalk.inverse(seg.text) : seg.text}</Text>
                );
              }
              if (seg.selected) {
                return <Text key={`seg-${lineIndex}-${segIdx}`}>{chalk.bgWhite.black(seg.text)}</Text>;
              }
              return <Text key={`seg-${lineIndex}-${segIdx}`}>{seg.text}</Text>;
            })}
          </Box>
        );
      })}
      {pickerOpen && filteredCommands.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {filteredCommands.map((cmd, idx) => (
            <Text key={`cmd-${cmd.name}-${idx}`} color={idx === pickerIndex ? "cyan" : "gray"} bold={idx === pickerIndex}>
              {cmd.name}  – {cmd.description}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/* ─── Main App ─── */

export default function App({
  configPath,
  memoryService,
  paths: pathsProp,
}: {
  configPath?: string;
  memoryService?: import("../core/memoryService.js").MemoryService;
  paths?: HarnessPaths;
} = {}) {
  const paths = pathsProp ?? resolveHarnessPaths();
  // memoryService is injected for future phases (ambient retrieval, explicit search)
  const _memoryServiceRef = useRef(memoryService);
  void _memoryServiceRef;

  const { exit } = useApp();
  const { stdout } = useStdout();
  const { setRawMode } = useStdin();
  const [termSize, setTermSize] = useState({ columns: stdout.columns, rows: stdout.rows });
  const [selectionMode, setSelectionMode] = useState(false);
  const [pastTurns, setPastTurns] = useState<CompletedTurn[]>([]);
  const activeTurnRef = useRef<ActiveTurn | null>(null);
  const forceUpdate = useForceUpdate();
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [sessionUsage, setSessionUsage] = useState<{ inputTokens: number; outputTokens: number; totalTokens: number; cacheRead: number; cacheWrite: number } | undefined>(undefined);
  const [lastCallTokens, setLastCallTokens] = useState<number | undefined>(undefined);

  const historyRef = useRef<Message[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const userAbortedRef = useRef(false);
  const abortCommandRef = useRef<string | undefined>(undefined);
  const lastSigintRef = useRef(0);
  const isRunningRef = useRef(false);
  const mailboxRef = useRef<Mailbox>(createMailbox());
  const sessionRef = useRef<Session | null>(null);
  const pendingResumeRef = useRef<{ sessionId: string; tokens: number } | null>(null);
  const metricsRecorderRef = useRef<MetricsRecorder>(createMetricsRecorder({}));
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionInitializedRef = useRef(false);

  useEffect(() => {
    const handleResize = () => {
      setTermSize({ columns: stdout.columns, rows: stdout.rows });
    };
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  // Selection mode: disable raw mode so the terminal handles mouse selection & scroll
  useEffect(() => {
    if (!selectionMode) return;
    setRawMode(false);
    const exitHandler = () => setSelectionMode(false);
    process.stdin.once("data", exitHandler);
    return () => {
      process.stdin.removeListener("data", exitHandler);
      setRawMode(true);
    };
  }, [selectionMode, setRawMode]);

  const tools = useMemo(() => loadTools(memoryService?.getBackend()), [memoryService]);
  const [activeModel, setActiveModel] = useState<Model<Api>>(() => resolveModel("minimax", "MiniMax-M2.7"));
  const agent = useMemo(() => createAgent({ tools, model: activeModel }), [tools]);
  useEffect(() => {
    agent.setModel(activeModel);
  }, [agent, activeModel]);

  useEffect(() => {
    (async () => {
      const coreMemory = await loadCoreMemoryRaw(paths.core);
      const basePrompt = prompt("system-prompt", { inboxPath: paths.inbox });
      const composed = composeSystemPrompt(basePrompt, coreMemory);
      agent.setSystemPrompt(composed);
      console.log(`[harness] core memory loaded: ${coreMemory ? coreMemory.length : 0} chars`);
    })();
  }, [agent]);

  const [configModels, setConfigModels] = useState<ConfigModel[]>([]);
  const [configDefaultModel, setConfigDefaultModel] = useState<ConfigModel | undefined>(undefined);
  const [configError, setConfigError] = useState<string | undefined>(undefined);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [sessionPickerIndex, setSessionPickerIndex] = useState(0);
  const [sessionPickerOptions, setSessionPickerOptions] = useState<SessionListDetail[]>([]);
  const [sessionPickerFilter, setSessionPickerFilter] = useState("");

  useEffect(() => {
    (async () => {
      const result = await loadConfig({ configPath, harnessHome: paths.home });
      setConfigModels(result.models);
      setConfigDefaultModel(result.defaultModel);
      if (result.error) {
        setConfigError(result.error);
      }
    })();
  }, [configPath, paths.home]);

  useEffect(() => {
    if (!configDefaultModel) return;
    try {
      setActiveModel(resolveModelFromConfig(configDefaultModel));
    } catch {
      setConfigError((prev) =>
        prev ?? `Failed to load default model ${configDefaultModel.provider}/${configDefaultModel.model}`,
      );
    }
  }, [configDefaultModel]);

  // Initialize session once on startup.
  useEffect(() => {
    if (sessionInitializedRef.current) return;
    sessionInitializedRef.current = true;

    void (async () => {
      try {
        const s = await createSession(paths, {
          model: activeModel.name,
          title: "CLI Session",
        });
        sessionRef.current = s;
        metricsRecorderRef.current = createMetricsRecorder({ sessionId: s.id });
      } catch (err) {
        console.error("[harness] failed to create session:", err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const status = activeTurnRef.current
    ? activeTurnRef.current.status === "tool"
      ? `tool: ${activeTurnRef.current.tools[activeTurnRef.current.tools.length - 1]?.name || ""}`
      : activeTurnRef.current.status
    : "ready";

  const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const resetIdleTimer = useCallback(() => {
    clearIdleTimer();
    idleTimerRef.current = setTimeout(() => {
      if (sessionRef.current) {
        void endSession(sessionRef.current, paths)
          .then(() => {
            sessionRef.current = null;
            historyRef.current = [];
            setPastTurns([]);
            setSessionUsage(undefined);
            setLastCallTokens(undefined);
            const infoTurn: CompletedTurn = {
              id: randomUUID(),
              userText: "",
              assistantText: "Session ended due to idle timeout. Type a message to start a new session.",
              assistantRendered: false,
              tools: [],
              toolOffsets: [],
              aborted: false,
            };
            setPastTurns((prev) => [...prev, infoTurn]);
          })
          .catch((err) => {
            console.error("[harness] idle timeout end session failed:", err instanceof Error ? err.message : String(err));
          });
      }
    }, IDLE_TIMEOUT_MS);
  }, [clearIdleTimer, paths]);

  // Cleanup idle timer and end active session on unmount.
  useEffect(() => {
    return () => {
      clearIdleTimer();
      if (sessionRef.current) {
        void endSession(sessionRef.current, paths).catch((err) => {
          console.error("[harness] failed to end session:", err instanceof Error ? err.message : String(err));
        });
      }
    };
  }, [clearIdleTimer, paths]);

  function resolveModelByName(name: string): Model<Api> | undefined {
    const match = configModels.find(
      (m) => m.alias === name || m.model === name,
    );
    if (!match) return undefined;
    try {
      return resolveModelFromConfig(match);
    } catch {
      return undefined;
    }
  }

  async function resumeSession(sessionId: string) {
    try {
      if (sessionRef.current) {
        await endSession(sessionRef.current, paths);
        sessionRef.current = null;
      }

      const loaded = await loadSession(sessionId, paths);
      if (!loaded) {
        const errorTurn: CompletedTurn = {
          id: randomUUID(),
          userText: `/session ${sessionId}`,
          assistantText: "",
          assistantRendered: false,
          tools: [],
          toolOffsets: [],
          aborted: false,
          error: `Session not found: ${sessionId}`,
        };
        setPastTurns((prev) => [...prev, errorTurn]);
        return;
      }

      const targetModel = resolveModelByName(loaded.session.model) ?? activeModel;
      if (targetModel.id !== activeModel.id) {
        setActiveModel(targetModel);
      }

      sessionRef.current = loaded.session;
      metricsRecorderRef.current = createMetricsRecorder({
        sessionId: loaded.session.id,
      });
      historyRef.current = turnsToMessages(loaded.turns);

      const replayTurns = loaded.turns.map(turnToCompletedTurn);
      const infoTurn: CompletedTurn = {
        id: randomUUID(),
        userText: "",
        assistantText: `Resumed session ${loaded.session.id} (${replayTurns.length} turns, ~${formatTokens(loaded.tokenEstimate)} tokens)`,
        assistantRendered: false,
        tools: [],
        toolOffsets: [],
        aborted: false,
      };
      setPastTurns([...replayTurns, infoTurn]);
      setSessionUsage(loaded.session.tokenTotals);
      setLastCallTokens(loaded.tokenEstimate);
    } catch (err) {
      console.error(
        "[harness] /session resume failed:",
        err instanceof Error ? err.message : String(err),
      );
      const errorTurn: CompletedTurn = {
        id: randomUUID(),
        userText: `/session ${sessionId}`,
        assistantText: "",
        assistantRendered: false,
        tools: [],
        toolOffsets: [],
        aborted: false,
        error: `Failed to resume session: ${err instanceof Error ? err.message : String(err)}`,
      };
      setPastTurns((prev) => [...prev, errorTurn]);
    }
  }

  async function initiateSessionResume(sessionId: string, userText = `/session ${sessionId}`) {
    const loaded = await loadSession(sessionId, paths);
    if (!loaded) {
      const errorTurn: CompletedTurn = {
        id: randomUUID(),
        userText,
        assistantText: "",
        assistantRendered: false,
        tools: [],
        toolOffsets: [],
        aborted: false,
        error: `Session not found: ${sessionId}`,
      };
      setPastTurns((prev) => [...prev, errorTurn]);
      return;
    }

    if (loaded.tokenEstimate >= SESSION_LOAD_WARN_THRESHOLD) {
      pendingResumeRef.current = {
        sessionId,
        tokens: loaded.tokenEstimate,
      };
      const warnTurn: CompletedTurn = {
        id: randomUUID(),
        userText,
        assistantText: formatSessionLoadWarning(sessionId, loaded.tokenEstimate),
        assistantRendered: false,
        tools: [],
        toolOffsets: [],
        aborted: false,
      };
      setPastTurns((prev) => [...prev, warnTurn]);
    } else {
      void resumeSession(sessionId);
    }
  }

  const filteredSessionPickerOptions = useMemo(() => {
    const filter = sessionPickerFilter.trim().toLowerCase();
    const sorted = [...sessionPickerOptions].sort((a, b) =>
      b.lastActivity.localeCompare(a.lastActivity),
    );
    if (!filter) return sorted;
    return sorted.filter(
      (s) =>
        s.sessionId.toLowerCase().includes(filter) ||
        s.title.toLowerCase().includes(filter) ||
        s.model?.toLowerCase().includes(filter),
    );
  }, [sessionPickerOptions, sessionPickerFilter]);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (pendingResumeRef.current) {
        const answer = trimmed.toLowerCase();
        if (answer === "y" || answer === "yes") {
          void resumeSession(pendingResumeRef.current.sessionId);
        } else {
          const cancelTurn: CompletedTurn = {
            id: randomUUID(),
            userText: trimmed,
            assistantText: "Resume cancelled.",
            assistantRendered: false,
            tools: [],
            toolOffsets: [],
            aborted: false,
          };
          setPastTurns((prev) => [...prev, cancelTurn]);
        }
        pendingResumeRef.current = null;
        return;
      }

      if (trimmed === "/clear") {
        setPastTurns([]);
        historyRef.current = [];
        setSessionUsage(undefined);
        setLastCallTokens(undefined);
        return;
      }
      if (trimmed === "/new") {
        try {
          if (sessionRef.current) {
            await endSession(sessionRef.current, paths);
          }
          const s = await createSession(paths, { model: activeModel.name, title: "CLI Session" });
          sessionRef.current = s;
          metricsRecorderRef.current = createMetricsRecorder({ sessionId: s.id });
          historyRef.current = [];
          setPastTurns([]);
          setSessionUsage(undefined);
          setLastCallTokens(undefined);
          const infoTurn: CompletedTurn = {
            id: randomUUID(),
            userText: trimmed,
            assistantText: `Started new session: ${s.id}`,
            assistantRendered: false,
            tools: [],
            toolOffsets: [],
            aborted: false,
          };
          setPastTurns((prev) => [...prev, infoTurn]);
        } catch (err) {
          console.error("[harness] /new failed:", err instanceof Error ? err.message : String(err));
          const errorTurn: CompletedTurn = {
            id: randomUUID(),
            userText: trimmed,
            assistantText: "",
            assistantRendered: false,
            tools: [],
            toolOffsets: [],
            aborted: false,
            error: "Failed to start a new session.",
          };
          setPastTurns((prev) => [...prev, errorTurn]);
        }
        return;
      }
      if (trimmed === "/end") {
        try {
          if (sessionRef.current) {
            await endSession(sessionRef.current, paths);
            sessionRef.current = null;
          }
        } catch (err) {
          console.error("[harness] /end failed:", err instanceof Error ? err.message : String(err));
        }
        clearIdleTimer();
        historyRef.current = [];
        setPastTurns([]);
        setSessionUsage(undefined);
        setLastCallTokens(undefined);
        const infoTurn: CompletedTurn = {
          id: randomUUID(),
          userText: trimmed,
          assistantText: "Session ended. Type a message to start a new session.",
          assistantRendered: false,
          tools: [],
          toolOffsets: [],
          aborted: false,
        };
        setPastTurns((prev) => [...prev, infoTurn]);
        return;
      }
      if (trimmed === "/quit") {
        try {
          if (sessionRef.current) {
            await endSession(sessionRef.current, paths);
          }
        } catch (err) {
          console.error("[harness] /quit failed to end session:", err instanceof Error ? err.message : String(err));
        }
        exit();
        process.exit(0);
        return;
      }
      if (trimmed === "/model") {
        setShowModelPicker(true);
        setModelPickerIndex(0);
        return;
      }
      if (trimmed === "/help") {
        const helpTurn: CompletedTurn = {
          id: randomUUID(),
          userText: trimmed,
          assistantText: "",
          assistantRendered: false,
          tools: [],
          toolOffsets: [],
          aborted: false,
          help: true,
        };
        setPastTurns((prev) => [...prev, helpTurn]);
        return;
      }
      if (isStatusCommand(trimmed)) {
        const statusText = await handleStatusCommand(trimmed, {
          model: activeModel.id,
          workspace: process.cwd(),
          sessionState: isRunningRef.current ? "active" : "ready",
          sessionId: sessionRef.current?.id,
          sessionUsage,
          memoryReady: !memoryService?.degraded,
          toolCalls: pastTurns.reduce((sum, t) => sum + t.tools.length, 0),
          errors: pastTurns.filter((t) => t.error).length,
        });
        const statusTurn: CompletedTurn = {
          id: randomUUID(),
          userText: trimmed,
          assistantText: statusText,
          assistantRendered: false,
          tools: [],
          toolOffsets: [],
          aborted: false,
        };
        setPastTurns((prev) => [...prev, statusTurn]);
        return;
      }
      if (isSessionCommand(trimmed)) {
        const cmd = parseSessionCommand(trimmed);
        if (!cmd) {
          const errorTurn: CompletedTurn = {
            id: randomUUID(),
            userText: trimmed,
            assistantText: "",
            assistantRendered: false,
            tools: [],
            toolOffsets: [],
            aborted: false,
            error: `Usage: /session [id] [--force]`,
          };
          setPastTurns((prev) => [...prev, errorTurn]);
          return;
        }

        if (cmd.type === "list") {
          const sessions = await listSessionsWithDetails(paths);
          setSessionPickerOptions(sessions);
          setSessionPickerIndex(0);
          setSessionPickerFilter("");
          setShowSessionPicker(true);
          return;
        }

        const loaded = await loadSession(cmd.sessionId, paths);
        if (!loaded) {
          const errorTurn: CompletedTurn = {
            id: randomUUID(),
            userText: trimmed,
            assistantText: "",
            assistantRendered: false,
            tools: [],
            toolOffsets: [],
            aborted: false,
            error: `Session not found: ${cmd.sessionId}`,
          };
          setPastTurns((prev) => [...prev, errorTurn]);
          return;
        }

        if (cmd.force) {
          void resumeSession(cmd.sessionId);
        } else {
          void initiateSessionResume(cmd.sessionId, trimmed);
        }
        return;
      }
      if (trimmed.startsWith("/")) {
        const errorTurn: CompletedTurn = {
          id: randomUUID(),
          userText: trimmed,
          assistantText: "",
          assistantRendered: false,
          tools: [],
          toolOffsets: [],
          aborted: false,
          error: `Unknown command: ${trimmed}. Try /help.`,
        };
        setPastTurns((prev) => [...prev, errorTurn]);
        return;
      }

      if (isRunningRef.current) {
        mailboxRef.current.push(trimmed);
        if (activeTurnRef.current) {
          activeTurnRef.current = {
            ...activeTurnRef.current,
            steers: [...activeTurnRef.current.steers, trimmed],
          };
          forceUpdate();
        }

        // Safety: treat "stopp", "stop", "abort" as immediate abort commands
        const stopWords = ["stopp", "stop", "abort"];
        if (stopWords.includes(trimmed.toLowerCase()) && abortControllerRef.current) {
          userAbortedRef.current = true;
          abortCommandRef.current = trimmed.toLowerCase();
          abortControllerRef.current.abort();
          if (activeTurnRef.current) {
            activeTurnRef.current = { ...activeTurnRef.current, status: "aborted" };
            forceUpdate();
          }
        }
        return;
      }

      // Ensure an active session exists (e.g. after /end or idle timeout).
      if (!sessionRef.current) {
        try {
          const s = await createSession(paths, { model: activeModel.name, title: "CLI Session" });
          sessionRef.current = s;
          metricsRecorderRef.current = createMetricsRecorder({ sessionId: s.id });
        } catch (err) {
          console.error("[harness] failed to create session:", err instanceof Error ? err.message : String(err));
          const errorTurn: CompletedTurn = {
            id: randomUUID(),
            userText: trimmed,
            assistantText: "",
            assistantRendered: false,
            tools: [],
            toolOffsets: [],
            aborted: false,
            error: "Failed to start a new session.",
          };
          setPastTurns((prev) => [...prev, errorTurn]);
          return;
        }
      }
      resetIdleTimer();

      setInputHistory((prev) => [...prev, trimmed]);
      const messagesBeforeTurn = historyRef.current.length;
      historyRef.current.push({ role: "user", content: trimmed, timestamp: Date.now() });

      activeTurnRef.current = { userText: trimmed, assistantText: "", tools: [], toolOffsets: [], status: "thinking", steers: [] };
      isRunningRef.current = true;
      forceUpdate();

      const controller = new AbortController();
      abortControllerRef.current = controller;
      userAbortedRef.current = false;
      abortCommandRef.current = undefined;

      const runStartMs = Date.now();

      agent
        .run(historyRef.current, {
          signal: controller.signal,
          mailbox: mailboxRef.current,
          abortCommand: abortCommandRef,
          memoryBackend: memoryService?.getBackend(),
          metricsRecorder: metricsRecorderRef.current,
          onEvent: (event: AgentEvent) => {
            if (userAbortedRef.current) return;

            if (event.type === "token") {
              if (activeTurnRef.current) {
                activeTurnRef.current = {
                  ...activeTurnRef.current,
                  assistantText: activeTurnRef.current.assistantText + event.text,
                  status: "streaming",
                };
                forceUpdate();
              }
            } else if (event.type === "tool_call_start") {
              if (activeTurnRef.current) {
                const currentTextLen = activeTurnRef.current.assistantText.length;
                activeTurnRef.current = {
                  ...activeTurnRef.current,
                  tools: [
                    ...activeTurnRef.current.tools,
                    { id: randomUUID(), name: event.name, status: "pending", args: event.args, preview: toolArgsSummary(event.name, event.args) },
                  ],
                  toolOffsets: [...activeTurnRef.current.toolOffsets, currentTextLen],
                  status: "tool",
                };
                forceUpdate();
              }
            } else if (event.type === "tool_call_done") {
              if (activeTurnRef.current) {
                const idx = findLastPendingToolIndex(activeTurnRef.current.tools, event.name);
                if (idx !== -1) {
                  const newTools = [...activeTurnRef.current.tools];
                  newTools[idx] = {
                    ...newTools[idx],
                    status: "done",
                    preview: truncate(event.result, 80),
                    result: event.result,
                  };
                  activeTurnRef.current = { ...activeTurnRef.current, tools: newTools, status: "complete" };
                }
                forceUpdate();
              }
            } else if (event.type === "tool_call_error") {
              if (activeTurnRef.current) {
                const idx = findLastPendingToolIndex(activeTurnRef.current.tools, event.name);
                if (idx !== -1) {
                  const newTools = [...activeTurnRef.current.tools];
                  newTools[idx] = {
                    ...newTools[idx],
                    status: "error",
                    preview: truncate(event.error, 80),
                    result: event.error,
                    expanded: true,
                  };
                  activeTurnRef.current = { ...activeTurnRef.current, tools: newTools, status: "error" };
                }
                forceUpdate();
              }
            } else if (event.type === "turn_end") {
              if (activeTurnRef.current) {
                activeTurnRef.current = { ...activeTurnRef.current, status: "complete" };
                forceUpdate();
              }
            } else if (event.type === "usage") {
              setLastCallTokens(event.callTotalTokens ?? event.totalTokens);
            }
          },
        })
        .then((result: RunResult) => {
          if (activeTurnRef.current) {
            const turn = activeTurnRef.current;
            const completedTurn: CompletedTurn = {
              id: randomUUID(),
              userText: turn.userText,
              assistantText: turn.assistantText || (!result.aborted ? result.finalMessage : ""),
              assistantRendered: !result.aborted && !userAbortedRef.current && turn.status !== "error",
              tools: turn.tools,
              toolOffsets: turn.toolOffsets,
              aborted: result.aborted || userAbortedRef.current,
              error: turn.status === "error" ? turn.tools.find((t) => t.status === "error")?.preview : undefined,
            };
            setPastTurns((prev) => [...prev, completedTurn]);
            activeTurnRef.current = null;
            isRunningRef.current = false;
            forceUpdate();

            // Persist turn to session transcript.
            if (sessionRef.current) {
              const timestamp = new Date().toISOString();
              const sessionTurn: SessionTurn = {
                id: completedTurn.id,
                role: "assistant",
                content: completedTurn.assistantText,
                userContent: completedTurn.userText,
                tool_calls: completedTurn.tools.map((t) => ({
                  id: t.id,
                  name: t.name,
                  arguments: t.args,
                })),
                tool_results: completedTurn.tools.map((t) => ({
                  toolCallId: t.id,
                  name: t.name,
                  result: t.result ?? "",
                  isError: t.status === "error",
                })),
                tokens: {
                  input: result.usage.inputTokens,
                  output: result.usage.outputTokens,
                  total: result.usage.totalTokens,
                  cacheRead: result.usage.cacheRead,
                  cacheWrite: result.usage.cacheWrite,
                },
                cost: calculateTurnCost(
                  {
                    input: result.usage.inputTokens,
                    output: result.usage.outputTokens,
                    total: result.usage.totalTokens,
                    cacheRead: result.usage.cacheRead,
                    cacheWrite: result.usage.cacheWrite,
                  },
                  activeModel.cost,
                ),
                timing: {
                  startedAt: new Date(runStartMs).toISOString(),
                  latencyMs: Date.now() - runStartMs,
                },
                model: activeModel.name,
                timestamp,
                messages: historyRef.current.slice(messagesBeforeTurn),
              };
              void recordTurn(sessionRef.current, sessionTurn, paths)
                .then((updated) => {
                  sessionRef.current = updated;
                  setSessionUsage(updated.tokenTotals);
                })
                .catch((err) => {
                  console.error("[harness] failed to record turn:", err instanceof Error ? err.message : String(err));
                });
            }
          }
          if (result.usage) {
            // Keep in-memory fallback up to date until async persistence resolves.
            setSessionUsage((prev) =>
              prev
                ? {
                    inputTokens: prev.inputTokens + result.usage.inputTokens,
                    outputTokens: prev.outputTokens + result.usage.outputTokens,
                    totalTokens: prev.totalTokens + result.usage.totalTokens,
                    cacheRead: prev.cacheRead + result.usage.cacheRead,
                    cacheWrite: prev.cacheWrite + result.usage.cacheWrite,
                  }
                : result.usage
            );
            // For single-turn runs the usage event may not fire, so set lastCallTokens here.
            if (!result.aborted && result.turns <= 1) {
              setLastCallTokens(result.usage.totalTokens);
            }
          }
          metricsRecorderRef.current.recordTurn({
            model: activeModel.name,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            cacheRead: result.usage.cacheRead,
            cacheWrite: result.usage.cacheWrite,
            latencyMs: Date.now() - runStartMs,
            toolCallCount: result.toolCallCount,
            status: result.aborted ? "aborted" : "ok",
          });
          abortControllerRef.current = null;
          userAbortedRef.current = false;
        })
        .catch((err: unknown) => {
          if (activeTurnRef.current) {
            const turn = activeTurnRef.current;
            const completedTurn: CompletedTurn = {
              id: randomUUID(),
              userText: turn.userText,
              assistantText: turn.assistantText,
              assistantRendered: false,
              tools: turn.tools,
              toolOffsets: turn.toolOffsets,
              aborted: false,
              error: err instanceof Error ? err.message : String(err),
            };
            setPastTurns((prev) => [...prev, completedTurn]);
            activeTurnRef.current = null;
            isRunningRef.current = false;
            forceUpdate();

            // Persist error turn without token usage.
            if (sessionRef.current) {
              const timestamp = new Date().toISOString();
              const sessionTurn: SessionTurn = {
                id: completedTurn.id,
                role: "assistant",
                content: completedTurn.assistantText,
                userContent: completedTurn.userText,
                tool_calls: completedTurn.tools.map((t) => ({
                  id: t.id,
                  name: t.name,
                  arguments: t.args,
                })),
                tool_results: completedTurn.tools.map((t) => ({
                  toolCallId: t.id,
                  name: t.name,
                  result: t.result ?? "",
                  isError: t.status === "error",
                })),
                tokens: {
                  input: 0,
                  output: 0,
                  total: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                timing: {
                  startedAt: new Date(runStartMs).toISOString(),
                  latencyMs: Date.now() - runStartMs,
                },
                model: activeModel.name,
                timestamp,
                messages: historyRef.current.slice(messagesBeforeTurn),
              };
              void recordTurn(sessionRef.current, sessionTurn, paths)
                .then((updated) => {
                  sessionRef.current = updated;
                  setSessionUsage(updated.tokenTotals);
                })
                .catch((err) => {
                  console.error("[harness] failed to record turn:", err instanceof Error ? err.message : String(err));
                });
            }
          }
          abortControllerRef.current = null;
          userAbortedRef.current = false;
          metricsRecorderRef.current.recordTurn({
            model: activeModel.name,
            latencyMs: Date.now() - runStartMs,
            toolCallCount: 0,
            status: "error",
          });
        });
    },
    [agent, exit, forceUpdate, activeModel, sessionUsage, lastCallTokens, pastTurns, memoryService, paths, resetIdleTimer, clearIdleTimer, resumeSession, initiateSessionResume]
  );

  const toggleLastTool = useCallback(() => {
    if (activeTurnRef.current && activeTurnRef.current.tools.length > 0) {
      const tools = activeTurnRef.current.tools;
      const lastToolIndex = tools.length - 1;
      const newTools = [...tools];
      newTools[lastToolIndex] = { ...newTools[lastToolIndex], expanded: !newTools[lastToolIndex].expanded };
      activeTurnRef.current = { ...activeTurnRef.current, tools: newTools };
      forceUpdate();
      return true;
    }

    const turns = pastTurns;
    if (turns.length > 0) {
      const lastTurnIndex = turns.length - 1;
      const lastTurn = turns[lastTurnIndex];
      if (lastTurn.tools.length > 0) {
        const lastToolIndex = lastTurn.tools.length - 1;
        const newTools = [...lastTurn.tools];
        newTools[lastToolIndex] = { ...newTools[lastToolIndex], expanded: !newTools[lastToolIndex].expanded };
        const newTurns = [...turns];
        newTurns[lastTurnIndex] = { ...lastTurn, tools: newTools };
        setPastTurns(newTurns);
        return true;
      }
    }
    return false;
  }, [pastTurns, forceUpdate]);

  useInput((inputStr, key) => {
    if (showSessionPicker) {
      if (key.upArrow) {
        setSessionPickerIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSessionPickerIndex((i) =>
          Math.min(filteredSessionPickerOptions.length - 1, i + 1),
        );
        return;
      }
      if (key.escape) {
        setShowSessionPicker(false);
        return;
      }
      if (key.return || key.tab) {
        const selected = filteredSessionPickerOptions[sessionPickerIndex];
        if (selected) {
          setShowSessionPicker(false);
          void initiateSessionResume(selected.sessionId, `/session ${selected.sessionId}`);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setSessionPickerFilter((f) => f.slice(0, -1));
        setSessionPickerIndex(0);
        return;
      }
      if (inputStr && !key.ctrl && !key.meta) {
        setSessionPickerFilter((f) => f + inputStr);
        setSessionPickerIndex(0);
        return;
      }
      return;
    }

    if (showModelPicker) {
      if (key.upArrow) {
        setModelPickerIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setModelPickerIndex((i) => Math.min(configModels.length - 1, i + 1));
        return;
      }
      if (key.escape) {
        setShowModelPicker(false);
        return;
      }
      if (key.return || key.tab) {
        const selected = configModels[modelPickerIndex];
        if (selected) {
          try {
            const newModel = resolveModelFromConfig(selected);
            setActiveModel(newModel);
          } catch {
            const errorTurn: CompletedTurn = {
              id: randomUUID(),
              userText: "/model",
              assistantText: "",
              assistantRendered: false,
              tools: [],
              toolOffsets: [],
              aborted: false,
              error: `Failed to switch to model ${selected.provider}/${selected.model}`,
            };
            setPastTurns((prev) => [...prev, errorTurn]);
          }
        }
        setShowModelPicker(false);
        return;
      }
      return;
    }

    if (key.ctrl && inputStr === "e" && !selectionMode) {
      setSelectionMode(true);
      return;
    }

    if (key.ctrl && inputStr === "c") {
      const now = Date.now();
      if (now - lastSigintRef.current < 500) {
        if (!isRunningRef.current) {
          void (async () => {
            if (sessionRef.current) {
              await endSession(sessionRef.current, paths);
            }
            process.exit(130);
          })();
          return;
        }
      }
      lastSigintRef.current = now;

      if (isRunningRef.current && abortControllerRef.current) {
        userAbortedRef.current = true;
        abortCommandRef.current = "ctrl+c";
        abortControllerRef.current.abort();
        if (activeTurnRef.current) {
          activeTurnRef.current = { ...activeTurnRef.current, status: "aborted" };
          forceUpdate();
        }
      }
      return;
    }

    if (key.ctrl && inputStr === "l") {
      setPastTurns([]);
      return;
    }

    if (key.ctrl && inputStr === "o") {
      toggleLastTool();
      return;
    }
  });

  const staticTurns = pastTurns.slice(0, -1);
  const liveTurns = pastTurns.slice(-1);

  return (
    <Box flexDirection="column" width={termSize.columns}>
      <Static items={staticTurns}>
        {(turn) => <TurnView key={turn.id} turn={turn} />}
      </Static>
      <Box flexDirection="column" flexGrow={1}>
        {liveTurns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
        {activeTurnRef.current && <ActiveTurnView turn={activeTurnRef.current} />}
        {configError && (
          <Text color="yellow">Warning: {configError}</Text>
        )}
        {showModelPicker && configModels.length > 0 && (
          <Box flexDirection="column" marginY={1} paddingLeft={2}>
            <Text bold>Select model:</Text>
            {configModels.map((m, idx) => (
              <Text key={`${m.provider}-${m.model}-${idx}`} color={idx === modelPickerIndex ? "cyan" : "gray"} bold={idx === modelPickerIndex}>
                {m.alias} ({m.provider}/{m.model})
              </Text>
            ))}
          </Box>
        )}
        {showSessionPicker && (
          <Box flexDirection="column" marginY={1} paddingLeft={2}>
            <Text bold>Select session:</Text>
            {sessionPickerFilter && (
              <Text dimColor>Filter: {sessionPickerFilter}</Text>
            )}
            {filteredSessionPickerOptions.length === 0 && (
              <Text color="gray">No sessions match.</Text>
            )}
            {filteredSessionPickerOptions.map((s, idx) => {
              const isCurrent = s.sessionId === sessionRef.current?.id;
              const marker = isCurrent ? "● " : "  ";
              return (
                <Text
                  key={`${s.sessionId}-${idx}`}
                  color={idx === sessionPickerIndex ? "cyan" : "gray"}
                  bold={idx === sessionPickerIndex || isCurrent}
                >
                  {marker}{s.sessionId} · {s.created.slice(0, 10)} · {s.model} · {s.turnCount} turns · {formatTokens(s.tokenTotals.totalTokens)} tokens
                </Text>
              );
            })}
          </Box>
        )}
      </Box>
      {selectionMode && (
        <Box marginY={1}>
          <Text bold color="yellow">
            ⬛ Selection mode — scroll & select freely, press Enter to return
          </Text>
        </Box>
      )}
      {!showSessionPicker && (
        <PromptInput onSubmit={handleSubmit} history={inputHistory} commands={slashCommands} paused={selectionMode} />
      )}
      <StatusBar modelId={activeModel.id} status={status} usage={sessionUsage} lastCallTokens={lastCallTokens} contextWindow={activeModel.contextWindow} />
    </Box>
  );
}

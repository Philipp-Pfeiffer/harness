import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout, useStdin, Static } from "ink";
import chalk, { Chalk } from "chalk";
import { marked } from "marked";
import MarkedTerminalRenderer from "marked-terminal";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createAgent,
  resolveModel,
  resolveModelFromConfig,
  loadTools,
  prompt,
  loadConfig,
  resolveHarnessPaths,
  type ConfigModel,
  type WebConfig,
  type BrowserConfig,
  type ImageConfig,
  type HarnessPaths,
} from "@harness/core";
import { loadCoreMemoryRaw } from "../core/coreMemory.js";
import { buildSystemPrompt } from "../core/systemPrompt.js";
import type { Model, Api } from "@mariozechner/pi-ai";
import { slashCommands, filterCommands, type SlashCommandInfo } from "./commands.js";
import { isStatusCommand, handleStatusCommand } from "./statusCommand.js";
import {
  loadSession,
  listSessionsWithDetails,
  SESSION_LOAD_WARN_THRESHOLD,
  type SessionTurn,
  type SessionListDetail,
} from "../core/session.js";
import {
  isSessionCommand,
  parseSessionCommand,
  formatSessionLoadWarning,
} from "./sessionCommand.js";
import type { AgentBackend, BackendEvent, TurnResult } from "../backends/types.js";
import { ViewportPicker, getPickerViewport } from "./ViewportPicker.js";
import {
  filterPickerItems,
  handlePickerKey,
} from "./picker.js";

/* ─── marked config ───
   Use a dedicated chalk instance with full ANSI level so that markdown
   formatting (bold, italic, colors) is always emitted. The ambient chalk
   instance may downgrade to level 0 (e.g. NO_COLOR), which strips the
   formatting that Ink needs to render styled text.

   marked-terminal's default listitem renderer uses the block parser for
   list item tokens, which drops nested inline formatting (e.g. **bold**
   inside a bullet). We build the extension manually so we can override
   listitem to parse inline tokens correctly. */

const mdChalk = new Chalk({ level: 3 });

const mdRenderer = new (MarkedTerminalRenderer as any)({
  tab: 2,
  showSectionPrefix: false,
  firstHeading: mdChalk.cyan.bold.underline,
  heading: mdChalk.cyan.bold,
  strong: mdChalk.bold,
  em: mdChalk.italic,
  codespan: (text: string) => mdChalk.gray(`\`${text}\``),
  code: mdChalk.gray,
  blockquote: mdChalk.gray.italic,
  hr: mdChalk.reset,
  table: mdChalk.reset,
  link: mdChalk.blue,
  href: mdChalk.blue.underline,
  width: process.stdout.columns || 80,
});

const rendererMethods = [
  "text",
  "code",
  "blockquote",
  "html",
  "heading",
  "hr",
  "list",
  "listitem",
  "checkbox",
  "paragraph",
  "table",
  "tablerow",
  "tablecell",
  "strong",
  "em",
  "codespan",
  "br",
  "del",
  "link",
  "image",
] as const;

const markedExtension: any = { renderer: {}, useNewRenderer: true };
for (const method of rendererMethods) {
  markedExtension.renderer[method] = function (...args: unknown[]) {
    mdRenderer.options = (this as any).options;
    mdRenderer.parser = (this as any).parser;
    return (mdRenderer as any)[method](...args);
  };
}

mdRenderer.listitem = function (item: any) {
  const body = item.tokens
    .map((token: any) => {
      if (token.type === "text" && token.tokens) {
        return this.parser.parseInline(token.tokens);
      }
      if (token.type === "list") {
        return "\n" + this.parser.parse([token]);
      }
      return this.parser.parse([token]);
    })
    .join("");
  return "\n  • " + body;
};

marked.use(markedExtension);

function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
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
  thinkingText?: string;
  tools: ToolItem[];
  toolOffsets: number[];
  aborted: boolean;
  error?: string;
  help?: boolean;
};

type ActiveTurn = {
  userText: string;
  assistantText: string;
  thinkingText: string;
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
    aborted: turn.aborted ?? false,
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

function StatusBar({ modelId, status, usage, lastCallTokens, contextWindow, workspace }: { modelId: string; status: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; lastCallTokens?: number; contextWindow?: number; workspace: string }) {
  const statusColor =
    status === "ready"
      ? "green"
      : status === "thinking"
        ? "yellow"
        : status === "compacting"
          ? "magenta"
          : status === "aborted"
            ? "gray"
            : "cyan";

  const cwd = workspace;
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

function TurnView({ turn, showThinking }: { turn: CompletedTurn; showThinking: boolean }) {
  const content = renderTurnContent(turn.assistantText, turn.tools, turn.toolOffsets, turn.assistantRendered);

  return (
    <Box flexDirection="column">
      <Text color="cyan">❯ {turn.userText}</Text>
      {turn.thinkingText && showThinking ? (
        <Box flexDirection="column" marginY={0}>
          <Text italic color="gray">┌ thinking</Text>
          <Text italic color="gray" wrap="truncate">{turn.thinkingText.slice(-2000)}</Text>
          <Text italic color="gray">└</Text>
        </Box>
      ) : null}
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

function ActiveTurnView({ turn, showThinking }: { turn: ActiveTurn; showThinking: boolean }) {
  const content = renderTurnContent(turn.assistantText, turn.tools, turn.toolOffsets, false);

  return (
    <Box flexDirection="column">
      <Text color="cyan">❯ {turn.userText}</Text>
      {turn.thinkingText && showThinking ? (
        <Box flexDirection="column" marginY={0}>
          <Text italic color="gray">┌ thinking</Text>
          <Text italic color="gray" wrap="truncate">{turn.thinkingText.slice(-2000)}</Text>
          <Text italic color="gray">└</Text>
        </Box>
      ) : null}
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
  terminalRows = 24,
  pickerReservedRows = 6,
}: {
  onSubmit: (v: string) => void;
  history: string[];
  commands?: SlashCommandInfo[];
  paused?: boolean;
  terminalRows?: number;
  pickerReservedRows?: number;
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
      const { listRows } = getPickerViewport({
        items: filtered.map((cmd) => ({ key: cmd.name, label: cmd.name })),
        selectedIndex: pickerIndex,
        terminalRows,
        reservedRows: pickerReservedRows,
        showFilter: false,
      });
      const action = handlePickerKey(
        {
          upArrow: key.upArrow && !key.shift,
          downArrow: key.downArrow && !key.shift,
          pageUp: key.pageUp,
          pageDown: key.pageDown,
          escape: key.escape,
          return: key.return,
          tab: key.tab,
        },
        { selectedIndex: pickerIndex, filter: "" },
        filtered.length,
        listRows,
        { filterable: false },
      );
      if (action.type === "close") {
        setPickerOpen(false);
        setPickerIndex(0);
        return;
      }
      if (action.type === "select" && filtered.length > 0) {
        const cmd = filtered[pickerIndex] ?? filtered[0];
        valueRef.current = cmd.name;
        cursorOffsetRef.current = cmd.name.length;
        clearSelection();
        setPickerOpen(false);
        setPickerIndex(0);
        setRenderTick((t) => t + 1);
        return;
      }
      if (action.type === "update") {
        setPickerIndex(action.selectedIndex);
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

  const slashPickerItems = filteredCommands.map((cmd) => ({
    key: cmd.name,
    label: `${cmd.name}  – ${cmd.description}`,
  }));

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
      {pickerOpen && slashPickerItems.length > 0 && (
        <ViewportPicker
          title="Commands"
          items={slashPickerItems}
          selectedIndex={pickerIndex}
          showFilter={false}
          terminalRows={terminalRows}
          reservedRows={pickerReservedRows}
        />
      )}
    </Box>
  );
}

/* ─── Main App ─── */

export default function App({
  configPath,
  memoryService,
  paths: pathsProp,
  backend,
  webConfig: webConfigProp,
  configModels: configModelsProp,
  configDefaultModel: configDefaultModelProp,
  configError: configErrorProp,
  initialSessionId,
}: {
  configPath?: string;
  memoryService?: import("../core/memoryService.js").MemoryService;
  paths?: HarnessPaths;
  backend: AgentBackend;
  webConfig?: WebConfig;
  configModels?: ConfigModel[];
  configDefaultModel?: ConfigModel;
  configError?: string;
  initialSessionId?: string;
}) {
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
  const [showThinking, setShowThinking] = useState(true);

  const historyRef = useRef<string[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const abortingRef = useRef(false);
  const userAbortedRef = useRef(false);
  const lastSigintRef = useRef(0);
  const isRunningRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const pendingResumeRef = useRef<{ sessionId: string; tokens: number } | null>(null);
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

  const [webConfig, setWebConfig] = useState<WebConfig | undefined>(webConfigProp);
  const [browserConfig, setBrowserConfig] = useState<BrowserConfig | undefined>(undefined);
  const [imageConfig, setImageConfig] = useState<ImageConfig | undefined>(undefined);
  const [configModels, setConfigModels] = useState<ConfigModel[]>(configModelsProp ?? []);
  const [configDefaultModel, setConfigDefaultModel] = useState<ConfigModel | undefined>(configDefaultModelProp);
  const [configError, setConfigError] = useState<string | undefined>(configErrorProp);

  // Model/tool setup is only relevant for InProcessBackend.
  // DaemonClientBackend delegates to the daemon which has its own model.
  const tools = useMemo(
    () => loadTools({
      memoryBackend: memoryService?.getBackend(),
      webConfig,
      browser: configModels.length > 0
        ? {
            config: browserConfig,
            defaultModel: configDefaultModel,
            models: configModels,
            downloadsBaseDir: join(paths.state, "downloads"),
            browserRunsDir: paths.browserRuns,
          }
        : undefined,
      image: configModels.length > 0
        ? {
            config: imageConfig,
            defaultModel: configDefaultModel,
            models: configModels,
          }
        : undefined,
    }),
    [memoryService, webConfig, browserConfig, imageConfig, configModels, configDefaultModel, paths],
  );
  const [activeModel, setActiveModel] = useState<Model<Api>>(() => resolveModel("minimax", "MiniMax-M2.7"));
  const inProcessAgent = useMemo(() => createAgent({ tools, model: activeModel, inlineThinking: (activeModel as any).inlineThinking ?? false }), [tools, activeModel]);
  useEffect(() => {
    inProcessAgent.setModel(activeModel);
  }, [inProcessAgent, activeModel]);

  // Keep InProcessBackend's model in sync when the user switches models.
  useEffect(() => {
    if (backend.name === "in-process" && "setModel" in backend) {
      (backend as { setModel: (m: Model<Api>) => void }).setModel(activeModel);
    }
  }, [backend, activeModel]);

  useEffect(() => {
    if (backend.name !== "in-process") return;
    (async () => {
      const coreMemory = await loadCoreMemoryRaw(paths.core);
      const basePrompt = prompt("system-prompt", { inboxPath: paths.inbox });
      const composed = buildSystemPrompt({
        basePrompt,
        coreMemoryRaw: coreMemory,
        activeToolNames: tools.map((t) => t.name),
      });
      inProcessAgent.setSystemPrompt(composed);
      console.log(`[harness] core memory loaded: ${coreMemory ? coreMemory.length : 0} chars`);
    })();
  }, [inProcessAgent, tools, backend, paths]);

  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [modelPickerFilter, setModelPickerFilter] = useState("");
  const [abortStatusMessage, setAbortStatusMessage] = useState<string | null>(null);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [sessionPickerIndex, setSessionPickerIndex] = useState(0);
  const [sessionPickerOptions, setSessionPickerOptions] = useState<SessionListDetail[]>([]);
  const [sessionPickerFilter, setSessionPickerFilter] = useState("");

  // Load config only if not already provided via props.
  useEffect(() => {
    if (configModelsProp || configDefaultModelProp || webConfigProp || configErrorProp) {
      setConfigModels(configModelsProp ?? []);
      setConfigDefaultModel(configDefaultModelProp);
      setWebConfig(webConfigProp);
      if (configErrorProp) setConfigError(configErrorProp);
      return;
    }
    (async () => {
      const result = await loadConfig({ configPath, harnessHome: paths.home });
      setConfigModels(result.models);
      setConfigDefaultModel(result.defaultModel);
      setWebConfig(result.webConfig);
      setBrowserConfig(result.browserConfig);
      setImageConfig(result.imageConfig);
      if (result.error) {
        setConfigError(result.error);
      }
    })();
  }, [configPath, paths.home, configModelsProp, configDefaultModelProp, webConfigProp, configErrorProp]);

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
      // If initialSessionId provided (e.g. `harness chat --session <id>`), resume it.
      if (initialSessionId) {
        try {
          await resumeSession(initialSessionId);
          return;
        } catch (err) {
          console.error("[harness] failed to resume session:", err instanceof Error ? err.message : String(err));
          // fall through to create a new session
        }
      }
      // For daemon backend with no initialSessionId, show session picker.
      if (backend.name === "daemon" && !initialSessionId) {
        try {
          const sessions = await backend.listSessions();
          // Only show picker if there are sessions to pick from
          if (sessions.length > 0) {
            // Populate the session picker with backend sessions
            const details: SessionListDetail[] = sessions.map((s) => ({
              sessionId: s.sessionId,
              created: s.createdAt,
              lastActivity: s.lastActiveAt,
              model: s.model,
              tokenTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
              title: s.title,
              status: s.status,
              turnCount: s.turnsCompleted,
              tokenEstimate: 0,
            }));
            setSessionPickerOptions(details);
            setSessionPickerIndex(0);
            setSessionPickerFilter("");
            setShowSessionPicker(true);
            return;
          }
        } catch (err) {
          console.error("[harness] failed to list sessions:", err instanceof Error ? err.message : String(err));
        }
      }
      try {
        const { sessionId } = await backend.createSession({
          model: activeModel.id,
          title: "CLI Session",
        });
        sessionIdRef.current = sessionId;
      } catch (err) {
        console.error("[harness] failed to create session:", err instanceof Error ? err.message : String(err));
      }
    })();
  }, [backend, initialSessionId]);

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
      if (sessionIdRef.current) {
        const sid = sessionIdRef.current;
        void backend.endSession(sid)
          .then(() => {
            sessionIdRef.current = null;
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
  }, [clearIdleTimer, backend]);

  // Cleanup idle timer and end active session on unmount.
  useEffect(() => {
    return () => {
      clearIdleTimer();
      if (sessionIdRef.current) {
        void backend.endSession(sessionIdRef.current).catch((err) => {
          console.error("[harness] failed to end session:", err instanceof Error ? err.message : String(err));
        });
      }
    };
  }, [clearIdleTimer, backend]);

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
      if (sessionIdRef.current) {
        await backend.endSession(sessionIdRef.current);
        sessionIdRef.current = null;
      }

      const data = await backend.resumeSession(sessionId);

      const targetModel = resolveModelByName(data.model ?? "") ?? activeModel;
      if (targetModel.id !== activeModel.id) {
        setActiveModel(targetModel);
      }

      sessionIdRef.current = sessionId;

      const replayTurns = data.turns.map(turnToCompletedTurn);
      const infoTurn: CompletedTurn = {
        id: randomUUID(),
        userText: "",
        assistantText: `Resumed session ${sessionId} (${replayTurns.length} turns, ~${formatTokens(data.tokenEstimate)} tokens)`,
        assistantRendered: false,
        tools: [],
        toolOffsets: [],
        aborted: false,
      };
      setPastTurns([...replayTurns, infoTurn]);
      setLastCallTokens(data.tokenEstimate);
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
    const sorted = [...sessionPickerOptions].sort((a, b) =>
      b.lastActivity.localeCompare(a.lastActivity),
    );
    return filterPickerItems(
      sorted,
      sessionPickerFilter,
      (s) => `${s.sessionId} ${s.title} ${s.model ?? ""}`,
    );
  }, [sessionPickerOptions, sessionPickerFilter]);

  const filteredModelPickerOptions = useMemo(() => {
    return filterPickerItems(
      configModels,
      modelPickerFilter,
      (m) => `${m.alias} ${m.provider} ${m.model}`,
    );
  }, [configModels, modelPickerFilter]);

  const pickerReservedRows =
    3 + (activeTurnRef.current ? 8 : pastTurns.length > 0 ? 5 : 2);

  const abortCurrentTurn = useCallback(() => {
    if (!isRunningRef.current || !abortControllerRef.current || abortingRef.current) {
      return;
    }
    abortingRef.current = true;
    userAbortedRef.current = true;
    abortControllerRef.current.abort();
    if (activeTurnRef.current) {
      activeTurnRef.current = { ...activeTurnRef.current, status: "aborted" };
      forceUpdate();
    }
    setAbortStatusMessage("turn aborted");
    setTimeout(() => setAbortStatusMessage(null), 3000);
  }, [forceUpdate]);

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
      // The following slash commands are daemon-side when using DaemonClientBackend.
      // They fall through to backend.runTurn() for daemon mode.
      const isDaemon = backend.name === "daemon";

      if (trimmed === "/new" && !isDaemon) {
        try {
          if (sessionIdRef.current) {
            await backend.endSession(sessionIdRef.current);
          }
          const { sessionId } = await backend.createSession({ model: activeModel.id, title: "CLI Session" });
          sessionIdRef.current = sessionId;
          historyRef.current = [];
          setPastTurns([]);
          setSessionUsage(undefined);
          setLastCallTokens(undefined);
          const infoTurn: CompletedTurn = {
            id: randomUUID(),
            userText: trimmed,
            assistantText: `Started new session: ${sessionId}`,
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
      if (trimmed === "/end" && !isDaemon) {
        try {
          if (sessionIdRef.current) {
            await backend.endSession(sessionIdRef.current);
            sessionIdRef.current = null;
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
          if (sessionIdRef.current) {
            await backend.endSession(sessionIdRef.current);
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
        setModelPickerFilter("");
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
      if (trimmed === "/showthink") {
        const newVal = !showThinking;
        setShowThinking(newVal);
        const infoTurn: CompletedTurn = {
          id: randomUUID(),
          userText: trimmed,
          assistantText: `Thinking blocks ${newVal ? "visible" : "hidden"}.`,
          assistantRendered: false,
          tools: [],
          toolOffsets: [],
          aborted: false,
        };
        setPastTurns((prev) => [...prev, infoTurn]);
        return;
      }
      if (isStatusCommand(trimmed)) {
        const statusText = await handleStatusCommand(trimmed, {
          model: activeModel.id,
          contextWindow: activeModel.contextWindow,
          workspace: paths.home,
          sessionState: isRunningRef.current ? "active" : "ready",
          sessionId: sessionIdRef.current ?? undefined,
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
      if (isSessionCommand(trimmed) && !isDaemon) {
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
      if (trimmed.startsWith("/") && !isDaemon) {
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
          abortCurrentTurn();
        }
        return;
      }

      // Ensure an active session exists (e.g. after /end or idle timeout).
      if (!sessionIdRef.current) {
        try {
          const { sessionId } = await backend.createSession({ model: activeModel.id, title: "CLI Session" });
          sessionIdRef.current = sessionId;
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

      activeTurnRef.current = { userText: trimmed, assistantText: "", thinkingText: "", tools: [], toolOffsets: [], status: "thinking", steers: [] };
      isRunningRef.current = true;
      forceUpdate();

      const controller = new AbortController();
      abortControllerRef.current = controller;
      userAbortedRef.current = false;

      backend
        .runTurn(
          trimmed,
          sessionIdRef.current!,
          (event: BackendEvent) => {
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
            } else if (event.type === "thinking") {
              if (activeTurnRef.current) {
                activeTurnRef.current = {
                  ...activeTurnRef.current,
                  thinkingText: activeTurnRef.current.thinkingText + event.text,
                  status: "thinking",
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
            } else if (event.type === "status") {
              if (activeTurnRef.current) {
                activeTurnRef.current = { ...activeTurnRef.current, status: event.status as ActiveTurn["status"] };
                forceUpdate();
              }
            } else if (event.type === "usage") {
              setLastCallTokens(event.totalTokens);
            }
          },
          controller.signal,
          { model: activeModel.id },
        )
        .then((result: TurnResult) => {
          // Daemon-side slash commands (e.g. /new) may return a new session ID
          if (result.sessionId && result.sessionId !== sessionIdRef.current) {
            sessionIdRef.current = result.sessionId;
          }
          if (activeTurnRef.current) {
            const turn = activeTurnRef.current;
            const completedTurn: CompletedTurn = {
              id: randomUUID(),
              userText: turn.userText,
              assistantText: turn.assistantText || (!result.aborted ? result.finalResponse : ""),
              assistantRendered: !result.aborted && !userAbortedRef.current && turn.status !== "error",
              thinkingText: turn.thinkingText || undefined,
              tools: turn.tools,
              toolOffsets: turn.toolOffsets,
              aborted: result.aborted || userAbortedRef.current,
              error: turn.status === "error" ? turn.tools.find((t) => t.status === "error")?.preview : undefined,
            };
            setPastTurns((prev) => [...prev, completedTurn]);
            activeTurnRef.current = null;
            isRunningRef.current = false;
            forceUpdate();
          }
          if (result.usage) {
            setSessionUsage((prev) =>
              prev
                ? {
                    inputTokens: prev.inputTokens + result.usage!.inputTokens,
                    outputTokens: prev.outputTokens + result.usage!.outputTokens,
                    totalTokens: prev.totalTokens + result.usage!.totalTokens,
                    cacheRead: prev.cacheRead + result.usage!.cacheRead,
                    cacheWrite: prev.cacheWrite + result.usage!.cacheWrite,
                  }
                : result.usage,
            );
            if (!result.aborted && result.turnsCompleted <= 1) {
              setLastCallTokens(result.usage.totalTokens);
            }
          }
          abortControllerRef.current = null;
          userAbortedRef.current = false;
          abortingRef.current = false;
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
          }
          abortControllerRef.current = null;
          userAbortedRef.current = false;
          abortingRef.current = false;
        });
    },
    [backend, exit, forceUpdate, activeModel, sessionUsage, lastCallTokens, pastTurns, memoryService, paths, resetIdleTimer, clearIdleTimer, resumeSession, initiateSessionResume, abortCurrentTurn]
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
      const { listRows } = getPickerViewport({
        items: filteredSessionPickerOptions.map((s) => ({ key: s.sessionId, label: s.sessionId })),
        selectedIndex: sessionPickerIndex,
        terminalRows: termSize.rows,
        reservedRows: pickerReservedRows,
      });
      const action = handlePickerKey(
        {
          upArrow: key.upArrow,
          downArrow: key.downArrow,
          pageUp: key.pageUp,
          pageDown: key.pageDown,
          escape: key.escape,
          return: key.return,
          tab: key.tab,
          backspace: key.backspace,
          delete: key.delete,
          inputStr,
          ctrl: key.ctrl,
          meta: key.meta,
        },
        { selectedIndex: sessionPickerIndex, filter: sessionPickerFilter },
        filteredSessionPickerOptions.length,
        listRows,
      );
      if (action.type === "close") {
        setShowSessionPicker(false);
        return;
      }
      if (action.type === "select") {
        const selected = filteredSessionPickerOptions[sessionPickerIndex];
        if (selected) {
          setShowSessionPicker(false);
          void initiateSessionResume(selected.sessionId, `/session ${selected.sessionId}`);
        }
        return;
      }
      if (action.type === "update") {
        setSessionPickerIndex(action.selectedIndex);
        setSessionPickerFilter(action.filter);
        return;
      }
      return;
    }

    if (showModelPicker) {
      const { listRows } = getPickerViewport({
        items: filteredModelPickerOptions.map((m) => ({
          key: `${m.provider}-${m.model}`,
          label: m.alias,
        })),
        selectedIndex: modelPickerIndex,
        terminalRows: termSize.rows,
        reservedRows: pickerReservedRows,
      });
      const action = handlePickerKey(
        {
          upArrow: key.upArrow,
          downArrow: key.downArrow,
          pageUp: key.pageUp,
          pageDown: key.pageDown,
          escape: key.escape,
          return: key.return,
          tab: key.tab,
          backspace: key.backspace,
          delete: key.delete,
          inputStr,
          ctrl: key.ctrl,
          meta: key.meta,
        },
        { selectedIndex: modelPickerIndex, filter: modelPickerFilter },
        filteredModelPickerOptions.length,
        listRows,
      );
      if (action.type === "close") {
        setShowModelPicker(false);
        return;
      }
      if (action.type === "select") {
        const selected = filteredModelPickerOptions[modelPickerIndex];
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
      if (action.type === "update") {
        setModelPickerIndex(action.selectedIndex);
        setModelPickerFilter(action.filter);
        return;
      }
      return;
    }

    if (key.escape && isRunningRef.current) {
      abortCurrentTurn();
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
            if (sessionIdRef.current) {
              await backend.endSession(sessionIdRef.current);
            }
            process.exit(130);
          })();
          return;
        }
      }
      lastSigintRef.current = now;

      if (isRunningRef.current && abortControllerRef.current) {
        abortCurrentTurn();
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
        {(turn) => <TurnView key={turn.id} turn={turn} showThinking={showThinking} />}
      </Static>
      <Box flexDirection="column" flexGrow={1}>
        {liveTurns.map((turn) => (
          <TurnView key={turn.id} turn={turn} showThinking={showThinking} />
        ))}
        {activeTurnRef.current && <ActiveTurnView turn={activeTurnRef.current} showThinking={showThinking} />}
        {configError && (
          <Text color="yellow">Warning: {configError}</Text>
        )}
        {showModelPicker && (
          <ViewportPicker
            title="Select model:"
            items={filteredModelPickerOptions.map((m) => ({
              key: `${m.provider}-${m.model}`,
              label: `${m.alias} (${m.provider}/${m.model})`,
            }))}
            selectedIndex={modelPickerIndex}
            filter={modelPickerFilter}
            terminalRows={termSize.rows}
            reservedRows={pickerReservedRows}
            emptyMessage="No models match."
          />
        )}
        {showSessionPicker && (
          <ViewportPicker
            title="Select session:"
            items={filteredSessionPickerOptions.map((s) => ({
              key: s.sessionId,
              label: `${s.sessionId === sessionIdRef.current ? "● " : "  "}${s.sessionId} · ${s.created.slice(0, 10)} · ${s.model} · ${s.turnCount}t · ${s.status}`,
            }))}
            selectedIndex={sessionPickerIndex}
            filter={sessionPickerFilter}
            terminalRows={termSize.rows}
            reservedRows={pickerReservedRows}
            emptyMessage="No sessions match."
          />
        )}
        {abortStatusMessage && (
          <Text color="gray" italic>{abortStatusMessage}</Text>
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
        <PromptInput
          onSubmit={handleSubmit}
          history={inputHistory}
          commands={slashCommands}
          paused={selectionMode}
          terminalRows={termSize.rows}
          pickerReservedRows={pickerReservedRows}
        />
      )}
      <StatusBar modelId={activeModel.id} status={status} usage={sessionUsage} lastCallTokens={lastCallTokens} contextWindow={activeModel.contextWindow} workspace={paths.home} />
    </Box>
  );
}

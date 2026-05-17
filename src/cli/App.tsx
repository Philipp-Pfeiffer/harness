import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout, Static } from "ink";
import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { randomUUID } from "node:crypto";
import { createAgent } from "../core/agent.js";
import { createMailbox } from "../core/mailbox.js";
import { resolveModel } from "../core/resolveModel.js";
import { loadTools } from "../tools/registry.js";
import type { Message, Model, Api } from "@mariozechner/pi-ai";
import type { AgentEvent, RunResult } from "../core/agent.js";
import type { Mailbox } from "../core/mailbox.js";
import { slashCommands, filterCommands, type SlashCommandInfo } from "./commands.js";
import { loadConfig, type ConfigModel } from "./config.js";

/* ─── marked config ─── */

marked.use(
  (markedTerminal({
    heading: chalk.cyan.bold,
    firstHeading: chalk.cyan.bold,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.dim,
    code: chalk.dim,
    blockquote: chalk.gray.italic,
    hr: chalk.gray,
    table: chalk.reset,
    link: chalk.blue,
    href: chalk.blue.underline,
    width: process.stdout.columns || 80,
  }) as any)
);

/* ─── Types ─── */

export type ToolItem = {
  id: string;
  name: string;
  status: "pending" | "done" | "error";
  preview: string;
  result?: string;
  expanded?: boolean;
};

type CompletedTurn = {
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
  return `${(n / 1000).toFixed(1)}k`;
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

function StatusBar({ modelId, status, usage, contextWindow }: { modelId: string; status: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; contextWindow?: number }) {
  const statusColor =
    status === "ready"
      ? "green"
      : status === "thinking"
        ? "yellow"
        : status === "aborted"
          ? "gray"
          : "cyan";

  const cwd = process.cwd();
  const used = usage?.totalTokens ?? 0;
  const usedStr = formatTokens(used);
  const maxStr = contextWindow ? formatTokens(contextWindow) : "?";

  let counterColor: string | undefined;
  if (contextWindow) {
    const ratio = used / contextWindow;
    if (ratio > 0.95) counterColor = "red";
    else if (ratio > 0.8) counterColor = "yellow";
  }

  return (
    <Box width="100%" height={1}>
      <Text bold color="cyan">
        harness
      </Text>
      <Text dimColor> · </Text>
      <Text dimColor>{modelId}</Text>
      <Text dimColor> · </Text>
      <Text color={statusColor}>{status}</Text>
      {usage !== undefined && (
        <>
          <Text dimColor> · </Text>
          <Text color={counterColor}>{usedStr} / {maxStr}</Text>
        </>
      )}
      <Text dimColor> · </Text>
      <Text dimColor>{cwd}</Text>
    </Box>
  );
}

function ToolCard({ item, isLast }: { item: ToolItem; isLast: boolean }) {
  const symbol = item.status === "pending" ? "▸" : item.status === "done" ? "✓" : "✗";
  const borderFn = item.status === "error" ? chalk.red : item.status === "done" ? chalk.green : chalk.gray;
  const iconColor = item.status === "error" ? "red" : item.status === "done" ? "green" : "yellow";
  const width = Math.max(20, (process.stdout.columns || 80) - 4);

  const titleContent = `${symbol} ${item.name}${isLast ? " ── Ctrl+O ─" : ""}`;
  const titleLine = `${borderFn("┌─")} ${titleContent} ${borderFn("─".repeat(Math.max(0, width - titleContent.length - 5)) + "┐")}`;
  const bottomLine = borderFn("└" + "─".repeat(width) + "┘");

  const body = item.expanded && item.result
    ? item.result.split("\n").map((line) => `${borderFn("│")} ${line}`).join("\n")
    : item.expanded && item.preview
      ? `${borderFn("│")} ${item.preview}`
      : null;

  const previewLine = !item.expanded && item.preview
    ? `${borderFn("│")} ${item.preview}`
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
          <Text>{assistantRendered ? (marked.parse(textSlice) as string) : textSlice}</Text>
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
        <Text>{assistantRendered ? (marked.parse(remainingText) as string) : remainingText}</Text>
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
  isRunning,
  commands,
}: {
  onSubmit: (v: string) => void;
  history: string[];
  isRunning: boolean;
  commands?: SlashCommandInfo[];
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
    const id = setInterval(() => {
      blinkRef.current = !blinkRef.current;
      setRenderTick((t) => t + 1);
    }, 530);
    return () => clearInterval(id);
  }, []);

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
    if (key.ctrl && (inputStr === "c" || inputStr === "l" || inputStr === "o")) {
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
      if (!isRunning) {
        onSubmit(currentValue);
        valueRef.current = "";
        cursorOffsetRef.current = 0;
        clearSelection();
        historyIndexRef.current = -1;
      }
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

export default function App({ configPath }: { configPath?: string } = {}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [termSize, setTermSize] = useState({ columns: stdout.columns, rows: stdout.rows });
  const [pastTurns, setPastTurns] = useState<CompletedTurn[]>([]);
  const activeTurnRef = useRef<ActiveTurn | null>(null);
  const forceUpdate = useForceUpdate();
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [sessionUsage, setSessionUsage] = useState<{ inputTokens: number; outputTokens: number; totalTokens: number } | undefined>(undefined);

  const historyRef = useRef<Message[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const userAbortedRef = useRef(false);
  const lastSigintRef = useRef(0);
  const isRunningRef = useRef(false);
  const mailboxRef = useRef<Mailbox>(createMailbox());

  useEffect(() => {
    const handleResize = () => {
      setTermSize({ columns: stdout.columns, rows: stdout.rows });
    };
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  const tools = useMemo(() => loadTools(), []);
  const [activeModel, setActiveModel] = useState<Model<Api>>(() => resolveModel("minimax", "MiniMax-M2.7"));
  const agent = useMemo(() => createAgent({ tools, model: activeModel }), [tools]);
  useEffect(() => {
    agent.setModel(activeModel);
  }, [agent, activeModel]);

  const [configModels, setConfigModels] = useState<ConfigModel[]>([]);
  const [configError, setConfigError] = useState<string | undefined>(undefined);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);

  useEffect(() => {
    (async () => {
      const result = await loadConfig({ configPath });
      setConfigModels(result.models);
      if (result.error) {
        setConfigError(result.error);
      }
    })();
  }, [configPath]);

  const status = activeTurnRef.current
    ? activeTurnRef.current.status === "tool"
      ? `tool: ${activeTurnRef.current.tools[activeTurnRef.current.tools.length - 1]?.name || ""}`
      : activeTurnRef.current.status
    : "ready";

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (trimmed === "/clear") {
        setPastTurns([]);
        historyRef.current = [];
        return;
      }
      if (trimmed === "/quit") {
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
        return;
      }

      setInputHistory((prev) => [...prev, trimmed]);
      historyRef.current.push({ role: "user", content: trimmed, timestamp: Date.now() });

      activeTurnRef.current = { userText: trimmed, assistantText: "", tools: [], toolOffsets: [], status: "thinking", steers: [] };
      isRunningRef.current = true;
      forceUpdate();

      const controller = new AbortController();
      abortControllerRef.current = controller;
      userAbortedRef.current = false;

      agent
        .run(historyRef.current, {
          signal: controller.signal,
          mailbox: mailboxRef.current,
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
                    { id: randomUUID(), name: event.name, status: "pending", preview: "" },
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
              setSessionUsage({ inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens });
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
          }
          if (result.usage) {
            setSessionUsage(result.usage);
          }
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
          }
          abortControllerRef.current = null;
          userAbortedRef.current = false;
        });
    },
    [agent, exit, forceUpdate]
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
            const newModel = resolveModel(selected.provider, selected.model);
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

    if (key.ctrl && inputStr === "c") {
      const now = Date.now();
      if (now - lastSigintRef.current < 500) {
        if (!isRunningRef.current) {
          process.exit(130);
        }
      }
      lastSigintRef.current = now;

      if (isRunningRef.current && abortControllerRef.current) {
        userAbortedRef.current = true;
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
      </Box>
      <PromptInput onSubmit={handleSubmit} history={inputHistory} isRunning={isRunningRef.current} commands={slashCommands} />
      <StatusBar modelId={activeModel.id} status={status} usage={sessionUsage} contextWindow={activeModel.contextWindow} />
    </Box>
  );
}

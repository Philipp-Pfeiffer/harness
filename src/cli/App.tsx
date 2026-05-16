import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import chalk from "chalk";
import { createAgent } from "../core/agent.js";
import { getModel } from "@mariozechner/pi-ai";
import { loadTools } from "../tools/registry.js";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentEvent, RunResult } from "../core/agent.js";

type UiItem =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; status: "pending" | "done" | "error"; preview: string; expanded?: boolean }
  | { type: "abort" }
  | { type: "error"; message: string }
  | { type: "help" };

type MarkdownPart = { type: "text" | "bold" | "italic" | "code"; text: string };

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

function parseMarkdown(text: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  const regex = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    if (match[1]) {
      parts.push({ type: "bold", text: match[2] });
    } else if (match[3]) {
      parts.push({ type: "italic", text: match[4] });
    } else if (match[5]) {
      parts.push({ type: "code", text: match[6] });
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({ type: "text", text: text.slice(lastIndex) });
  }

  return parts;
}

/* ─── Sub-components ─── */

function Header({ modelId, status }: { modelId: string; status: string }) {
  const statusColor =
    status === "ready" ? "green" : status === "thinking" ? "yellow" : status === "aborted" ? "gray" : "cyan";

  return (
    <Box marginBottom={1}>
      <Text bold color="cyan">
        harness
      </Text>
      <Text dimColor> · </Text>
      <Text dimColor>{modelId}</Text>
      <Text dimColor> · </Text>
      <Text color={statusColor}>{status}</Text>
    </Box>
  );
}

function AssistantText({ text }: { text: string }) {
  const parts = parseMarkdown(text);
  if (parts.length === 0) return <Text />;

  return (
    <Box flexDirection="row" flexWrap="wrap">
      {parts.map((part, i) => {
        switch (part.type) {
          case "bold":
            return (
              <Text key={i} bold>
                {part.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} italic>
                {part.text}
              </Text>
            );
          case "code":
            return (
              <Text key={i} backgroundColor="gray" color="white">
                {" "}{part.text}{" "}
              </Text>
            );
          default:
            return <Text key={i}>{part.text}</Text>;
        }
      })}
    </Box>
  );
}

function ToolCard({ item, isLast }: { item: Extract<UiItem, { type: "tool" }>; isLast: boolean }) {
  const symbol = item.status === "pending" ? "▸" : item.status === "done" ? "✓" : "✗";
  const borderFn = item.status === "error" ? chalk.red : item.status === "done" ? chalk.green : chalk.gray;
  const iconColor = item.status === "error" ? "red" : item.status === "done" ? "green" : "yellow";

  const titleLine = `${borderFn("┌─")} ${symbol} ${item.name}${isLast ? borderFn(" ── Ctrl+O ─") : ""} ${borderFn("┐")}`;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={iconColor}>{titleLine}</Text>
      {item.expanded && (
        <>
          <Text>
            {borderFn("│")} {item.preview}
          </Text>
          <Text>{borderFn("└───────────────────────────┘")}</Text>
        </>
      )}
    </Box>
  );
}

function HelpCard() {
  return (
    <Box flexDirection="column" marginY={1} paddingX={1} borderStyle="single" borderColor="gray">
      <Text bold>Commands</Text>
      <Text>  /clear  – Clear history</Text>
      <Text>  /quit   – Exit</Text>
      <Text>  /help   – Show this help</Text>
      <Text bold>Keybinds</Text>
      <Text>  Ctrl+O  – Toggle last tool card</Text>
      <Text>  Ctrl+L  – Clear screen</Text>
      <Text>  Ctrl+C  – Abort stream / double-tap to exit</Text>
    </Box>
  );
}

function PromptInput({ onSubmit, history }: { onSubmit: (v: string) => void; history: string[] }) {
  const [value, setValue] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [blink, setBlink] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setBlink((b) => !b), 530);
    return () => clearInterval(id);
  }, []);

  useInput((inputStr, key) => {
    if (key.ctrl && (inputStr === "c" || inputStr === "l" || inputStr === "o")) {
      return;
    }

    if (key.return && key.shift) {
      const before = value.slice(0, cursorOffset);
      const after = value.slice(cursorOffset);
      setValue(before + "\n" + after);
      setCursorOffset(cursorOffset + 1);
      return;
    }

    if (key.return) {
      onSubmit(value);
      setValue("");
      setCursorOffset(0);
      setHistoryIndex(-1);
      return;
    }

    if (key.upArrow) {
      const newIndex = Math.min(historyIndex + 1, history.length - 1);
      if (newIndex >= 0 && newIndex !== historyIndex) {
        setHistoryIndex(newIndex);
        const newValue = history[history.length - 1 - newIndex];
        setValue(newValue);
        setCursorOffset(newValue.length);
      }
      return;
    }

    if (key.downArrow) {
      const newIndex = Math.max(historyIndex - 1, -1);
      setHistoryIndex(newIndex);
      const newValue = newIndex === -1 ? "" : history[history.length - 1 - newIndex];
      setValue(newValue);
      setCursorOffset(newValue.length);
      return;
    }

    if (key.leftArrow) {
      setCursorOffset(Math.max(0, cursorOffset - 1));
      return;
    }

    if (key.rightArrow) {
      setCursorOffset(Math.min(value.length, cursorOffset + 1));
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        const before = value.slice(0, cursorOffset - 1);
        const after = value.slice(cursorOffset);
        setValue(before + after);
        setCursorOffset(cursorOffset - 1);
      }
      return;
    }

    if (inputStr && !key.ctrl && !key.meta) {
      const before = value.slice(0, cursorOffset);
      const after = value.slice(cursorOffset);
      setValue(before + inputStr + after);
      setCursorOffset(cursorOffset + inputStr.length);
    }
  });

  const lines = value.split("\n");
  const cursorLineIndex = value.slice(0, cursorOffset).split("\n").length - 1;
  const lineStartOffset = value.slice(0, cursorOffset).lastIndexOf("\n") + 1;
  const cursorCol = cursorOffset - lineStartOffset;

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const isCursorLine = i === cursorLineIndex;
        let displayLine = line;
        if (isCursorLine) {
          const before = line.slice(0, cursorCol);
          const char = line[cursorCol] || " ";
          const after = line.slice(cursorCol + 1);
          displayLine = before + (blink ? chalk.inverse(char) : char) + after;
        }
        return (
          <Box key={i} flexDirection="row">
            <Text color="cyan">❯ </Text>
            <Text>{displayLine}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

/* ─── Main App ─── */

export default function App() {
  const { exit } = useApp();
  const [items, setItems] = useState<UiItem[]>([]);
  const [status, setStatus] = useState<string>("ready");
  const [isRunning, setIsRunning] = useState(false);
  const [inputHistory, setInputHistory] = useState<string[]>([]);

  const historyRef = useRef<Message[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const userAbortedRef = useRef(false);
  const lastSigintRef = useRef(0);

  const tools = useMemo(() => loadTools(), []);
  const model = useMemo(() => getModel("minimax", "MiniMax-M2.7"), []);
  const agent = useMemo(() => createAgent({ tools, model }), [tools, model]);

  const findLastPendingToolIndex = useCallback(
    (items: UiItem[], name: string): number => {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.type === "tool" && item.name === name && item.status === "pending") {
          return i;
        }
      }
      return -1;
    },
    []
  );

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (trimmed === "/clear") {
        setItems([]);
        historyRef.current = [];
        setStatus("ready");
        return;
      }
      if (trimmed === "/quit") {
        exit();
        return;
      }
      if (trimmed === "/help") {
        setItems((prev) => [...prev, { type: "help" }]);
        return;
      }
      if (trimmed.startsWith("/")) {
        setItems((prev) => [...prev, { type: "error", message: `Unbekannter Befehl: ${trimmed}` }]);
        return;
      }

      setItems((prev) => [...prev, { type: "user", text: trimmed }]);
      setInputHistory((prev) => [...prev, trimmed]);
      setIsRunning(true);
      setStatus("thinking");

      historyRef.current.push({ role: "user", content: trimmed, timestamp: Date.now() });

      const controller = new AbortController();
      abortControllerRef.current = controller;
      userAbortedRef.current = false;

      let liveOutput = false;

      agent
        .run(historyRef.current, {
          signal: controller.signal,
          onEvent: (event: AgentEvent) => {
            if (event.type === "token") {
              liveOutput = true;
              setStatus("thinking");
              setItems((prev) => {
                const last = prev[prev.length - 1];
                if (last?.type === "assistant") {
                  return [...prev.slice(0, -1), { ...last, text: last.text + event.text }];
                }
                return [...prev, { type: "assistant", text: event.text }];
              });
            } else if (event.type === "tool_call_start") {
              setStatus(`tool: ${event.name}`);
              setItems((prev) => [
                ...prev,
                { type: "tool", name: event.name, status: "pending", preview: "" },
              ]);
            } else if (event.type === "tool_call_done") {
              setStatus("ready");
              setItems((prev) => {
                const idx = findLastPendingToolIndex(prev, event.name);
                if (idx === -1) return prev;
                const next = [...prev];
                const item = next[idx];
                if (item.type === "tool") {
                  next[idx] = { ...item, status: "done", preview: truncate(event.result, 80) };
                }
                return next;
              });
            } else if (event.type === "tool_call_error") {
              setStatus("ready");
              setItems((prev) => {
                const idx = findLastPendingToolIndex(prev, event.name);
                if (idx === -1) return prev;
                const next = [...prev];
                const item = next[idx];
                if (item.type === "tool") {
                  next[idx] = { ...item, status: "error", preview: truncate(event.error, 80), expanded: true };
                }
                return next;
              });
            } else if (event.type === "turn_end") {
              setStatus("ready");
            }
          },
        })
        .then((result: RunResult) => {
          if (result.aborted || userAbortedRef.current) {
            setItems((prev) => [...prev, { type: "abort" }]);
            setStatus("aborted");
          } else if (!liveOutput) {
            setItems((prev) => [...prev, { type: "assistant", text: result.finalMessage }]);
          }
          setIsRunning(false);
          abortControllerRef.current = null;
          userAbortedRef.current = false;
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setItems((prev) => [...prev, { type: "error", message }]);
          setIsRunning(false);
          setStatus("ready");
          abortControllerRef.current = null;
          userAbortedRef.current = false;
        });
    },
    [agent, exit, findLastPendingToolIndex]
  );

  useInput((inputStr, key) => {
    if (key.ctrl && inputStr === "c") {
      const now = Date.now();
      if (now - lastSigintRef.current < 500) {
        if (!isRunning) {
          process.exit(130);
        }
      }
      lastSigintRef.current = now;

      if (isRunning && abortControllerRef.current) {
        userAbortedRef.current = true;
        abortControllerRef.current.abort();
      }
      // idle: no-op
      return;
    }

    if (key.ctrl && inputStr === "l") {
      setItems([]);
      return;
    }

    if (key.ctrl && inputStr === "o") {
      setItems((prev) => {
        let lastToolIndex = -1;
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].type === "tool") {
            lastToolIndex = i;
            break;
          }
        }
        if (lastToolIndex === -1) return prev;
        const next = [...prev];
        const item = next[lastToolIndex];
        if (item.type === "tool") {
          next[lastToolIndex] = { ...item, expanded: !item.expanded };
        }
        return next;
      });
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Header modelId={model.id} status={status} />
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        switch (item.type) {
          case "user":
            return (
              <Text key={index} color="cyan">
                ❯ {item.text}
              </Text>
            );
          case "assistant":
            return <AssistantText key={index} text={item.text} />;
          case "tool":
            return <ToolCard key={index} item={item} isLast={isLast} />;
          case "abort":
            return (
              <Text key={index} italic color="gray">
                [abgebrochen]
              </Text>
            );
          case "error":
            return (
              <Text key={index} color="red">
                [Fehler]: {item.message}
              </Text>
            );
          case "help":
            return <HelpCard key={index} />;
        }
      })}
      {!isRunning && <PromptInput onSubmit={handleSubmit} history={inputHistory} />}
    </Box>
  );
}

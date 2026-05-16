import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Box, Text, useInput, useApp, Static } from "ink";
import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { randomUUID } from "node:crypto";
import { createAgent } from "../core/agent.js";
import { getModel } from "@mariozechner/pi-ai";
import { loadTools } from "../tools/registry.js";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentEvent, RunResult } from "../core/agent.js";

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
    listitem: chalk.reset,
    hr: chalk.gray,
    table: chalk.reset,
    link: chalk.blue,
    href: chalk.blue.underline,
    width: process.stdout.columns || 80,
  }) as any)
);

/* ─── Types ─── */

type ToolItem = {
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
  aborted: boolean;
  error?: string;
  help?: boolean;
};

type ActiveTurn = {
  userText: string;
  assistantText: string;
  tools: ToolItem[];
  status: "streaming" | "thinking" | "tool" | "aborted" | "error" | "complete";
};

/* ─── Helpers ─── */

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
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

function Header({ modelId, status }: { modelId: string; status: string }) {
  const statusColor =
    status === "ready"
      ? "green"
      : status === "thinking"
        ? "yellow"
        : status === "aborted"
          ? "gray"
          : "cyan";

  return (
    <Box marginBottom={1} width={process.stdout.columns || 80}>
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

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={iconColor}>{titleLine}</Text>
      {body && <Text>{body}</Text>}
      <Text>{bottomLine}</Text>
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

function TurnView({ turn }: { turn: CompletedTurn }) {
  return (
    <Box flexDirection="column">
      <Text color="cyan">❯ {turn.userText}</Text>
      {turn.tools.map((tool) => (
        <ToolCard key={tool.id} item={tool} isLast={false} />
      ))}
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
      {turn.assistantText && (
        <Box marginTop={1}>
          <Text>{turn.assistantRendered ? (marked.parse(turn.assistantText) as string) : turn.assistantText}</Text>
        </Box>
      )}
    </Box>
  );
}

function ActiveTurnView({ turn }: { turn: ActiveTurn }) {
  return (
    <Box flexDirection="column">
      <Text color="cyan">❯ {turn.userText}</Text>
      {turn.tools.map((tool, i) => (
        <ToolCard key={tool.id} item={tool} isLast={i === turn.tools.length - 1} />
      ))}
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
      {turn.assistantText && (
        <Box marginTop={1}>
          <Text>{turn.assistantText}</Text>
        </Box>
      )}
    </Box>
  );
}

function PromptInput({ onSubmit, history }: { onSubmit: (v: string) => void; history: string[] }) {
  const [, setRenderTick] = useState(0);
  const valueRef = useRef("");
  const cursorOffsetRef = useRef(0);
  const historyIndexRef = useRef(-1);
  const blinkRef = useRef(true);
  const historyRef = useRef(history);

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

  useInput((inputStr, key) => {
    if (key.ctrl && (inputStr === "c" || inputStr === "l" || inputStr === "o")) {
      return;
    }

    let changed = false;
    const currentValue = valueRef.current;

    if (key.return && key.shift) {
      const before = currentValue.slice(0, cursorOffsetRef.current);
      const after = currentValue.slice(cursorOffsetRef.current);
      valueRef.current = before + "\n" + after;
      cursorOffsetRef.current++;
      changed = true;
    } else if (key.return) {
      onSubmit(currentValue);
      valueRef.current = "";
      cursorOffsetRef.current = 0;
      historyIndexRef.current = -1;
      changed = true;
    } else if (key.upArrow) {
      const newIndex = Math.min(historyIndexRef.current + 1, historyRef.current.length - 1);
      if (newIndex >= 0 && newIndex !== historyIndexRef.current) {
        historyIndexRef.current = newIndex;
        valueRef.current = historyRef.current[historyRef.current.length - 1 - newIndex];
        cursorOffsetRef.current = valueRef.current.length;
        changed = true;
      }
    } else if (key.downArrow) {
      const newIndex = Math.max(historyIndexRef.current - 1, -1);
      historyIndexRef.current = newIndex;
      valueRef.current = newIndex === -1 ? "" : historyRef.current[historyRef.current.length - 1 - newIndex];
      cursorOffsetRef.current = valueRef.current.length;
      changed = true;
    } else if (key.leftArrow) {
      cursorOffsetRef.current = Math.max(0, cursorOffsetRef.current - 1);
      changed = true;
    } else if (key.rightArrow) {
      cursorOffsetRef.current = Math.min(currentValue.length, cursorOffsetRef.current + 1);
      changed = true;
    } else if (key.backspace || key.delete) {
      if (cursorOffsetRef.current > 0) {
        const before = currentValue.slice(0, cursorOffsetRef.current - 1);
        const after = currentValue.slice(cursorOffsetRef.current);
        valueRef.current = before + after;
        cursorOffsetRef.current--;
        changed = true;
      }
    } else if (inputStr && !key.ctrl && !key.meta) {
      const before = currentValue.slice(0, cursorOffsetRef.current);
      const after = currentValue.slice(cursorOffsetRef.current);
      valueRef.current = before + inputStr + after;
      cursorOffsetRef.current += inputStr.length;
      changed = true;
    }

    if (changed) {
      setRenderTick((t) => t + 1);
    }
  });

  const lines = valueRef.current.split("\n");
  const cursorLineIndex = valueRef.current.slice(0, cursorOffsetRef.current).split("\n").length - 1;
  const lineStartOffset = valueRef.current.slice(0, cursorOffsetRef.current).lastIndexOf("\n") + 1;
  const cursorCol = cursorOffsetRef.current - lineStartOffset;

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const isCursorLine = i === cursorLineIndex;
        let displayLine = line;
        if (isCursorLine) {
          const before = line.slice(0, cursorCol);
          const char = line[cursorCol] || " ";
          const after = line.slice(cursorCol + 1);
          displayLine = before + (blinkRef.current ? chalk.inverse(char) : char) + after;
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
  const [pastTurns, setPastTurns] = useState<CompletedTurn[]>([]);
  const activeTurnRef = useRef<ActiveTurn | null>(null);
  const forceUpdate = useForceUpdate();
  const [inputHistory, setInputHistory] = useState<string[]>([]);

  const historyRef = useRef<Message[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const userAbortedRef = useRef(false);
  const lastSigintRef = useRef(0);
  const isRunningRef = useRef(false);

  const tools = useMemo(() => loadTools(), []);
  const model = useMemo(() => getModel("minimax", "MiniMax-M2.7"), []);
  const agent = useMemo(() => createAgent({ tools, model }), [tools, model]);

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
      if (trimmed === "/help") {
        const helpTurn: CompletedTurn = {
          id: randomUUID(),
          userText: trimmed,
          assistantText: "",
          assistantRendered: false,
          tools: [],
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
          aborted: false,
          error: `Unknown command: ${trimmed}. Try /help.`,
        };
        setPastTurns((prev) => [...prev, errorTurn]);
        return;
      }

      setInputHistory((prev) => [...prev, trimmed]);
      historyRef.current.push({ role: "user", content: trimmed, timestamp: Date.now() });

      activeTurnRef.current = { userText: trimmed, assistantText: "", tools: [], status: "thinking" };
      isRunningRef.current = true;
      forceUpdate();

      const controller = new AbortController();
      abortControllerRef.current = controller;
      userAbortedRef.current = false;

      agent
        .run(historyRef.current, {
          signal: controller.signal,
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
                activeTurnRef.current = {
                  ...activeTurnRef.current,
                  tools: [
                    ...activeTurnRef.current.tools,
                    { id: randomUUID(), name: event.name, status: "pending", preview: "" },
                  ],
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
              aborted: result.aborted || userAbortedRef.current,
              error: turn.status === "error" ? turn.tools.find((t) => t.status === "error")?.preview : undefined,
            };
            setPastTurns((prev) => [...prev, completedTurn]);
            activeTurnRef.current = null;
            isRunningRef.current = false;
            forceUpdate();
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

  useInput((inputStr, key) => {
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
      if (activeTurnRef.current) {
        const tools = activeTurnRef.current.tools;
        const lastToolIndex = tools.length - 1;
        if (lastToolIndex >= 0) {
          const newTools = [...tools];
          newTools[lastToolIndex] = { ...newTools[lastToolIndex], expanded: !newTools[lastToolIndex].expanded };
          activeTurnRef.current = { ...activeTurnRef.current, tools: newTools };
          forceUpdate();
        }
      }
      return;
    }
  });

  return (
    <Box flexDirection="column" width={process.stdout.columns || 80}>
      <Header modelId={model.id} status={status} />
      <Static items={pastTurns}>{(turn) => <TurnView key={turn.id} turn={turn} />}</Static>
      {activeTurnRef.current && <ActiveTurnView turn={activeTurnRef.current} />}
      {!isRunningRef.current && <PromptInput onSubmit={handleSubmit} history={inputHistory} />}
    </Box>
  );
}

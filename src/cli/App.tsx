import { useState, useCallback, useRef, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { createAgent } from "../core/agent.js";
import { getModel } from "@mariozechner/pi-ai";
import { loadTools } from "../tools/registry.js";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentEvent, RunResult } from "../core/agent.js";

type UiItem =
  | { type: "header" }
  | { type: "user"; text: string }
  | { type: "thinking" }
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; status: "pending" | "done" | "error"; preview: string }
  | { type: "abort" }
  | { type: "error"; message: string };

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

export default function App() {
  const { exit } = useApp();
  const [items, setItems] = useState<UiItem[]>([{ type: "header" }]);
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);

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
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "/quit") {
        exit();
        return;
      }

      setItems((prev) => [...prev, { type: "user", text: trimmed }]);
      setInput("");
      setIsRunning(true);

      historyRef.current.push({ role: "user", content: trimmed, timestamp: Date.now() });

      const controller = new AbortController();
      abortControllerRef.current = controller;
      userAbortedRef.current = false;

      let liveOutput = false;

      setItems((prev) => [...prev, { type: "thinking" }]);

      try {
        const result: RunResult = await agent.run(historyRef.current, {
          signal: controller.signal,
          onEvent: (event: AgentEvent) => {
            if (event.type === "token") {
              liveOutput = true;
              setItems((prev) => {
                const last = prev[prev.length - 1];
                if (last?.type === "assistant") {
                  const next = [...prev.slice(0, -1), { ...last, text: last.text + event.text }];
                  return next;
                }
                return [...prev, { type: "assistant", text: event.text }];
              });
            } else if (event.type === "tool_call_start") {
              setItems((prev) => [
                ...prev,
                { type: "tool", name: event.name, status: "pending", preview: "" },
              ]);
            } else if (event.type === "tool_call_done") {
              setItems((prev) => {
                const idx = findLastPendingToolIndex(prev, event.name);
                if (idx === -1) return prev;
                const next = [...prev];
                next[idx] = {
                  type: "tool",
                  name: event.name,
                  status: "done",
                  preview: truncate(event.result, 80),
                };
                return next;
              });
            } else if (event.type === "tool_call_error") {
              setItems((prev) => {
                const idx = findLastPendingToolIndex(prev, event.name);
                if (idx === -1) return prev;
                const next = [...prev];
                next[idx] = {
                  type: "tool",
                  name: event.name,
                  status: "error",
                  preview: truncate(event.error, 80),
                };
                return next;
              });
            }
          },
        });

        if (result.aborted || userAbortedRef.current) {
          setItems((prev) => [...prev, { type: "abort" }]);
        } else if (!liveOutput) {
          setItems((prev) => [...prev, { type: "assistant", text: result.finalMessage }]);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setItems((prev) => [...prev, { type: "error", message }]);
      } finally {
        setIsRunning(false);
        abortControllerRef.current = null;
        userAbortedRef.current = false;
      }
    },
    [agent, exit, findLastPendingToolIndex]
  );

  useInput((inputStr, key) => {
    if (key.ctrl && inputStr === "c") {
      const now = Date.now();
      if (now - lastSigintRef.current < 500) {
        process.exit(130);
      }
      lastSigintRef.current = now;

      if (isRunning && abortControllerRef.current) {
        userAbortedRef.current = true;
        abortControllerRef.current.abort();
      } else {
        setInput("");
      }
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        switch (item.type) {
          case "header":
            return (
              <Box key={index} flexDirection="column" marginBottom={1}>
                <Text>=== Cliffford V2 — Interaktiver Agent Loop ===</Text>
                <Text>Verfügbare Tools: {tools.map((t) => t.name).join(", ")}</Text>
                <Text>Modell: {model.id}</Text>
                <Text>Tippe "exit" zum Beenden.</Text>
              </Box>
            );
          case "user":
            return <Text key={index}>Du: {item.text}</Text>;
          case "thinking":
            return (
              <Box key={index} flexDirection="column">
                <Text />
                <Text>[Agent denkt...]</Text>
                <Text />
              </Box>
            );
          case "assistant":
            return <Text key={index}>{item.text}</Text>;
          case "tool": {
            const symbol =
              item.status === "pending" ? "▸" : item.status === "done" ? "✓" : "✗";
            return (
              <Text key={index}>
                {symbol} {item.name} {item.preview}
              </Text>
            );
          }
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
        }
      })}
      {!isRunning && (
        <Box>
          <Text>Du: </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
        </Box>
      )}
    </Box>
  );
}

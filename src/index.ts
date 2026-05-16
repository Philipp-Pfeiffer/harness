#!/usr/bin/env node
import "dotenv/config";
import { createAgent } from "./core/agent.js";
import { getModel } from "@mariozechner/pi-ai";
import { loadTools } from "./tools/registry.js";
import { createInterface } from "node:readline";
import type { Message } from "@mariozechner/pi-ai";

const tools = loadTools();
const model = getModel("minimax", "MiniMax-M2.7");
const agent = createAgent({
  tools,
  model,
  logger: (msg) => console.log(msg),
});

console.log("=== Cliffford V2 — Interaktiver Agent Loop ===\n");
console.log("Verfügbare Tools:", tools.map((t) => t.name).join(", "));
console.log("Modell:", model.id);
console.log('Tippe "exit" zum Beenden.\n');

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const history: Message[] = [];
let isRunning = false;
let abortController = new AbortController();
let lastSigintTime = 0;
let sigintHandledByRl = false;
let currentResolve: ((value: string) => void) | null = null;
let userAborted = false;

function handleSigint() {
  const now = Date.now();
  if (now - lastSigintTime < 500) {
    process.exit(130);
  }
  lastSigintTime = now;

  if (isRunning) {
    userAborted = true;
    abortController.abort();
  } else {
    console.log();
    rl.prompt();
  }
}

rl.on("SIGINT", () => {
  sigintHandledByRl = true;
  handleSigint();
  setTimeout(() => {
    sigintHandledByRl = false;
  }, 10);
});

process.on("SIGINT", () => {
  if (!sigintHandledByRl) {
    handleSigint();
  }
});

rl.on("line", (line) => {
  if (currentResolve) {
    currentResolve(line.trim());
    currentResolve = null;
  }
});

async function loop() {
  rl.setPrompt("Du: ");
  while (true) {
    rl.prompt();
    const input = await new Promise<string>((resolve) => {
      currentResolve = resolve;
    });

    if (!input || input.toLowerCase() === "exit") {
      console.log("Tschüss!");
      rl.close();
      break;
    }

    console.log("\n[Agent denkt...]\n");

    history.push({ role: "user", content: input, timestamp: Date.now() });
    abortController = new AbortController();
    isRunning = true;
    let liveOutput = false;

    try {
      const result = await agent.run(history, {
        signal: abortController.signal,
        onEvent: (event) => {
          if (event.type === "token") {
            process.stdout.write(event.text);
            liveOutput = true;
          } else if (event.type === "tool_call_start") {
            process.stdout.write(`\n→ tool: ${event.name}(${JSON.stringify(event.args)})\n`);
          }
        },
      });

      if (result.aborted || userAborted) {
        console.log("\n[abgebrochen]\n");
      } else if (liveOutput) {
        console.log("\n");
      } else {
        console.log(`Cliffford: ${result.finalMessage}\n`);
      }
    } catch (err) {
      console.error(`[Fehler]: ${err instanceof Error ? err.message : err}\n`);
    } finally {
      userAborted = false;
      isRunning = false;
    }
  }
}

loop();

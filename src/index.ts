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

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

const history: Message[] = [];
let isRunning = false;
let abortController = new AbortController();

process.on("SIGINT", () => {
  if (isRunning) {
    abortController.abort();
  } else {
    console.log("\nTschüss!");
    rl.close();
    process.exit(0);
  }
});

async function loop() {
  while (true) {
    const input = await ask("Du: ");
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

      if (result.aborted) {
        console.log("\n[abgebrochen]\n");
      } else if (liveOutput) {
        console.log("\n");
      } else {
        console.log(`Cliffford: ${result.finalMessage}\n`);
      }
    } catch (err) {
      console.error(`[Fehler]: ${err instanceof Error ? err.message : err}\n`);
    }

    isRunning = false;
  }
}

loop();

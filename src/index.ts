#!/usr/bin/env node
import "dotenv/config";
import { createAgent } from "./core/agent.js";
import { getModel } from "@mariozechner/pi-ai";
import { loadTools } from "./tools/registry.js";
import { createInterface } from "node:readline";

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

async function loop() {
  while (true) {
    const input = await ask("Du: ");
    if (!input || input.toLowerCase() === "exit") {
      console.log("Tschüss!");
      rl.close();
      break;
    }

    console.log("\n[Agent denkt...]\n");

    try {
      const result = await agent.run(input);
      console.log(`Cliffford: ${result}\n`);
    } catch (err) {
      console.error(`[Fehler]: ${err instanceof Error ? err.message : err}\n`);
    }
  }
}

loop();
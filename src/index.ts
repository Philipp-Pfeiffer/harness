#!/usr/bin/env node
import { createAgent } from "./core/agent.js";
import { loadTools } from "./tools/registry.js";

async function main() {
  const tools = loadTools();
  const agent = createAgent({ tools });

  // Kick off with a user message or system prompt
  const result = await agent.run("Hello, Cliffford.");
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
import "dotenv/config";
import { createAgent } from "./core/agent.js";
import { loadTools } from "./tools/registry.js";

async function main() {
  const tools = loadTools();
  const agent = createAgent({ tools });

  // Test 1: Einfacher Chat
  console.log("=== Test 1: Einfacher Chat ===");
  const result1 = await agent.run("Hello, Cliffford.");
  console.log(result1);

  // Test 2: Tool-Calling
  console.log("\n=== Test 2: Tool-Calling ===");
  const result2 = await agent.run("Bitte rufe das echo Tool mit dem Text 'MiniMax funktioniert!' auf.");
  console.log(result2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

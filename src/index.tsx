#!/usr/bin/env node
import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { render } from "ink";

if (!process.stdin.isTTY) {
  console.error("harness requires an interactive terminal (TTY).");
  console.error("Run without piping stdin, or use an interactive shell.");
  process.exit(1);
}

const projectRoot = process.cwd();
process.env.HARNESS_PROJECT_ROOT = projectRoot;

await mkdir(resolve(projectRoot, "workspace"), { recursive: true });
process.chdir(resolve(projectRoot, "workspace"));

const { default: App } = await import("./cli/App.js");
render(<App />);

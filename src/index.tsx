#!/usr/bin/env node
import "dotenv/config";
import { render } from "ink";
import App from "./cli/App.js";

if (!process.stdin.isTTY) {
  console.error("harness requires an interactive terminal (TTY).");
  console.error("Run without piping stdin, or use an interactive shell.");
  process.exit(1);
}

render(<App />);

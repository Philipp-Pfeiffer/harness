#!/usr/bin/env node
import "dotenv/config";
import { render } from "ink";
import App from "./cli/App.js";

render(<App />);

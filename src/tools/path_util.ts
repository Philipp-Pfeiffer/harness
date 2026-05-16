import { homedir } from "node:os";
import { resolve } from "node:path";

export function expandTilde(pathStr: string): string {
  if (pathStr.startsWith("~/") || pathStr === "~") {
    return pathStr.replace(/^~/, homedir());
  }
  return pathStr;
}

export function resolveExpandedPath(pathStr: string): string {
  return resolve(expandTilde(pathStr));
}
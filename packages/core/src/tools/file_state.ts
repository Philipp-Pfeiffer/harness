import { resolve } from "node:path";

const readPaths = new Set<string>();

export function markRead(absolutePath: string): void {
  const normalized = resolve(absolutePath);
  readPaths.add(normalized);
}

export function wasRead(absolutePath: string): boolean {
  const normalized = resolve(absolutePath);
  return readPaths.has(normalized);
}
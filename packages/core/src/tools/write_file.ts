import { Type } from "@sinclair/typebox";
import { resolveExpandedPath, resolveExpandedPathFrom } from "./path_util.js";
import { atomicWrite } from "./atomic_write.js";
import { markRead } from "./file_state.js";
import type { Tool } from "./types.js";
import { ok, err } from "./types.js";

export const WriteArgs = Type.Object({
  path: Type.String({ description: "Absolute or relative path. Supports ~ for home directory." }),
  content: Type.String({ description: "File content to write. Will overwrite existing file." }),
});

export const WRITE_NO_FLY_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^\/etc\//, reason: "Writing to /etc/ is blocked" },
  { pattern: /^\/boot\//, reason: "Writing to /boot/ is blocked" },
  { pattern: /^\/usr\/lib\/systemd\//, reason: "Writing to /usr/lib/systemd/ is blocked" },
  { pattern: /^\/proc\//, reason: "Writing to /proc/ is blocked" },
  { pattern: /^\/sys\//, reason: "Writing to /sys/ is blocked" },
  { pattern: /^\/dev\/(?!null$|stdout$)/, reason: "Writing to /dev/ is blocked (except /dev/null and /dev/stdout)" },
  { pattern: /docker\.sock$/, reason: "Writing to docker.sock is blocked" },
];

export function isSensitivePath(path: string): { blocked: true; reason: string } | { blocked: false } {
  const ALLOWED_DEV = ["/dev/null", "/dev/stdout"];
  if (ALLOWED_DEV.includes(path)) return { blocked: false };
  for (const { pattern, reason } of WRITE_NO_FLY_PATTERNS) {
    if (pattern.test(path)) return { blocked: true, reason };
  }
  return { blocked: false };
}

export const writeTool: Tool<typeof WriteArgs> = {
  name: "write",
  description: "Write content to a file. Supports atomic writes (tmp + rename). Blocks sensitive paths.",
  parameters: WriteArgs,
  conflictKey(args) {
    return resolveExpandedPath(args.path);
  },
  async execute(args, context) {
    const absolutePath = resolveExpandedPathFrom(context?.cwd, args.path);

    const sensitiveCheck = isSensitivePath(absolutePath);
    if (sensitiveCheck.blocked) {
      return err(`SENSITIVE_PATH: ${sensitiveCheck.reason}`);
    }

    const result = await atomicWrite(absolutePath, args.content);
    if (!result.ok) {
      return err(`${result.code}: ${result.message}`);
    }

    if (context?.sessionId) markRead(context.sessionId, absolutePath);
    return ok("ok");
  },
};
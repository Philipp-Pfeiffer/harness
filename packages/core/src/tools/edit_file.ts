import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { resolveExpandedPath, resolveExpandedPathFrom } from "./path_util.js";
import { atomicWrite } from "./atomic_write.js";
import { markRead, wasRead } from "./file_state.js";
import { isSensitivePath } from "./write_file.js";
import type { Tool } from "./types.js";
import { ok, err } from "./types.js";

export const EditArgs = Type.Object({
  path: Type.String({ description: "Absolute or relative path. Supports ~ for home directory." }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "Text to find and replace." }),
      newText: Type.String({ description: "Replacement text." }),
      replaceAll: Type.Optional(Type.Boolean({ description: "Replace all occurrences. Default: false (exact 1 match required)." })),
    }),
    { description: "Sequential edits to apply to the file." }
  ),
});

export const editTool: Tool<typeof EditArgs> = {
  name: "edit",
  description: "Edit a file by finding and replacing text. File must be read before editing. Supports replaceAll.",
  parameters: EditArgs,
  conflictKey(args) {
    return resolveExpandedPath(args.path);
  },
  async execute(args, context) {
    const absolutePath = resolveExpandedPathFrom(context?.cwd, args.path);

    const sensitiveCheck = isSensitivePath(absolutePath);
    if (sensitiveCheck.blocked) {
      return err(`SENSITIVE_PATH: ${sensitiveCheck.reason}`);
    }

    const sessionId = context?.sessionId;
    if (!sessionId || !wasRead(sessionId, absolutePath)) {
      return err(`READ_REQUIRED: file must be read before editing`);
    }

    if (!args.edits || args.edits.length === 0) {
      return err(`EMPTY_EDITS: at least one edit is required`);
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (err_) {
      return err(`READ_FAILED: ${err_ instanceof Error ? err_.message : String(err_)}`);
    }

    if (
      buffer.length >= 5 &&
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46 &&
      buffer[4] === 0x2d
    ) {
      return err("BINARY_FILE: Cannot edit binary file: PDF detected. The edit tool only supports plain-text files. Use a PDF library (e.g. pdf-lib) for PDF modifications.");
    }

    const content = buffer.toString("utf-8");
    let working = content;

    for (let i = 0; i < args.edits.length; i++) {
      const edit = args.edits[i];

      if (edit.oldText === edit.newText) {
        return err(`NOOP_EDIT: edit ${i} has identical oldText and newText`);
      }

      const matches = countOccurrences(working, edit.oldText);

      if (edit.replaceAll) {
        working = working.split(edit.oldText).join(edit.newText);
      } else {
        if (matches !== 1) {
          return err(`NOT_UNIQUE: edit ${i} found ${matches} matches (expected exactly 1)`);
        }
        working = working.replace(edit.oldText, edit.newText);
      }
    }

    const result = await atomicWrite(absolutePath, working);
    if (!result.ok) {
      return err(`${result.code}: ${result.message}`);
    }

    markRead(sessionId, absolutePath);
    return ok(`ok: ${args.edits.length}`);
  },
};

function countOccurrences(str: string, substr: string): number {
  if (substr === "") return 0;
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(substr, pos)) !== -1) {
    count++;
    pos += substr.length;
  }
  return count;
}
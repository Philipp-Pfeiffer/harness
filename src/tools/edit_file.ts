import { Type } from "@sinclair/typebox";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { expandTilde } from "./path_util.js";
import { atomicWrite } from "./atomic_write.js";
import { markRead, wasRead } from "./file_state.js";
import { isSensitivePath } from "./write_file.js";
import type { Tool } from "./types.js";

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
  async execute(args) {
    const expanded = expandTilde(args.path);
    const absolutePath = resolve(expanded);

    const sensitiveCheck = isSensitivePath(absolutePath);
    if (sensitiveCheck.blocked) {
      return `SENSITIVE_PATH: ${sensitiveCheck.reason}`;
    }

    if (!wasRead(absolutePath)) {
      return `READ_REQUIRED: file must be read before editing`;
    }

    if (!args.edits || args.edits.length === 0) {
      return `EMPTY_EDITS: at least one edit is required`;
    }

    let content: string;
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch (err) {
      return `READ_FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }

    let working = content;

    for (let i = 0; i < args.edits.length; i++) {
      const edit = args.edits[i];

      if (edit.oldText === edit.newText) {
        return `NOOP_EDIT: edit ${i} has identical oldText and newText`;
      }

      const matches = countOccurrences(working, edit.oldText);

      if (edit.replaceAll) {
        working = working.split(edit.oldText).join(edit.newText);
      } else {
        if (matches !== 1) {
          return `NOT_UNIQUE: edit ${i} found ${matches} matches (expected exactly 1)`;
        }
        working = working.replace(edit.oldText, edit.newText);
      }
    }

    const result = await atomicWrite(absolutePath, working);
    if (!result.ok) {
      return `${result.code}: ${result.message}`;
    }

    markRead(absolutePath);
    return `ok: ${args.edits.length}`;
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
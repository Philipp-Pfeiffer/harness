import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { editTool } from "../../src/tools/edit_file.ts";
import { markRead, wasRead } from "../../src/tools/file_state.ts";
import { writeTool } from "../../src/tools/write_file.ts";
import { executeExecSync } from "../../src/tools/exec.ts";
import { resolve } from "node:path";

const fixturesDir = resolve(process.cwd(), "tests/fixtures");
const testDir = resolve(fixturesDir, "edit_test");
const samplePdf = resolve(fixturesDir, "sample.pdf");

async function cleanup(path: string) {
  try {
    await executeExecSync({ command: `rm -rf ${path}` });
  } catch (_) {}
}

describe("edit tool", () => {
  beforeEach(async () => {
    await executeExecSync({ command: `mkdir -p ${testDir}` });
  });

  afterEach(async () => {
    await executeExecSync({ command: `rm -rf ${testDir}` });
  });

  describe("edit_file", () => {
    it("1. read-required fail: edit without read → READ_REQUIRED error", async () => {
      const path = resolve(testDir, "unread.txt");
      await executeExecSync({ command: `echo "hello" > ${path}` });
      const result = await editTool.execute({ path, edits: [{ oldText: "hello", newText: "world" }] });
      expect(result).toContain("READ_REQUIRED");
      expect(result).toContain("file must be read before editing");
    });

    it("2. unique replace: exact 1 match → ok, edit applied", async () => {
      const path = resolve(testDir, "unique.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(resolve(path));
      const result = await editTool.execute({ path, edits: [{ oldText: "hello", newText: "bye" }] });
      expect(result).toContain("ok: 1");
      const bashResult = await executeExecSync({ command: `cat ${path}` });
      expect(bashResult.content).toContain("bye world");
      expect(bashResult.content).not.toContain("hello");
    });

    it("3. replaceAll: multiple matches → all replaced", async () => {
      const path = resolve(testDir, "multi.txt");
      await writeTool.execute({ path, content: "foo bar foo baz foo" });
      markRead(resolve(path));
      const result = await editTool.execute({
        path,
        edits: [{ oldText: "foo", newText: "QUX", replaceAll: true }],
      });
      expect(result).toContain("ok: 1");
      const bashResult = await executeExecSync({ command: `cat ${path}` });
      expect(bashResult.content).toContain("QUX bar QUX baz QUX");
    });

    it("4. not-unique error: 0 matches → NOT_UNIQUE error", async () => {
      const path = resolve(testDir, "zero_match.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(resolve(path));
      const result = await editTool.execute({ path, edits: [{ oldText: "notexist", newText: "bad" }] });
      expect(result).toContain("NOT_UNIQUE");
      expect(result).toContain("found 0 matches");
    });

    it("5. not-unique error: multiple matches without replaceAll → NOT_UNIQUE error", async () => {
      const path = resolve(testDir, "multi_no_replaceall.txt");
      await writeTool.execute({ path, content: "foo bar foo" });
      markRead(resolve(path));
      const result = await editTool.execute({ path, edits: [{ oldText: "foo", newText: "QUX" }] });
      expect(result).toContain("NOT_UNIQUE");
      expect(result).toContain("found 2 matches");
    });

    it("6. sequential application: two dependent edits → both applied", async () => {
      const path = resolve(testDir, "sequential.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(resolve(path));
      const result = await editTool.execute({
        path,
        edits: [
          { oldText: "hello", newText: "hi" },
          { oldText: "hi world", newText: "hi there" },
        ],
      });
      expect(result).toContain("ok: 2");
      const bashResult = await executeExecSync({ command: `cat ${path}` });
      expect(bashResult.content).toContain("hi there");
    });

    it("7. noop-edit error: oldText equals newText → NOOP_EDIT error", async () => {
      const path = resolve(testDir, "noop.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(resolve(path));
      const result = await editTool.execute({ path, edits: [{ oldText: "hello", newText: "hello" }] });
      expect(result).toContain("NOOP_EDIT");
      expect(result).toContain("identical oldText and newText");
    });

    it("8. empty-edits error: empty edits array → EMPTY_EDITS error", async () => {
      const path = resolve(testDir, "empty.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(resolve(path));
      const result = await editTool.execute({ path, edits: [] });
      expect(result).toContain("EMPTY_EDITS");
      expect(result).toContain("at least one edit is required");
    });

    it("9. sensitive path: /etc/file → SENSITIVE_PATH error", async () => {
      const result = await editTool.execute({ path: "/etc/passwd", edits: [{ oldText: "x", newText: "y" }] });
      expect(result).toContain("SENSITIVE_PATH");
    });

    it("10. markRead after successful edit: file stays marked as read", async () => {
      const path = resolve(testDir, "stays_read.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(resolve(path));
      await editTool.execute({ path, edits: [{ oldText: "hello", newText: "bye" }] });
      expect(wasRead(resolve(path))).toBe(true);
    });

    it("11. blocks editing a PDF with BINARY_FILE error", async () => {
      markRead(resolve(samplePdf));
      const result = await editTool.execute({ path: samplePdf, edits: [{ oldText: "Hello", newText: "World" }] });
      expect(result).toContain("BINARY_FILE");
      expect(result).toContain("PDF detected");
    });
  });
});
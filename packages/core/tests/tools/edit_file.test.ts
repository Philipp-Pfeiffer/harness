import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { editTool } from "../../src/tools/edit_file.ts";
import { markRead, wasRead } from "../../src/tools/file_state.ts";
import { readFileTool } from "../../src/tools/readFile.ts";
import { writeTool } from "../../src/tools/write_file.ts";
import { executeExecSync } from "../../src/tools/exec.ts";
import { resolve } from "node:path";

const fixturesDir = resolve(process.cwd(), "tests/fixtures");
const testDir = resolve(fixturesDir, "edit_test");
const samplePdf = resolve(fixturesDir, "sample.pdf");

const TEST_SESSION = "edit-test-session";

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
      expect(result.content).toContain("READ_REQUIRED");
      expect(result.content).toContain("file must be read before editing");
    });

    it("2. unique replace: exact 1 match → ok, edit applied", async () => {
      const path = resolve(testDir, "unique.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(TEST_SESSION, resolve(path));
      const result = await editTool.execute({ path, edits: [{ oldText: "hello", newText: "bye" }] }, { sessionId: TEST_SESSION });
      expect(result.content).toContain("ok: 1");
      const bashResult = await executeExecSync({ command: `cat ${path}` });
      expect(bashResult.content).toContain("bye world");
      expect(bashResult.content).not.toContain("hello");
    });

    it("3. replaceAll: multiple matches → all replaced", async () => {
      const path = resolve(testDir, "multi.txt");
      await writeTool.execute({ path, content: "foo bar foo baz foo" });
      markRead(TEST_SESSION, resolve(path));
      const result = await editTool.execute(
        {
          path,
          edits: [{ oldText: "foo", newText: "QUX", replaceAll: true }],
        },
        { sessionId: TEST_SESSION }
      );
      expect(result.content).toContain("ok: 1");
      const bashResult = await executeExecSync({ command: `cat ${path}` });
      expect(bashResult.content).toContain("QUX bar QUX baz QUX");
    });

    it("4. not-unique error: 0 matches → NOT_UNIQUE error", async () => {
      const path = resolve(testDir, "zero_match.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(TEST_SESSION, resolve(path));
      const result = await editTool.execute({ path, edits: [{ oldText: "notexist", newText: "bad" }] }, { sessionId: TEST_SESSION });
      expect(result.content).toContain("NOT_UNIQUE");
      expect(result.content).toContain("found 0 matches");
    });

    it("5. not-unique error: multiple matches without replaceAll → NOT_UNIQUE error", async () => {
      const path = resolve(testDir, "multi_no_replaceall.txt");
      await writeTool.execute({ path, content: "foo bar foo" });
      markRead(TEST_SESSION, resolve(path));
      const result = await editTool.execute({ path, edits: [{ oldText: "foo", newText: "QUX" }] }, { sessionId: TEST_SESSION });
      expect(result.content).toContain("NOT_UNIQUE");
      expect(result.content).toContain("found 2 matches");
    });

    it("6. sequential application: two dependent edits → both applied", async () => {
      const path = resolve(testDir, "sequential.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(TEST_SESSION, resolve(path));
      const result = await editTool.execute(
        {
          path,
          edits: [
            { oldText: "hello", newText: "hi" },
            { oldText: "hi world", newText: "hi there" },
          ],
        },
        { sessionId: TEST_SESSION }
      );
      expect(result.content).toContain("ok: 2");
      const bashResult = await executeExecSync({ command: `cat ${path}` });
      expect(bashResult.content).toContain("hi there");
    });

    it("7. noop-edit error: oldText equals newText → NOOP_EDIT error", async () => {
      const path = resolve(testDir, "noop.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(TEST_SESSION, resolve(path));
      const result = await editTool.execute({ path, edits: [{ oldText: "hello", newText: "hello" }] }, { sessionId: TEST_SESSION });
      expect(result.content).toContain("NOOP_EDIT");
      expect(result.content).toContain("identical oldText and newText");
    });

    it("8. empty-edits error: empty edits array → EMPTY_EDITS error", async () => {
      const path = resolve(testDir, "empty.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(TEST_SESSION, resolve(path));
      const result = await editTool.execute({ path, edits: [] }, { sessionId: TEST_SESSION });
      expect(result.content).toContain("EMPTY_EDITS");
      expect(result.content).toContain("at least one edit is required");
    });

    it("9. sensitive path: /etc/file → SENSITIVE_PATH error", async () => {
      const result = await editTool.execute({ path: "/etc/passwd", edits: [{ oldText: "x", newText: "y" }] });
      expect(result.content).toContain("SENSITIVE_PATH");
    });

    it("10. markRead after successful edit: file stays marked as read", async () => {
      const path = resolve(testDir, "stays_read.txt");
      await writeTool.execute({ path, content: "hello world" });
      markRead(TEST_SESSION, resolve(path));
      await editTool.execute({ path, edits: [{ oldText: "hello", newText: "bye" }] }, { sessionId: TEST_SESSION });
      expect(wasRead(TEST_SESSION, resolve(path))).toBe(true);
    });

    it("11. blocks editing a PDF with BINARY_FILE error", async () => {
      markRead(TEST_SESSION, resolve(samplePdf));
      const result = await editTool.execute({ path: samplePdf, edits: [{ oldText: "Hello", newText: "World" }] }, { sessionId: TEST_SESSION });
      expect(result.content).toContain("BINARY_FILE");
      expect(result.content).toContain("PDF detected");
    });

    it("12. session isolation: file read by session A is not editable by session B", async () => {
      const path = resolve(testDir, "isolation.txt");
      await executeExecSync({ command: `echo "hello" > ${path}` });

      // Session A reads the file.
      const readResult = await readFileTool.execute({ path }, { sessionId: "session-a" });
      expect(readResult.content).toContain("hello");

      // Session B must NOT edit the file without its own read.
      const denied = await editTool.execute(
        { path, edits: [{ oldText: "hello", newText: "world" }] },
        { sessionId: "session-b" }
      );
      expect(denied.content).toContain("READ_REQUIRED");

      // Session A still can edit it.
      const allowed = await editTool.execute(
        { path, edits: [{ oldText: "hello", newText: "world" }] },
        { sessionId: "session-a" }
      );
      expect(allowed.content).toContain("ok: 1");
      const bashResult = await executeExecSync({ command: `cat ${path}` });
      expect(bashResult.content).toContain("world");
    });
  });
});

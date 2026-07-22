import { writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export interface AtomicWriteResult {
  ok: true;
}

export interface AtomicWriteError {
  ok: false;
  message: string;
  code: string;
}

export async function atomicWrite(
  absolutePath: string,
  content: string
): Promise<AtomicWriteResult | AtomicWriteError> {
  const tmpPath = `${absolutePath}.harness.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmpPath, content, "utf-8");
  } catch (err) {
    return {
      ok: false,
      message: `Failed to write tmp file: ${err instanceof Error ? err.message : String(err)}`,
      code: "WRITE_FAILED",
    };
  }

  try {
    await rename(tmpPath, absolutePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch (_) {}
    return {
      ok: false,
      message: `Failed to rename tmp file: ${err instanceof Error ? err.message : String(err)}`,
      code: "WRITE_FAILED",
    };
  }

  return { ok: true };
}
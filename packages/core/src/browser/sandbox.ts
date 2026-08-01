import { mkdir, readFile, stat, chmod, writeFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

const MAGIC_BY_EXTENSION: Record<string, { magic: Buffer; offset?: number }[]> = {
  ".pdf": [{ magic: Buffer.from("%PDF", "ascii") }],
  ".png": [{ magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }],
  ".jpg": [{ magic: Buffer.from([0xff, 0xd8, 0xff]) }],
  ".jpeg": [{ magic: Buffer.from([0xff, 0xd8, 0xff]) }],
  ".gif": [{ magic: Buffer.from("GIF8", "ascii") }],
  ".zip": [{ magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }],
  ".gz": [{ magic: Buffer.from([0x1f, 0x8b]) }],
  ".webp": [{ magic: Buffer.from("RIFF", "ascii") }],
};

function matchesMagic(buffer: Buffer, magic: Buffer, offset = 0): boolean {
  if (buffer.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buffer[offset + i] !== magic[i]) return false;
  }
  return true;
}

export async function ensureDownloadDir(downloadDir: string): Promise<void> {
  await mkdir(downloadDir, { recursive: true, mode: 0o755 });
}

/**
 * Resolves a filename inside the session download directory.
 * Blocks path traversal and absolute paths.
 */
export function resolveSandboxPath(downloadDir: string, filename: string): string {
  const base = path.resolve(downloadDir);
  const basename = path.basename(filename);
  if (basename !== filename || basename.includes("..")) {
    throw new SandboxError(`Path traversal blocked: ${filename}`);
  }
  const resolved = path.resolve(base, basename);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new SandboxError(`Path traversal blocked: ${filename}`);
  }
  return resolved;
}

export async function writeSandboxFile(
  downloadDir: string,
  filename: string,
  data: Buffer,
  maxBytes: number,
): Promise<string> {
  if (data.length > maxBytes) {
    throw new SandboxError(`Download exceeds size limit (${data.length} > ${maxBytes} bytes)`);
  }

  const filePath = resolveSandboxPath(downloadDir, filename);
  await writeFile(filePath, data, { mode: 0o644 });
  await chmod(filePath, 0o644);
  await verifyDownload(filePath, maxBytes);
  return filePath;
}

/**
 * Verifies a downloaded file: size cap + extension vs magic-byte consistency.
 */
export async function verifyDownload(filePath: string, maxBytes: number): Promise<void> {
  const info = await stat(filePath);
  if (info.size > maxBytes) {
    throw new SandboxError(`File exceeds size limit (${info.size} > ${maxBytes} bytes): ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  const expected = MAGIC_BY_EXTENSION[ext];
  if (!expected) {
    // Unknown extension — allow but still enforce size
    return;
  }

  const header = await readFile(filePath);
  const sample = header.subarray(0, Math.min(header.length, 16));
  const valid = expected.some(({ magic, offset }) => matchesMagic(sample, magic, offset ?? 0));
  if (!valid) {
    throw new SandboxError(
      `File extension ${ext} does not match content magic bytes: ${path.basename(filePath)}`,
    );
  }
}

/** List basenames in a download directory (non-recursive). */
export async function listDownloadBasenames(downloadDir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(downloadDir);
    return new Set(entries);
  } catch {
    return new Set();
  }
}

/**
 * Remove files created during an aborted browser run. Deletes any file in
 * `downloadDir` that was not present in `beforeAbort` plus Playwright
 * partial download suffixes.
 */
export async function cleanupPartialDownloads(
  downloadDir: string,
  beforeAbort: Set<string>,
): Promise<void> {
  const current = await listDownloadBasenames(downloadDir);
  for (const name of current) {
    if (beforeAbort.has(name)) continue;
    if (name.endsWith(".crdownload")) {
      await unlink(path.join(downloadDir, name)).catch(() => undefined);
      continue;
    }
    await unlink(path.join(downloadDir, name)).catch(() => undefined);
  }
}

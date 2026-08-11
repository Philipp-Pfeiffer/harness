import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ComponentLogger } from "./logger.js";

/* ─── Curator Ping (script job) ───
 *
 * After a successful stage-2 curator run the daemon pings the WhatsApp
 * session via the system event bus. The ping carries metadata only
 * (proposal count + report path) — never report content.
 *
 * The job is idempotent per run: it reads the newest report in
 * `$STATE/curator/reports/`, counts the numbered proposals
 * (`N. [typ: ...]`), and builds the event text. No report or empty
 * report → no ping (logged, not thrown).
 */

const REPORT_DIR_NAME = "curator/reports";
const REPORT_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const PROPOSAL_RE = /^\s*\d+\.\s*\[typ: (?:skill-create|skill-merge|memory-fix|frage)\]/;

export interface CuratorPingOptions {
  stateDir: string;
  logger: ComponentLogger;
  injectEvent: (event: { origin: string; text: string }) => Promise<void> | void;
}

export function parseProposalCount(content: string): number {
  let count = 0;
  for (const line of content.split("\n")) {
    if (PROPOSAL_RE.test(line)) count++;
  }
  return count;
}

export async function buildCuratorPingText(
  stateDir: string,
  logger: ComponentLogger,
): Promise<string | null> {
  const reportsDir = join(stateDir, REPORT_DIR_NAME);

  let files: string[];
  try {
    files = (await readdir(reportsDir)).filter((f) => REPORT_FILE_RE.test(f));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      logger.info("curator ping skipped — no reports directory");
      return null;
    }
    throw err;
  }
  if (files.length === 0) {
    logger.info("curator ping skipped — no reports found");
    return null;
  }

  files.sort();
  const newest = files[files.length - 1]!;
  const content = await readFile(join(reportsDir, newest), "utf-8");
  const count = parseProposalCount(content);
  if (count === 0) {
    logger.info("curator ping skipped — newest report has no proposals", {
      report: newest,
    });
    return null;
  }

  const dateKey = newest.replace(/\.md$/, "");
  const path = join("~/.harness/curator/reports", newest);
  logger.info("curator ping built", { report: newest, proposals: count });
  return `Curator-Report fertig: ${count} Vorschläge, Pfad ${path} (${dateKey})`;
}

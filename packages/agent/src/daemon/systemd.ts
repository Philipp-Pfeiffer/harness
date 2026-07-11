import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import { resolveHarnessPaths } from "@harness/core";

export interface SystemdUnitOptions {
  /** Node binary path. Defaults to process.execPath. */
  nodePath?: string;
  /** Path to the built dist/index.js entry point. */
  entryPath?: string;
  /** Extra environment variables to set in the unit file. */
  env?: Record<string, string>;
}

/**
 * Generates the systemd user service unit file for the harness daemon.
 *
 * Returns the file content (also written to disk by installSystemdUnit).
 */
export function generateSystemdUnit(opts?: SystemdUnitOptions): string {
  const nodePath = opts?.nodePath ?? process.execPath;
  const home = resolveHarnessPaths().home;
  const state = resolveHarnessPaths().state;

  // EnvironmentFile: systemd loads .env from $HARNESS_HOME (belt) — the
  // daemon also loads it itself via dotenv (suspenders). We use the %h
  // specifier (systemd user-home) so the default ~/harness/.env works
  // without relying on HARNESS_HOME being set yet.
  // Literal %h in systemd means: do NOT shell-expand — systemd replaces
  // it with the user's home directory natively.
  // If HARNESS_HOME is non-default (via env), we use the absolute path
  // since %h would point to the wrong location.
  const isDefaultHome = home === join(os.homedir(), "harness");
  const envFile = isDefaultHome ? "%h/harness/.env" : `${home}/.env`;

  const envLines: string[] = [
    `Environment="HARNESS_HOME=${home}"`,
    `Environment="HARNESS_STATE=${state}"`,
    `Environment="PATH=/usr/local/bin:/usr/bin:/bin:${dirname(nodePath)}"`,
  ];
  for (const [key, val] of Object.entries(opts?.env ?? {})) {
    envLines.push(`Environment="${key}=${val}"`);
  }

  return [
    "[Unit]",
    "Description=Harness Agent Daemon",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `Type=simple`,
    `ExecStart=${nodePath} ${opts?.entryPath ?? defaultEntryPath()} daemon run`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=30",
    `EnvironmentFile=${envFile}`,
    ...envLines,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * Writes the systemd unit file to the default user service path
 * (~/.config/systemd/user/harness-daemon.service).
 *
 * Returns the path where the file was written.
 */
export async function installSystemdUnit(
  opts?: SystemdUnitOptions,
): Promise<string> {
  const unitDir = join(
    os.homedir(),
    ".config",
    "systemd",
    "user",
  );
  const unitPath = join(unitDir, "harness-daemon.service");
  await mkdir(unitDir, { recursive: true });

  const content = generateSystemdUnit(opts);
  await writeFile(unitPath, content, "utf-8");

  return unitPath;
}

function defaultEntryPath(): string {
  // Resolve relative to the current module location
  const distIndex = new URL("../../dist/index.js", import.meta.url);
  return distIndex.pathname;
}

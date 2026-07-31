import { describe, it, expect } from "vitest";
import {
  daemonRunPgrepPattern,
  findDaemonRunPids,
} from "../../src/daemon/process.js";

describe("daemon process discovery", () => {
  it("builds a pgrep pattern that does not match pgrep itself", () => {
    const entryPath = "/tmp/harness/packages/agent/dist/index.js";
    const pattern = daemonRunPgrepPattern(entryPath);
    expect(pattern).toContain("[d]aemon run");
    expect(pattern).not.toContain("daemon run");
  });

  it("returns no PIDs when no daemon is running", async () => {
    const fakeEntry = `/tmp/harness-no-daemon-${process.pid}/index.js`;
    const pids = await findDaemonRunPids(fakeEntry);
    expect(pids).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { generateSystemdUnit } from "../../src/daemon/systemd.js";

describe("systemd unit generation", () => {
  it("generates a valid unit file with required sections", () => {
    const unit = generateSystemdUnit({
      nodePath: "/usr/bin/node",
      entryPath: "/opt/harness/dist/index.js",
      env: { HARNESS_HOME: "/home/user/harness", HARNESS_STATE: "/home/user/.harness" },
    });

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("Description=Harness Agent Daemon");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("uses provided node and entry paths", () => {
    const unit = generateSystemdUnit({
      nodePath: "/usr/local/bin/node",
      entryPath: "/opt/harness/dist/index.js",
    });

    expect(unit).toContain("ExecStart=/usr/local/bin/node /opt/harness/dist/index.js daemon run");
  });

  it("includes HARNESS_HOME and HARNESS_STATE environment", () => {
    const unit = generateSystemdUnit({
      nodePath: "/usr/bin/node",
      entryPath: "/opt/harness/dist/index.js",
    });

    expect(unit).toContain("HARNESS_HOME=");
    expect(unit).toContain("HARNESS_STATE=");
  });

  it("includes extra env vars", () => {
    const unit = generateSystemdUnit({
      nodePath: "/usr/bin/node",
      entryPath: "/opt/harness/dist/index.js",
      env: { MY_CUSTOM_VAR: "custom-value" },
    });

    expect(unit).toContain('Environment="MY_CUSTOM_VAR=custom-value"');
  });

  it("has Restart=on-failure for crash recovery", () => {
    const unit = generateSystemdUnit({
      nodePath: "/usr/bin/node",
      entryPath: "/opt/harness/dist/index.js",
    });

    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5");
  });
});

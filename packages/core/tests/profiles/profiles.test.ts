import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseAgentProfileFile,
  substituteVars,
  AgentProfileFrontmatterError,
} from "../../src/profiles/frontmatter.js";
import { loadAgentProfiles } from "../../src/profiles/loader.js";

/* ─── Test Helpers ─── */

function makeProfileDir(
  profilesDir: string,
  name: string,
  content: string,
): string {
  const dir = join(profilesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), content, "utf-8");
  return dir;
}

function makeProfileContent(opts: {
  name: string;
  frontmatter?: string[];
  body?: string;
}): string {
  const lines = ["---", `name: ${opts.name}`, ...(opts.frontmatter ?? []), "---"];
  lines.push(opts.body ?? `Persona for ${opts.name}.`);
  return lines.join("\n");
}

let baseDir: string;
let profilesDir: string;
let builtinDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "harness-profiles-"));
  profilesDir = join(baseDir, "agents");
  builtinDir = join(baseDir, "builtin-agents");
  mkdirSync(profilesDir, { recursive: true });
  mkdirSync(builtinDir, { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

/* ─── Frontmatter Parsing ─── */

describe("parseAgentProfileFile", () => {
  it("parses a complete profile file", () => {
    const parsed = parseAgentProfileFile(
      "/agents/worker/agent.md",
      makeProfileContent({
        name: "worker",
        frontmatter: [
          "model: minimax/MiniMax-M2.7",
          "thinking: true",
          "tools: readFile, exec",
          "memory: notes",
          "skills: false",
          "temperature: 0.7",
          "maxTokens: 4096",
        ],
        body: "You are a worker.",
      }),
      "worker",
    );

    expect(parsed.frontmatter).toEqual({
      name: "worker",
      model: { provider: "minimax", model: "MiniMax-M2.7" },
      thinking: true,
      tools: ["readFile", "exec"],
      memory: ["notes"],
      skills: false,
      temperature: 0.7,
      maxTokens: 4096,
    });
    expect(parsed.body).toBe("You are a worker.");
  });

  it("applies defaults for absent optional fields", () => {
    const parsed = parseAgentProfileFile(
      "/agents/default/agent.md",
      makeProfileContent({ name: "default" }),
      "default",
    );

    expect(parsed.frontmatter).toEqual({
      name: "default",
      model: undefined,
      thinking: undefined,
      tools: undefined,
      memory: undefined,
      skills: true,
      temperature: undefined,
      maxTokens: undefined,
    });
  });

  it("treats present-but-empty tools and memory as explicit empty lists", () => {
    const parsed = parseAgentProfileFile(
      "/agents/worker/agent.md",
      `---\nname: worker\ntools:\nmemory:\n---\nPersona.\n`,
      "worker",
    );
    expect(parsed.frontmatter.tools).toEqual([]);
    expect(parsed.frontmatter.memory).toEqual([]);
  });

  it("rejects a missing frontmatter block", () => {
    expect(() =>
      parseAgentProfileFile("/agents/x/agent.md", "no frontmatter here", "x"),
    ).toThrow(AgentProfileFrontmatterError);
  });

  it("rejects a name that does not match the folder", () => {
    expect(() =>
      parseAgentProfileFile(
        "/agents/x/agent.md",
        makeProfileContent({ name: "other" }),
        "x",
      ),
    ).toThrow(/does not match folder name/);
  });

  it("rejects an invalid profile name", () => {
    expect(() =>
      parseAgentProfileFile(
        "/agents/Bad_Name/agent.md",
        makeProfileContent({ name: "Bad_Name" }),
        "Bad_Name",
      ),
    ).toThrow(/invalid name/);
  });

  it("rejects an invalid model format", () => {
    expect(() =>
      parseAgentProfileFile(
        "/agents/x/agent.md",
        makeProfileContent({ name: "x", frontmatter: ["model: no-provider-here"] }),
        "x",
      ),
    ).toThrow(/invalid model/);
  });

  it("rejects an invalid thinking value", () => {
    expect(() =>
      parseAgentProfileFile(
        "/agents/x/agent.md",
        makeProfileContent({ name: "x", frontmatter: ["thinking: maybe"] }),
        "x",
      ),
    ).toThrow(/invalid value for "thinking"/);
  });

  it("rejects an unknown memory zone", () => {
    expect(() =>
      parseAgentProfileFile(
        "/agents/x/agent.md",
        makeProfileContent({ name: "x", frontmatter: ["memory: core, vault"] }),
        "x",
      ),
    ).toThrow(/invalid memory zone "vault"/);
  });

  it("rejects an invalid skills value", () => {
    expect(() =>
      parseAgentProfileFile(
        "/agents/x/agent.md",
        makeProfileContent({ name: "x", frontmatter: ["skills: yes"] }),
        "x",
      ),
    ).toThrow(/invalid value for "skills"/);
  });

  it("rejects invalid sampling parameters", () => {
    expect(() =>
      parseAgentProfileFile(
        "/agents/x/agent.md",
        makeProfileContent({ name: "x", frontmatter: ["temperature: hot"] }),
        "x",
      ),
    ).toThrow(/invalid value for "temperature"/);
    expect(() =>
      parseAgentProfileFile(
        "/agents/x/agent.md",
        makeProfileContent({ name: "x", frontmatter: ["maxTokens: 100.5"] }),
        "x",
      ),
    ).toThrow(/invalid value for "maxTokens"/);
  });

  it("rejects unknown frontmatter keys", () => {
    expect(() =>
      parseAgentProfileFile(
        "/agents/x/agent.md",
        makeProfileContent({ name: "x", frontmatter: ["tool: readFile"] }),
        "x",
      ),
    ).toThrow(/unknown frontmatter key/);
  });

  it("rejects an empty body", () => {
    expect(() =>
      parseAgentProfileFile("/agents/x/agent.md", "---\nname: x\n---\n\n", "x"),
    ).toThrow(/empty body/);
  });

  it("substitutes known vars in the body and leaves unknown placeholders intact", () => {
    const parsed = parseAgentProfileFile(
      "/agents/x/agent.md",
      makeProfileContent({
        name: "x",
        body: "Inbox: {{inboxPath}}. Unknown: {{other}}.",
      }),
      "x",
      { inboxPath: "/home/u/memory/_inbox.md" },
    );
    expect(parsed.body).toBe("Inbox: /home/u/memory/_inbox.md. Unknown: {{other}}.");
  });

  it("substituteVars replaces only known vars", () => {
    expect(substituteVars("{{a}} {{b}}", { a: "1" })).toBe("1 {{b}}");
  });
});

/* ─── Loader ─── */

describe("loadAgentProfiles", () => {
  it("loads built-in and user profiles, sorted by name", async () => {
    makeProfileDir(builtinDir, "default", makeProfileContent({ name: "default" }));
    makeProfileDir(profilesDir, "worker", makeProfileContent({ name: "worker" }));

    const result = await loadAgentProfiles({ profilesDir, builtinDir });
    expect(result.errors).toEqual([]);
    expect(result.profiles.map((p) => p.name)).toEqual(["default", "worker"]);
    expect(result.profiles[0]!.builtin).toBe(true);
    expect(result.profiles[1]!.builtin).toBe(false);
  });

  it("user profile overrides built-in profile with the same name", async () => {
    makeProfileDir(builtinDir, "default", makeProfileContent({ name: "default", body: "Built-in persona." }));
    makeProfileDir(profilesDir, "default", makeProfileContent({ name: "default", body: "User persona." }));

    const result = await loadAgentProfiles({ profilesDir, builtinDir });
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]!.body).toBe("User persona.");
    expect(result.profiles[0]!.builtin).toBe(false);
  });

  it("collects errors for broken profiles without throwing and keeps the rest", async () => {
    makeProfileDir(profilesDir, "good", makeProfileContent({ name: "good" }));
    makeProfileDir(profilesDir, "bad", "no frontmatter");
    makeProfileDir(builtinDir, "also-bad", makeProfileContent({ name: "name-mismatch" }));

    const result = await loadAgentProfiles({ profilesDir, builtinDir });
    expect(result.profiles.map((p) => p.name)).toEqual(["good"]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]!.profileName).toBe("also-bad");
    expect(result.errors[1]!.profileName).toBe("bad");
    expect(result.errors[1]!.message).toMatch(/missing frontmatter/);
  });

  it("skips directories without agent.md and hidden directories silently", async () => {
    mkdirSync(join(profilesDir, "no-agent-md"), { recursive: true });
    makeProfileDir(profilesDir, ".hidden", makeProfileContent({ name: ".hidden" }).replace("name: .hidden", "name: x"));
    makeProfileDir(profilesDir, "good", makeProfileContent({ name: "good" }));

    const result = await loadAgentProfiles({ profilesDir, builtinDir });
    expect(result.errors).toEqual([]);
    expect(result.profiles.map((p) => p.name)).toEqual(["good"]);
  });

  it("returns an empty result when directories do not exist", async () => {
    const result = await loadAgentProfiles({
      profilesDir: join(baseDir, "does-not-exist"),
      builtinDir: join(baseDir, "also-not-there"),
    });
    expect(result.profiles).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("substitutes vars into loaded profile bodies", async () => {
    makeProfileDir(
      profilesDir,
      "default",
      makeProfileContent({ name: "default", body: "Inbox at {{inboxPath}}." }),
    );
    const result = await loadAgentProfiles({
      profilesDir,
      vars: { inboxPath: "/h/memory/_inbox.md" },
    });
    expect(result.profiles[0]!.body).toBe("Inbox at /h/memory/_inbox.md.");
  });
});

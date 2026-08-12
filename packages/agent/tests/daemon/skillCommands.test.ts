/**
 * Daemon skill slash command tests.
 *
 * Verifies the /skills and /skill disable|enable commands on the
 * handleChannelSlashCommand layer:
 * - /skill disable <name> persists disabled: true in the skill.md frontmatter
 * - /skill enable <name> persists disabled: false
 * - The toggle survives a "restart" (re-read from disk)
 * - /skills lists name, status and the disabled flag
 * - Unknown skill names are rejected with a hint to /skills
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, RunResult, Model } from "@harness/core";
import type { Api } from "@mariozechner/pi-ai";
import { DaemonRuntime } from "../../src/daemon/runtime.js";

const TEST_DIR = join(tmpdir(), `harness-skillcmd-${process.pid}-${Date.now()}`);
const HOME_DIR = join(TEST_DIR, "home");
const SKILLS_DIR = join(HOME_DIR, "skills");

let savedHome: string | undefined;
let savedState: string | undefined;

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(join(TEST_DIR, "state", "logs"), { recursive: true });
  await mkdir(join(SKILLS_DIR, "demo-skill"), { recursive: true });
  savedHome = process.env.HARNESS_HOME;
  savedState = process.env.HARNESS_STATE;
  process.env.HARNESS_HOME = HOME_DIR;
  process.env.HARNESS_STATE = join(TEST_DIR, "state");
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHome;
  if (savedState === undefined) delete process.env.HARNESS_STATE;
  else process.env.HARNESS_STATE = savedState;
  await rm(TEST_DIR, { recursive: true, force: true });
});

async function writeSkillMd(name: string, extra = ""): Promise<void> {
  await writeFile(
    join(SKILLS_DIR, name, "skill.md"),
    `---\nname: ${name}\ndescription: Use when: testing. Don't use when: not testing.\nlevel: atom\nstatus: active${extra}\n---\nBody for ${name}.\n`,
    "utf-8",
  );
}

function createFakeModel(): Model<Api> {
  return {
    name: "fake-default",
    id: "fake-default-id",
    provider: "fake",
    setApiKey() {},
  } as unknown as Model<Api>;
}

function createFakeAgent(): Agent {
  return {
    setModel() {},
    setSystemPrompt() {},
    async run(): Promise<RunResult> {
      return {
        aborted: false,
        turns: 0,
        finalMessage: "ok",
        toolCallCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
      };
    },
  } as unknown as Agent;
}

function createRuntime(): DaemonRuntime {
  const runtime = new DaemonRuntime();
  const internals = runtime as unknown as { agent: Agent; model: Model<Api>; configModels: unknown[] };
  internals.agent = createFakeAgent();
  internals.model = createFakeModel();
  internals.configModels = [];
  return runtime;
}

describe("skill slash commands", () => {
  it("/skill disable persists disabled: true in the frontmatter", async () => {
    await writeSkillMd("demo-skill");
    const runtime = createRuntime();

    const result = await runtime.handleChannelSlashCommand("s1", "/skill disable demo-skill");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("deaktiviert");

    const content = await readFile(join(SKILLS_DIR, "demo-skill", "skill.md"), "utf-8");
    expect(content).toContain("disabled: true");
  });

  it("/skill enable reverts disabled: false in the frontmatter", async () => {
    await writeSkillMd("demo-skill", "\ndisabled: true");
    const runtime = createRuntime();

    const result = await runtime.handleChannelSlashCommand("s1", "/skill enable demo-skill");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("aktiviert");

    const content = await readFile(join(SKILLS_DIR, "demo-skill", "skill.md"), "utf-8");
    expect(content).toContain("disabled: false");
  });

  it("the disabled flag survives a daemon restart (re-read from disk)", async () => {
    await writeSkillMd("demo-skill");
    const runtime = createRuntime();
    await runtime.handleChannelSlashCommand("s1", "/skill disable demo-skill");

    // Simulated restart: a fresh runtime reads the persisted flag.
    const restarted = createRuntime();
    const overview = await restarted.handleChannelSlashCommand("s2", "/skills");
    expect(overview).not.toBeNull();
    expect(overview!.response).toContain("demo-skill");
    expect(overview!.response).toContain("disabled");
  });

  it("/skills lists name, status and disabled flag", async () => {
    await writeSkillMd("demo-skill", "\ndisabled: true");
    await mkdir(join(SKILLS_DIR, "other-skill"), { recursive: true });
    await writeSkillMd("other-skill");
    const runtime = createRuntime();

    const result = await runtime.handleChannelSlashCommand("s1", "/skills");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("demo-skill: active disabled");
    expect(result!.response).toContain("other-skill: active");
  });

  it("rejects unknown skill names with a hint to /skills", async () => {
    await writeSkillMd("demo-skill");
    const runtime = createRuntime();

    const result = await runtime.handleChannelSlashCommand("s1", "/skill disable does-not-exist");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("nicht gefunden");
    expect(result!.response).toContain("/skills");
  });

  it("/skills lists the disabled flag after a disable toggle", async () => {
    await writeSkillMd("demo-skill");
    const runtime = createRuntime();
    await runtime.handleChannelSlashCommand("s1", "/skill disable demo-skill");

    const overview = await runtime.handleChannelSlashCommand("s1", "/skills");
    expect(overview).not.toBeNull();
    expect(overview!.response).toContain("demo-skill: active disabled");
  });
});

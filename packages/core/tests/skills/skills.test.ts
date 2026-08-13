import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSkills, validateRequires, computeRoutableSkills } from "../../src/skills/loader.js";
import { parseSkillFile, SkillFrontmatterError } from "../../src/skills/frontmatter.js";
import { buildHotSet, renderHotSet } from "../../src/skills/hotSet.js";
import { readTelemetry, writeTelemetry, recordSkillUse, telemetryPathFor } from "../../src/skills/telemetry.js";
import { createLoadSkillTool } from "../../src/tools/loadSkill.js";
import { createFindSkillTool } from "../../src/tools/findSkill.js";
import type { SkillRecord } from "../../src/skills/types.js";

/* ─── Test Helpers ─── */

function makeSkillDir(
  skillsDir: string,
  name: string,
  content: string,
): string {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.md"), content, "utf-8");
  return dir;
}

function makeSkillContent(opts: {
  name: string;
  description: string;
  level?: "atom" | "molecule";
  requires?: string[];
  status?: "draft" | "active" | "stale" | "archive";
  pinned?: boolean;
  routable?: boolean;
  disabled?: boolean;
  body?: string;
}): string {
  const lines = ["---"];
  lines.push(`name: ${opts.name}`);
  lines.push(`description: ${opts.description}`);
  lines.push(`level: ${opts.level ?? "atom"}`);
  if (opts.requires && opts.requires.length > 0) {
    lines.push(`requires: ${opts.requires.join(", ")}`);
  }
  if (opts.status) {
    lines.push(`status: ${opts.status}`);
  }
  if (opts.pinned !== undefined) {
    lines.push(`pinned: ${opts.pinned}`);
  }
  if (opts.routable !== undefined) {
    lines.push(`routable: ${opts.routable}`);
  }
  if (opts.disabled !== undefined) {
    lines.push(`disabled: ${opts.disabled}`);
  }
  lines.push("---");
  lines.push(opts.body ?? `Body for ${opts.name}.`);
  return lines.join("\n");
}

let baseDir: string;
let skillsDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "harness-skills-test-"));
  skillsDir = join(baseDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/* ─── Frontmatter Parsing Tests ─── */

describe("parseSkillFile", () => {
  it("parses valid skill with all fields", () => {
    const content = makeSkillContent({
      name: "my-skill",
      description: "A test skill. Use when: testing. Don't use when: not testing.",
      level: "atom",
      status: "active",
      pinned: true,
      routable: true,
      disabled: true,
    });
    const result = parseSkillFile("/test/my-skill/skill.md", content, "my-skill");
    expect(result.frontmatter.name).toBe("my-skill");
    expect(result.frontmatter.description).toContain("Use when:");
    expect(result.frontmatter.level).toBe("atom");
    expect(result.frontmatter.status).toBe("active");
    expect(result.frontmatter.pinned).toBe(true);
    expect(result.frontmatter.routable).toBe(true);
    expect(result.frontmatter.disabled).toBe(true);
  });

  it("defaults status to active, pinned to false, routable to true", () => {
    const content = makeSkillContent({
      name: "defaults-skill",
      description: "Use when: testing. Don't use when: not.",
    });
    const result = parseSkillFile("/test/defaults-skill/skill.md", content, "defaults-skill");
    expect(result.frontmatter.status).toBe("active");
    expect(result.frontmatter.pinned).toBe(false);
    expect(result.frontmatter.routable).toBe(true);
    expect(result.frontmatter.disabled).toBe(false);
    expect(result.frontmatter.requires).toEqual([]);
  });

  it("parses disabled: true", () => {
    const content = makeSkillContent({
      name: "disabled-skill",
      description: "Use when: testing.",
      disabled: true,
    });
    const result = parseSkillFile("/test/disabled-skill/skill.md", content, "disabled-skill");
    expect(result.frontmatter.disabled).toBe(true);
  });

  it("throws on invalid disabled value", () => {
    const content = makeSkillContent({
      name: "bad-disabled",
      description: "Use when: testing.",
    }).replace("---", "---\ndisabled: vielleicht");
    expect(() => parseSkillFile("/test/bad-disabled/skill.md", content, "bad-disabled")).toThrow(
      SkillFrontmatterError,
    );
    expect(() => parseSkillFile("/test/bad-disabled/skill.md", content, "bad-disabled")).toThrow(
      'invalid value for "disabled"',
    );
  });

  it("throws on name mismatch", () => {
    const content = makeSkillContent({
      name: "wrong-name",
      description: "Use when: testing.",
    });
    expect(() => parseSkillFile("/test/dir/skill.md", content, "dir")).toThrow(
      SkillFrontmatterError,
    );
  });

  it("throws on missing name", () => {
    const content = `---\ndescription: No name.\nlevel: atom\n---\nbody`;
    expect(() => parseSkillFile("/test/x/skill.md", content, "x")).toThrow(
      "missing required field: name",
    );
  });

  it("throws on missing description", () => {
    const content = `---\nname: x\nlevel: atom\n---\nbody`;
    expect(() => parseSkillFile("/test/x/skill.md", content, "x")).toThrow(
      "missing required field: description",
    );
  });

  it("throws on missing level", () => {
    const content = `---\nname: x\ndescription: Use when: test.\n---\nbody`;
    expect(() => parseSkillFile("/test/x/skill.md", content, "x")).toThrow(
      "level",
    );
  });

  it("throws on invalid level", () => {
    const content = `---\nname: x\ndescription: Use when: test.\nlevel: planet\n---\nbody`;
    expect(() => parseSkillFile("/test/x/skill.md", content, "x")).toThrow(
      "level",
    );
  });

  it("throws on invalid name format (uppercase)", () => {
    const content = makeSkillContent({
      name: "MySkill",
      description: "Use when: test.",
    });
    expect(() => parseSkillFile("/test/MySkill/skill.md", content, "MySkill")).toThrow(
      "must be lowercase-hyphenated",
    );
  });

  it("throws on missing frontmatter block", () => {
    expect(() => parseSkillFile("/test/x/skill.md", "no frontmatter here", "x")).toThrow(
      "missing frontmatter block",
    );
  });
});

/* ─── Loader Tests ─── */

describe("loadSkills", () => {
  it("loads valid skills successfully", async () => {
    makeSkillDir(skillsDir, "skill-a", makeSkillContent({
      name: "skill-a",
      description: "Use when: A. Don't use when: not A.",
    }));
    makeSkillDir(skillsDir, "skill-b", makeSkillContent({
      name: "skill-b",
      description: "Use when: B.",
      level: "molecule",
    }));

    const result = await loadSkills({ skillsDir });
    expect(result.errors).toHaveLength(0);
    expect(result.skills).toHaveLength(2);
    expect(result.skills.map((s) => s.name)).toEqual(["skill-a", "skill-b"]);
  });

  it("collects errors without throwing", async () => {
    makeSkillDir(skillsDir, "good-skill", makeSkillContent({
      name: "good-skill",
      description: "Use when: good.",
    }));
    // Bad skill — name mismatch
    makeSkillDir(skillsDir, "bad-skill", makeSkillContent({
      name: "wrong-name",
      description: "Use when: bad.",
    }));

    const result = await loadSkills({ skillsDir });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe("good-skill");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.skillName).toBe("bad-skill");
  });

  it("skips hidden directories and _telemetry.json", async () => {
    makeSkillDir(skillsDir, "real-skill", makeSkillContent({
      name: "real-skill",
      description: "Use when: real.",
    }));
    // Hidden directory — should be skipped
    mkdirSync(join(skillsDir, ".hidden"), { recursive: true });
    // Underscore directory — should be skipped
    mkdirSync(join(skillsDir, "_internal"), { recursive: true });

    const result = await loadSkills({ skillsDir });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe("real-skill");
  });

  it("returns empty result for missing directory", async () => {
    const result = await loadSkills({ skillsDir: "/non/existent/path" });
    expect(result.skills).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("warns when skill.md exceeds 1200 tokens", async () => {
    const bigBody = "x".repeat(5000); // ~1250 tokens
    makeSkillDir(skillsDir, "big-skill", makeSkillContent({
      name: "big-skill",
      description: "Use when: big.",
      body: bigBody,
    }));

    const result = await loadSkills({ skillsDir });
    expect(result.skills).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("big-skill");
    expect(result.warnings[0]).toContain("tokens");
  });

  it("detects scripts/, references/, evals/ subdirectories", async () => {
    const dir = makeSkillDir(skillsDir, "full-skill", makeSkillContent({
      name: "full-skill",
      description: "Use when: full.",
    }));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "references"), { recursive: true });
    mkdirSync(join(dir, "evals"), { recursive: true });

    const result = await loadSkills({ skillsDir });
    const skill = result.skills.find((s) => s.name === "full-skill");
    expect(skill?.hasScripts).toBe(true);
    expect(skill?.hasReferences).toBe(true);
    expect(skill?.hasEvals).toBe(true);
  });

  it("user skills override built-in skills with same name", async () => {
    const builtinDir = join(baseDir, "builtin-skills");
    mkdirSync(builtinDir, { recursive: true });

    makeSkillDir(builtinDir, "shared", makeSkillContent({
      name: "shared",
      description: "Builtin version. Use when: builtin.",
    }));
    makeSkillDir(skillsDir, "shared", makeSkillContent({
      name: "shared",
      description: "User version. Use when: user.",
    }));

    const result = await loadSkills({ skillsDir, builtinDir });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.frontmatter.description).toContain("User version");
    expect(result.skills[0]!.builtin).toBe(false);
  });
});

/* ─── requires Validation Tests ─── */

describe("validateRequires", () => {
  function makeRecord(name: string, requires: string[] = []): SkillRecord {
    return {
      name,
      frontmatter: {
        name,
        description: "Use when: test.",
        level: "atom",
        requires,
        status: "active",
        pinned: false,
        routable: true,
        disabled: false,
      },
      body: "",
      filePath: `/test/${name}/skill.md`,
      dir: `/test/${name}`,
      builtin: false,
      tokenEstimate: 10,
      hasScripts: false,
      hasReferences: false,
      hasEvals: false,
    };
  }

  it("passes when all requires targets exist", () => {
    const skills = [
      makeRecord("parent", ["child"]),
      makeRecord("child", []),
    ];
    expect(validateRequires(skills)).toHaveLength(0);
  });

  it("fails when requires target does not exist", () => {
    const skills = [makeRecord("parent", ["missing"])];
    const errors = validateRequires(skills);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing");
  });

  it("fails when requires target itself has requires (depth > 1)", () => {
    const skills = [
      makeRecord("grandparent", ["parent"]),
      makeRecord("parent", ["child"]),
      makeRecord("child", []),
    ];
    const errors = validateRequires(skills);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("max depth 1 violated");
  });
});

/* ─── Routability Tests ─── */

describe("computeRoutableSkills", () => {
  function makeRecord(
    name: string,
    level: "atom" | "molecule",
    requires: string[] = [],
    routable = true,
  ): SkillRecord {
    return {
      name,
      frontmatter: {
        name,
        description: "Use when: test.",
        level: "atom",
        requires,
        status: "active",
        pinned: false,
        routable,
        disabled: false,
      },
      body: "",
      filePath: `/test/${name}/skill.md`,
      dir: `/test/${name}`,
      builtin: false,
      tokenEstimate: 10,
      hasScripts: false,
      hasReferences: false,
      hasEvals: false,
    };
  }

  it("includes routable atoms without incoming requires", () => {
    const skills = [
      makeRecord("standalone", "atom"),
      makeRecord("parent", "molecule", ["child"]),
      makeRecord("child", "atom"),
    ];
    const routable = computeRoutableSkills(skills);
    expect(routable.has("standalone")).toBe(true);
    expect(routable.has("parent")).toBe(true);
    // child is an atom with incoming requires → not routable
    expect(routable.has("child")).toBe(false);
  });

  it("excludes skills with routable=false", () => {
    const skills = [
      makeRecord("visible", "atom"),
      makeRecord("hidden", "atom", [], false),
    ];
    const routable = computeRoutableSkills(skills);
    expect(routable.has("visible")).toBe(true);
    expect(routable.has("hidden")).toBe(false);
  });

  it("excludes disabled skills even when routable=true", () => {
    const skills = [
      makeRecord("enabled", "atom"),
      makeRecord("switched-off", "atom"),
    ];
    skills[1]!.frontmatter.disabled = true;
    const routable = computeRoutableSkills(skills);
    expect(routable.has("enabled")).toBe(true);
    expect(routable.has("switched-off")).toBe(false);
  });
});

/* ─── Hot-Set Tests ─── */

describe("buildHotSet", () => {
  function makeSkill(
    name: string,
    opts?: {
      status?: "draft" | "active" | "stale" | "archive";
      pinned?: boolean;
      disabled?: boolean;
      description?: string;
    },
  ): SkillRecord {
    const desc =
      opts?.description ??
      `Skill ${name}. Use when: doing ${name}. Don't use when: not doing ${name}.`;
    return {
      name,
      frontmatter: {
        name,
        description: desc,
        level: "atom",
        requires: [],
        status: opts?.status ?? "active",
        pinned: opts?.pinned ?? false,
        routable: true,
        disabled: opts?.disabled ?? false,
      },
      body: "",
      filePath: `/test/${name}/skill.md`,
      dir: `/test/${name}`,
      builtin: false,
      tokenEstimate: 10,
      hasScripts: false,
      hasReferences: false,
      hasEvals: false,
    };
  }

  it("includes pinned skills", () => {
    const skills = [
      makeSkill("pinned-1", { pinned: true }),
      makeSkill("regular-1"),
    ];
    const hotSet = buildHotSet(skills, {});
    expect(hotSet.map((s) => s.name)).toContain("pinned-1");
  });

  it("excludes draft skills", () => {
    const skills = [
      makeSkill("draft-skill", { status: "draft", pinned: true }),
    ];
    const hotSet = buildHotSet(skills, {});
    expect(hotSet).toHaveLength(0);
  });

  it("excludes stale and archive skills", () => {
    const skills = [
      makeSkill("stale-skill", { status: "stale", pinned: true }),
      makeSkill("archive-skill", { status: "archive", pinned: true }),
    ];
    const hotSet = buildHotSet(skills, {});
    expect(hotSet).toHaveLength(0);
  });

  it("excludes disabled skills even when active and pinned", () => {
    const skills = [
      makeSkill("switched-off", { pinned: true, disabled: true }),
      makeSkill("enabled", { pinned: true }),
    ];
    const hotSet = buildHotSet(skills, {});
    expect(hotSet.map((s) => s.name)).not.toContain("switched-off");
    expect(hotSet.map((s) => s.name)).toContain("enabled");
  });

  it("orders by telemetry uses (descending)", () => {
    const skills = [
      makeSkill("low-use"),
      makeSkill("high-use"),
      makeSkill("medium-use"),
    ];
    const telemetry = {
      "low-use": { uses: 1, last_used: "2024-01-01", patches: 0, pinned: false },
      "high-use": { uses: 100, last_used: "2024-06-01", patches: 0, pinned: false },
      "medium-use": { uses: 50, last_used: "2024-03-01", patches: 0, pinned: false },
    };
    const hotSet = buildHotSet(skills, telemetry);
    // high-use should be first (most uses)
    expect(hotSet[0]!.name).toBe("high-use");
    expect(hotSet[1]!.name).toBe("medium-use");
    expect(hotSet[2]!.name).toBe("low-use");
  });

  it("respects token budget", () => {
    // Create skills with large descriptions to exceed budget
    const skills = Array.from({ length: 20 }, (_, i) =>
      makeSkill(`skill-${i}`, {
        description: `Skill ${i}. Use when: doing skill ${i}. `.repeat(10) + "Don't use when: not.",
      }),
    );
    const hotSet = buildHotSet(skills, {}, { budgetTokens: 500 });
    // Should not include all 20 — budget stops it
    expect(hotSet.length).toBeLessThan(20);
  });

  it("pinned skills come first, then by uses", () => {
    const skills = [
      makeSkill("low-pinned", { pinned: true }),
      makeSkill("high-uses"),
    ];
    const telemetry = {
      "low-pinned": { uses: 0, last_used: null, patches: 0, pinned: true },
      "high-uses": { uses: 100, last_used: "2024-01-01", patches: 0, pinned: false },
    };
    const hotSet = buildHotSet(skills, telemetry);
    expect(hotSet[0]!.name).toBe("low-pinned");
    expect(hotSet[1]!.name).toBe("high-uses");
  });

  it("renderHotSet returns empty string for empty set", () => {
    expect(renderHotSet([])).toBe("");
  });

  it("renderHotSet includes skill names and descriptions", () => {
    const skills = [makeSkill("test-skill", { pinned: true })];
    const hotSet = buildHotSet(skills, {});
    const rendered = renderHotSet(hotSet);
    expect(rendered).toContain("test-skill");
    expect(rendered).toContain("Available Skills");
  });
});

/* ─── Telemetry Tests ─── */

describe("Telemetry", () => {
  it("readTelemetry returns empty for missing file", async () => {
    const result = await readTelemetry(join(baseDir, "missing.json"));
    expect(result).toEqual({});
  });

  it("writeTelemetry then readTelemetry round-trips", async () => {
    const path = join(baseDir, "telemetry.json");
    const data = {
      "skill-a": { uses: 5, last_used: "2024-01-01", patches: 1, pinned: false },
    };
    await writeTelemetry(path, data);
    const result = await readTelemetry(path);
    expect(result["skill-a"]?.uses).toBe(5);
    expect(result["skill-a"]?.pinned).toBe(false);
  });

  it("recordSkillUse increments uses and sets last_used", async () => {
    const path = join(baseDir, "telemetry.json");
    await recordSkillUse(path, "my-skill", new Date("2024-06-01"));
    await recordSkillUse(path, "my-skill", new Date("2024-06-02"));
    const result = await readTelemetry(path);
    expect(result["my-skill"]?.uses).toBe(2);
    expect(result["my-skill"]?.last_used).toBe("2024-06-02T00:00:00.000Z");
  });

  it("telemetryPathFor returns path inside skills dir", () => {
    expect(telemetryPathFor("/foo/skills")).toBe("/foo/skills/_telemetry.json");
  });

  it("readTelemetry handles corrupt JSON gracefully", async () => {
    const path = join(baseDir, "corrupt.json");
    writeFileSync(path, "{ not valid json }", "utf-8");
    const result = await readTelemetry(path);
    expect(result).toEqual({});
  });
});

/* ─── load_skill Tool Tests ─── */

describe("load_skill tool", () => {
  function makeSkill(frontmatter: Partial<SkillRecord["frontmatter"]>): SkillRecord {
    return {
      name: "test-skill",
      frontmatter: {
        name: "test-skill",
        description: "Use when: testing.",
        level: "atom",
        requires: [],
        status: "active",
        pinned: false,
        routable: true,
        disabled: false,
        ...frontmatter,
      },
      body: "This is the skill body.",
      filePath: "/test/test-skill/skill.md",
      dir: "/test/test-skill",
      builtin: false,
      tokenEstimate: 5,
      hasScripts: false,
      hasReferences: false,
      hasEvals: false,
    };
  }

  it("returns skill body when found", async () => {
    const tool = createLoadSkillTool([makeSkill({})], skillsDir);
    const result = await tool.execute({ name: "test-skill" });
    expect(result.content).toContain("This is the skill body.");
    expect(result.content).toContain("test-skill");
  });

  it("returns error for unknown skill", async () => {
    const tool = createLoadSkillTool([], skillsDir);
    const result = await tool.execute({ name: "nonexistent" });
    expect(result.content).toContain("not found");
  });

  it("refuses disabled skills with a clear error, even when status is active", async () => {
    const tool = createLoadSkillTool([makeSkill({ disabled: true })], skillsDir);
    const result = await tool.execute({ name: "test-skill" });
    expect(result.content).toContain("ist deaktiviert (disabled: true). Erst enablen.");
    expect(result.content).not.toContain("This is the skill body.");
  });

  it("does not record telemetry for a refused disabled skill", async () => {
    const telemetryPath = telemetryPathFor(skillsDir);
    const tool = createLoadSkillTool([makeSkill({ disabled: true })], skillsDir);
    await tool.execute({ name: "test-skill" });
    const telemetry = await readTelemetry(telemetryPath);
    expect(telemetry["test-skill"]).toBeUndefined();
  });

  it("updates telemetry after load", async () => {
    const telemetryPath = telemetryPathFor(skillsDir);
    const tool = createLoadSkillTool([makeSkill({})], skillsDir);
    await tool.execute({ name: "test-skill" });
    const telemetry = await readTelemetry(telemetryPath);
    expect(telemetry["test-skill"]?.uses).toBe(1);
  });
});

/* ─── find_skill Tool Tests ─── */

describe("find_skill tool", () => {
  function makeSkill(
    name: string,
    description: string,
    level: "atom" | "molecule" = "atom",
    disabled = false,
  ): SkillRecord {
    return {
      name,
      frontmatter: {
        name,
        description,
        level,
        requires: [],
        status: "active",
        pinned: false,
        routable: true,
        disabled,
      },
      body: "",
      filePath: `/test/${name}/skill.md`,
      dir: `/test/${name}`,
      builtin: false,
      tokenEstimate: 1,
      hasScripts: false,
      hasReferences: false,
      hasEvals: false,
    };
  }

  it("returns matching skills by keyword", async () => {
    const skills = [
      makeSkill("cron-jobs", "Manage cron jobs. Use when: scheduling tasks."),
      makeSkill("memory-search", "Search memory. Use when: finding notes."),
    ];
    const tool = createFindSkillTool(skills);
    const result = await tool.execute({ query: "cron scheduling" });
    expect(result.content).toContain("cron-jobs");
    expect(result.content).not.toContain("memory-search");
  });

  it("excludes non-routable skills (atoms with incoming requires)", async () => {
    const skills: SkillRecord[] = [
      {
        name: "parent",
        frontmatter: {
          name: "parent",
          description: "Molecule. Use when: managing.",
          level: "molecule",
          requires: ["child"],
          status: "active",
          pinned: false,
          routable: true,
          disabled: false,
        },
        body: "",
        filePath: "/test/parent/skill.md",
        dir: "/test/parent",
        builtin: false,
        tokenEstimate: 1,
        hasScripts: false,
        hasReferences: false,
        hasEvals: false,
      },
      {
        name: "child",
        frontmatter: {
          name: "child",
          description: "Atom. Use when: sub-task.",
          level: "atom",
          requires: [],
          status: "active",
          pinned: false,
          routable: true,
          disabled: false,
        },
        body: "",
        filePath: "/test/child/skill.md",
        dir: "/test/child",
        builtin: false,
        tokenEstimate: 1,
        hasScripts: false,
        hasReferences: false,
        hasEvals: false,
      },
    ];
    const tool = createFindSkillTool(skills);
    const result = await tool.execute({ query: "sub-task" });
    // child has incoming requires → not routable → not in results
    // But "sub-task" matches child's description. Since child is not routable,
    // it should not appear. The parent's description doesn't mention "sub-task".
    expect(result.content).toContain("0 results");
  });

  it("excludes disabled skills even when they match the query", async () => {
    const skills = [
      makeSkill("cron-jobs", "Manage cron jobs. Use when: scheduling tasks."),
      makeSkill("memory-search", "Search memory. Use when: finding notes."),
    ];
    skills[1]!.frontmatter.disabled = true;
    const tool = createFindSkillTool(skills);
    // Only the disabled skill matches — the disabled skill must not appear.
    const result = await tool.execute({ query: "memory" });
    expect(result.content).toContain("0 results");
    expect(result.content).not.toContain("memory-search");
  });

  it("returns empty result message for no matches", async () => {
    const skills = [makeSkill("cron", "Manage cron. Use when: scheduling.")];
    const tool = createFindSkillTool(skills);
    const result = await tool.execute({ query: "xyzzy-nothing-matches" });
    expect(result.content).toContain("0 results");
  });
});

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHarnessPaths } from "@harness/core";
import {
  loadSkills,
  validateRequires,
  readTelemetry,
  telemetryPathFor,
} from "@harness/core";

/* ─── harness doctor ───
 *
 * Validates the skill system:
 * - Frontmatter validation (via loadSkills)
 * - requires targets exist + depth ≤ 1
 * - Token warnings (skill.md > 1200 tokens)
 * - Dark skills (loaded but never used according to telemetry)
 * - Disabled skills (deliberately switched off — shown separately, not
 *   warned as dark skills)
 *
 * Exit code 0 = no errors (warnings are ok), 1 = errors found.
 */

const BUILTIN_SKILLS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
);

export interface DoctorResult {
  stdout: string;
  exitCode: number;
}

export async function harnessDoctor(): Promise<DoctorResult> {
  const paths = resolveHarnessPaths();
  const telemetryPath = telemetryPathFor(paths.skills);

  // Load skills
  const result = await loadSkills({
    skillsDir: paths.skills,
    builtinDir: BUILTIN_SKILLS_DIR,
  });

  const lines: string[] = ["Harness Doctor — Skill System Check", "═".repeat(50), ""];

  // ─── Skills loaded ───
  lines.push(`Skills loaded: ${result.skills.length}`);
  lines.push(`Errors: ${result.errors.length}`);
  lines.push(`Warnings: ${result.warnings.length}`);
  lines.push("");

  // ─── Errors ───
  if (result.errors.length > 0) {
    lines.push("── Errors ──");
    for (const err of result.errors) {
      lines.push(`  ✗ ${err.skillName}: ${err.message}`);
    }
    lines.push("");
  }

  // ─── Warnings (token threshold) ───
  if (result.warnings.length > 0) {
    lines.push("── Warnings ──");
    for (const w of result.warnings) {
      lines.push(`  ⚠ ${w}`);
    }
    lines.push("");
  }

  // ─── requires validation ───
  const requireErrors = validateRequires(result.skills);
  if (requireErrors.length > 0) {
    lines.push("── Requires Validation ──");
    for (const err of requireErrors) {
      lines.push(`  ✗ ${err}`);
    }
    lines.push("");
  }

  // ─── Disabled skills (deliberately switched off by the operator) ───
  const disabledSkills = result.skills.filter((s) => s.frontmatter.disabled);

  if (disabledSkills.length > 0) {
    lines.push("── Disabled Skills (bewusst deaktiviert) ──");
    for (const skill of disabledSkills) {
      lines.push(`  ⊘ ${skill.name} [${skill.frontmatter.level}] (status: ${skill.frontmatter.status})`);
    }
    lines.push("");
  }

  // ─── Dark skills (never loaded) ───
  const telemetry = await readTelemetry(telemetryPath);
  const darkSkills = result.skills.filter(
    (s) => !s.frontmatter.disabled &&
      s.frontmatter.status === "active" &&
      (telemetry[s.name]?.uses ?? 0) === 0,
  );

  if (darkSkills.length > 0) {
    lines.push("── Dark Skills (never loaded) ──");
    for (const skill of darkSkills) {
      lines.push(`  • ${skill.name} [${skill.frontmatter.level}]`);
    }
    lines.push("");
  }

  // ─── Skill inventory ───
  if (result.skills.length > 0) {
    lines.push("── Skill Inventory ──");
    for (const skill of result.skills) {
      const uses = telemetry[skill.name]?.uses ?? 0;
      const pin = skill.frontmatter.pinned ? "📌 " : "   ";
      const route = skill.frontmatter.disabled
        ? "⊘"
        : skill.frontmatter.routable
        ? "r"
        : "-";
      const reqs = skill.frontmatter.requires.length > 0
        ? ` [requires: ${skill.frontmatter.requires.join(", ")}]`
        : "";
      lines.push(
        `  ${pin}${skill.name.padEnd(25)} ${skill.frontmatter.level.padEnd(9)} ${skill.frontmatter.status.padEnd(7)} [${route}] uses=${uses}${reqs}`,
      );
    }
    lines.push("");
  }

  const hasErrors = result.errors.length > 0 || requireErrors.length > 0;
  lines.push(hasErrors ? "Result: ❌ Errors found" : "Result: ✅ All checks passed");

  return {
    stdout: lines.join("\n"),
    exitCode: hasErrors ? 1 : 0,
  };
}

import { Type } from "@sinclair/typebox";
import { join } from "node:path";
import type { Tool } from "./types.js";
import { ok, err } from "./types.js";
import type { SkillRecord } from "../skills/types.js";
import { recordSkillUse, telemetryPathFor } from "../skills/telemetry.js";

/* ─── load_skill Tool ───
 *
 * Loads the full content of a skill by name. Updates telemetry.
 * Returns the skill.md body plus hints about scripts/references.
 */

const LoadSkillArgs = Type.Object({
  name: Type.String({
    description: "Skill name (lowercase-hyphenated, e.g. 'manage-cron-jobs').",
  }),
});

const MAX_SKILL_BODY_TOKENS = 8000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createLoadSkillTool(
  skills: SkillRecord[],
  skillsDir: string,
): Tool<typeof LoadSkillArgs> {
  return {
    name: "load_skill",
    description:
      "Load the full content of a skill by name. Returns the skill body text plus hints about available scripts/ references/ subdirectories. Use after find_skill or when you know a skill name from the system prompt.",
    parameters: LoadSkillArgs,
    async execute(args) {
      const skill = skills.find(
        (s) => s.name === args.name.trim().toLowerCase(),
      );

      if (!skill) {
        const available = skills.map((s) => s.name).join(", ");
        return err(`Skill not found: "${args.name}". Available skills: ${available}`);
      }

      // Update telemetry (best-effort)
      const telemetryPath = telemetryPathFor(skillsDir);
      await recordSkillUse(telemetryPath, skill.name);

      // Check token size
      const bodyTokens = estimateTokens(skill.body);
      if (bodyTokens > MAX_SKILL_BODY_TOKENS) {
        return ok(
          `Skill "${skill.name}" body is ~${bodyTokens} tokens (max: ${MAX_SKILL_BODY_TOKENS}). ` +
          `Consider reading it directly from ${skill.filePath} with line ranges.`
        );
      }

      // Build hints about subdirectories
      const hints: string[] = [];
      if (skill.hasScripts) {
        hints.push(`scripts/ — executable scripts for this skill (see ${join(skill.dir, "scripts")})`);
      }
      if (skill.hasReferences) {
        hints.push(`references/ — reference documents (see ${join(skill.dir, "references")})`);
      }
      if (skill.hasEvals) {
        hints.push(`evals/ — evaluation fixtures (see ${join(skill.dir, "evals")})`);
      }

      let result = `--- Skill: ${skill.name} ---\n${skill.body.trim()}`;
      if (hints.length > 0) {
        result += `\n\n--- Additional Resources ---\n${hints.join("\n")}`;
      }

      return ok(result);
    },
  };
}

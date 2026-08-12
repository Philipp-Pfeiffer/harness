import type {
  SkillRecord,
  SkillTelemetry,
  SkillStatus,
} from "./types.js";

/* ─── Tier-0 Hot-Set Builder ───
 *
 * Selects skills for inclusion in the system prompt:
 * - Always includes pinned skills (with status "active")
 * - Then top-N by telemetry uses (descending)
 * - Stays within a token budget (~2k tokens default)
 * - Only name + description are included (not the full body)
 * - Skills with status draft/stale/archive are never in the hot-set
 * - Skills with disabled:true are never in the hot-set
 */

const DEFAULT_BUDGET_TOKENS = 2000;
const DEFAULT_MAX_SKILLS = 20;

// Estimate: ~4 chars/token, same heuristic as compaction.ts
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Checks if a skill is eligible for the hot-set.
 * Only status "active" and not disabled skills are eligible.
 */
function isHotSetEligible(
  status: SkillStatus,
  disabled: boolean,
): boolean {
  return !disabled && status === "active";
}

/**
 * Builds the Tier-0 hot-set: skills whose name + description are
 * injected into the system prompt.
 *
 * Selection order:
 * 1. Pinned skills (active only)
 * 2. Top-N by telemetry.uses (descending), active only
 * 3. Stays within the token budget (counting name+description only)
 *
 * @param skills       All loaded skill records
 * @param telemetry    Telemetry sidecar data
 * @param opts         Budget and max skills options
 * @returns            Selected skill records (name + description only)
 */
export function buildHotSet(
  skills: SkillRecord[],
  telemetry: SkillTelemetry,
  opts?: { budgetTokens?: number; maxSkills?: number },
): SkillRecord[] {
  const budget = opts?.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const maxSkills = opts?.maxSkills ?? DEFAULT_MAX_SKILLS;

  // Filter to eligible (active status, not disabled)
  const eligible = skills.filter((s) =>
    isHotSetEligible(s.frontmatter.status, s.frontmatter.disabled),
  );

  // Split into pinned and non-pinned
  const pinned = eligible.filter((s) => s.frontmatter.pinned);
  const nonPinned = eligible.filter((s) => !s.frontmatter.pinned);

  // Sort non-pinned by telemetry uses (descending)
  const nonPinnedSorted = nonPinned
    .map((s) => ({
      skill: s,
      uses: telemetry[s.name]?.uses ?? 0,
    }))
    .sort((a, b) => b.uses - a.uses)
    .map((x) => x.skill);

  // Build hot-set: pinned first, then top by uses
  // Both stay within the token budget
  const result: SkillRecord[] = [];
  let tokensUsed = 0;

  for (const skill of [...pinned, ...nonPinnedSorted]) {
    if (result.length >= maxSkills) break;

    // Token cost: name + description + formatting overhead
    const formattedCost = estimateTokens(formatSkillForHotSet(skill));

    if (tokensUsed + formattedCost > budget) {
      // If this is a pinned skill, include it even if over budget
      // (pinned means "always include"). But stop after it.
      if (skill.frontmatter.pinned && result.length === 0) {
        result.push(skill);
        tokensUsed += formattedCost;
      }
      // If we're over budget, stop adding more
      if (tokensUsed >= budget) break;
      continue;
    }

    result.push(skill);
    tokensUsed += formattedCost;
  }

  return result;
}

/**
 * Formats a skill's hot-set entry: just name + description.
 * This is what gets injected into the system prompt.
 */
export function formatSkillForHotSet(skill: SkillRecord): string {
  return `- **${skill.name}**: ${skill.frontmatter.description}`;
}

/**
 * Renders the full hot-set block for the system prompt.
 * Returns an empty string if no skills are in the hot-set.
 */
export function renderHotSet(hotSet: SkillRecord[]): string {
  if (hotSet.length === 0) return "";

  const lines = ["## Available Skills", ""];
  for (const skill of hotSet) {
    lines.push(formatSkillForHotSet(skill));
  }
  lines.push("");
  lines.push(
    "Use `load_skill(name)` to load the full skill content, or `find_skill(query)` to discover skills.",
  );

  return lines.join("\n");
}

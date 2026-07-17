/* ─── Skill System Types ───
 *
 * agentskills.io-compatible skill format. Each skill lives in a flat
 * directory: $HARNESS_HOME/skills/<skill-name>/skill.md
 *
 * Frontmatter keys:
 * - name      (required) must match folder name, lowercase-hyphenated
 * - description (required) must contain "Use when:" and "Don't use when:"
 * - level     (required) "atom" | "molecule"
 * - requires  (optional) comma-separated skill names, max depth 1
 * - status    (optional, default "active") draft|active|stale|archive
 * - pinned    (optional, default false) include in Tier-0 hot-set
 * - routable  (optional, default true) discoverable via find_skill
 */

export type SkillLevel = "atom" | "molecule";
export type SkillStatus = "draft" | "active" | "stale" | "archive";

export interface SkillFrontmatter {
  name: string;
  description: string;
  level: SkillLevel;
  requires: string[];
  status: SkillStatus;
  pinned: boolean;
  routable: boolean;
}

export interface SkillRecord {
  name: string;
  frontmatter: SkillFrontmatter;
  /** Full text of skill.md body (after frontmatter). */
  body: string;
  /** Absolute path to skill.md. */
  filePath: string;
  /** Directory containing skill.md. */
  dir: string;
  /** Whether this is a built-in skill (shipped with the repo). */
  builtin: boolean;
  /** Estimated token count of the full skill.md content. */
  tokenEstimate: number;
  /** Subdirectories present in the skill folder. */
  hasScripts: boolean;
  hasReferences: boolean;
  hasEvals: boolean;
}

export interface SkillError {
  skillName: string;
  filePath: string;
  message: string;
}

export interface SkillLoadResult {
  skills: SkillRecord[];
  errors: SkillError[];
  warnings: string[];
}

export interface SkillTelemetryEntry {
  uses: number;
  last_used: string | null;
  patches: number;
  pinned: boolean;
}

export type SkillTelemetry = Record<string, SkillTelemetryEntry>;

export interface HotSetOptions {
  /** Approx token budget for the hot-set (default: 2000). */
  budgetTokens?: number;
  /** Max number of skills in the hot-set ( safety cap). */
  maxSkills?: number;
}

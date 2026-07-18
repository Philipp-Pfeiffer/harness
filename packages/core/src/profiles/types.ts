/* ─── Agent Profile Types ───
 *
 * Each agent profile lives in a flat directory:
 * $HARNESS_HOME/agents/<profile-name>/agent.md
 * Built-in profiles ship with the agent package under agents/<name>/agent.md;
 * user profiles override built-ins with the same name (like skills).
 *
 * Frontmatter keys:
 * - name        (required) must match folder name, lowercase-hyphenated
 * - model       (optional) "provider/model-id" — overrides the daemon default model
 * - thinking    (optional) true|false — overrides the model's inlineThinking flag
 * - tools       (optional) comma-separated tool allowlist — absent = full tool set,
 *               present-but-empty = no tools
 * - memory      (optional) comma-separated memory zones (core|notes) —
 *               absent = all zones, present-but-empty = no memory access
 * - skills      (optional, default true) true|false — include the skill hot-set
 * - temperature (optional) sampling parameter
 * - maxTokens   (optional) sampling parameter
 *
 * Body = persona prompt, appended after the bare base prompt.
 */

/** Memory zones a profile can grant access to. */
export type MemoryZone = "core" | "notes";

/** All memory zones — the default when a profile does not restrict `memory`. */
export const ALL_MEMORY_ZONES: MemoryZone[] = ["core", "notes"];

export interface AgentProfileModelRef {
  provider: string;
  model: string;
}

export interface AgentProfileFrontmatter {
  name: string;
  /** Model override. Absent = inherit the daemon's default model. */
  model?: AgentProfileModelRef;
  /** Inline-thinking override. Absent = inherit from the model config. */
  thinking?: boolean;
  /** Tool allowlist. Absent = full tool set; empty array = no tools. */
  tools?: string[];
  /** Memory zones. Absent = all zones; empty array = no memory access. */
  memory?: MemoryZone[];
  /** Whether the skill hot-set block is included in the system prompt. */
  skills: boolean;
  /** Sampling parameter passed through to the provider. */
  temperature?: number;
  /** Sampling parameter passed through to the provider. */
  maxTokens?: number;
}

export interface AgentProfile {
  name: string;
  frontmatter: AgentProfileFrontmatter;
  /** Persona prompt (agent.md body, after frontmatter). */
  body: string;
  /** Absolute path to agent.md. */
  filePath: string;
  /** Directory containing agent.md. */
  dir: string;
  /** Whether this is a built-in profile (shipped with the repo). */
  builtin: boolean;
}

export interface AgentProfileError {
  profileName: string;
  filePath: string;
  message: string;
}

export interface AgentProfileLoadResult {
  profiles: AgentProfile[];
  errors: AgentProfileError[];
}

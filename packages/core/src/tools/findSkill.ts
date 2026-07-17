import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.js";
import type { SkillRecord } from "../skills/types.js";
import { computeRoutableSkills } from "../skills/loader.js";

/* ─── find_skill Tool ───
 *
 * Searches for skills using the query. Returns ranked results.
 *
 * Search strategy:
 * - QMD searchLex (BM25) + searchVector (semantic) + RRF over skill.md files
 *   when a QMDStore is available (the "skills" collection)
 * - Fallback: simple keyword matching over name + description
 *
 * Routability:
 * - Only routable skills appear in results
 * - Atoms with incoming requires are not routable (only via parent)
 */

const FindSkillArgs = Type.Object({
  query: Type.String({
    minLength: 1,
    description:
      "Natural-language search query. Returns ranked skills by name + description relevance.",
  }),
});

const DEFAULT_K = 5;
const RRF_K = 60;

interface SearchResultLike {
  filepath: string;
  title: string;
  body?: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion: merges multiple ranked lists into one.
 * Formula: score(d) = Σ weight_i / (k + rank_i + 1)
 */
function reciprocalRankFusion<T extends { filepath: string }>(
  resultLists: T[][],
  weights: number[] = [],
  k = RRF_K,
): Map<string, { result: T; rrfScore: number }> {
  const merged = new Map<string, { result: T; rrfScore: number }>();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;

    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      if (!result) continue;
      const rrfContribution = weight / (k + rank + 1);
      const existing = merged.get(result.filepath);
      if (existing) {
        existing.rrfScore += rrfContribution;
      } else {
        merged.set(result.filepath, { result, rrfScore: rrfContribution });
      }
    }
  }

  // Sort by RRF score descending
  const sorted = Array.from(merged.entries()).sort(
    (a, b) => b[1].rrfScore - a[1].rrfScore,
  );

  const result = new Map<string, { result: T; rrfScore: number }>();
  for (const [key, value] of sorted) {
    result.set(key, value);
  }
  return result;
}

/**
 * Fallback keyword search: scores skills by term overlap in name + description.
 */
function keywordSearch(
  query: string,
  skills: SkillRecord[],
  routableSet: Set<string>,
  k: number,
): { skill: SkillRecord; score: number }[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const results: { skill: SkillRecord; score: number }[] = [];

  for (const skill of skills) {
    if (!routableSet.has(skill.name)) continue;

    const nameLower = skill.name.toLowerCase();
    const descLower = skill.frontmatter.description.toLowerCase();

    let score = 0;
    for (const term of terms) {
      // Name matches are weighted higher
      if (nameLower.includes(term)) score += 3;
      if (descLower.includes(term)) score += 1;
    }

    if (score > 0) {
      results.push({ skill, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, k);
}

export interface FindSkillToolOptions {
  /** Optional QMDStore for lex+vector search. */
  store?: {
    searchLex(
      query: string,
      opts?: { limit?: number; collection?: string },
    ): Promise<SearchResultLike[]>;
    searchVector(
      query: string,
      opts?: { limit?: number; collection?: string },
    ): Promise<SearchResultLike[]>;
  };
}

export function createFindSkillTool(
  skills: SkillRecord[],
  opts?: FindSkillToolOptions,
): Tool<typeof FindSkillArgs> {
  const routableSet = computeRoutableSkills(skills);

  return {
    name: "find_skill",
    description:
      "Discover skills by natural-language query. Searches skill names and descriptions. Returns ranked results with name, description, and level. Use load_skill(name) to load the full skill content.",
    parameters: FindSkillArgs,
    async execute(args) {
      const query = args.query.trim();
      if (!query) {
        return "--- skill search: 0 results ---\nQuery was empty after trimming.";
      }

      const results = await searchSkills(query, skills, routableSet, opts?.store, DEFAULT_K);

      if (results.length === 0) {
        return `--- skill search: 0 results ---\nNo skills found for "${query}".`;
      }

      const lines = [`--- skill search: ${results.length} result${results.length === 1 ? "" : "s"} ---`];
      for (let i = 0; i < results.length; i++) {
        const { skill, score } = results[i]!;
        const reqs = skill.frontmatter.requires.length > 0
          ? ` (requires: ${skill.frontmatter.requires.join(", ")})`
          : "";
        lines.push(
          `[${i + 1}] ${skill.name} [${skill.frontmatter.level}]${reqs}`,
          `    ${skill.frontmatter.description}`,
          `    score: ${score.toFixed(4)}`,
        );
      }
      lines.push(`\nUse load_skill(name) to load the full skill.`);
      return lines.join("\n");
    },
  };
}

async function searchSkills(
  query: string,
  skills: SkillRecord[],
  routableSet: Set<string>,
  store: FindSkillToolOptions["store"],
  k: number,
): Promise<{ skill: SkillRecord; score: number }[]> {
  // Build a filepath → skill name map for QMD result mapping
  const pathToName = new Map<string, string>();
  for (const skill of skills) {
    pathToName.set(skill.filePath, skill.name);
  }

  if (store) {
    try {
      const [lexResults, vecResults] = await Promise.all([
        store.searchLex(query, { limit: k * 3, collection: "skills" }),
        store.searchVector(query, { limit: k * 3, collection: "skills" }),
      ]);

      const fused = reciprocalRankFusion([lexResults, vecResults]);

      // Map QMD filepaths back to skill records
      const mappedResults: { skill: SkillRecord; score: number }[] = [];
      for (const [filepath, { rrfScore }] of fused) {
        const skillName = pathToName.get(filepath);
        if (!skillName) continue;
        const skill = skills.find((s) => s.name === skillName);
        if (!skill) continue;
        if (!routableSet.has(skill.name)) continue;
        mappedResults.push({ skill, score: rrfScore });
      }

      if (mappedResults.length > 0) {
        return mappedResults.slice(0, k);
      }
    } catch {
      // Fall through to keyword search
    }
  }

  // Fallback: keyword search
  const keywordResults = keywordSearch(query, skills, routableSet, k);
  return keywordResults;
}

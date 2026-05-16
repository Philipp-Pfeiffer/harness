# Phase-1 Integration Merge Report

**Date:** 2026-05-16
**Integration Agent:** Kimi Code CLI
**Baseline HEAD:** `0b887363a14f9bc5893abd114ecad4b7b2789e27`
**Final HEAD:** `a55d8c9`

---

## Merge Commits

1. `36fcba1` — **merge: phase-1/runtime-steering (mailbox steering)**
   - Clean merge, no conflicts.
   - Adds mailbox-based runtime steering, steer rendering in active turn, and abort+mailbox discard logic.

2. `7033b4e` — **merge: phase-1/cli-statusbar (persistent input + bottom status bar)**
   - Clean merge, no conflicts.
   - Adds persistent input with `isRunning` block, bottom status bar, and `Static` rendering for completed turns.

3. `5ab4584` — **merge: phase-1/cli-followups-a (slash picker, token counter, /model)**
   - **Conflicts in 3 files** (see below for resolution).
   - Adds slash-command autocomplete picker, token counter in status bar, `/model` runtime switching, and `usage` aggregation.

4. `a55d8c9` — **fix(tests): add usage field to mailbox steering expectations**
   - Post-merge test fix: two mailbox-steering tests expected the old `RunResult` shape without `usage`.

---

## Conflicts & Resolution

### `src/core/agent.ts`
- **Cause:** C added mailbox poll/discards; A added token-usage aggregation and changed all return shapes to include `usage`.
- **Resolution:** Kept C's mailbox logic (`drainMailbox`, `discardMailbox`) and inserted A's token aggregation. Every `return` statement now includes `usage: { inputTokens, outputTokens, totalTokens }`.

### `src/cli/App.tsx`
- **Cause:** B replaced the top `Header` with a bottom `StatusBar` and introduced `Static` + persistent-input layout; A added `Header` with token counter, slash-picker, model picker, and `/model` handling.
- **Resolution:**
  - **Layout:** B's three-zone layout wins (Static / live content + active turn / persistent input + status bar).
  - **StatusBar:** B's component name kept, but enriched with A's token-counter props (`usage`, `contextWindow`) and `formatTokens` logic.
  - **PromptInput:** Combined B's `isRunning` prop with A's `commands` prop; slash picker renders above input lines.
  - **Model picker:** Rendered inside the content area (between active turn and input), not at the top.
  - **Steer rendering:** C's steer block preserved inside `ActiveTurnView`.

### `tests/cli/App.test.tsx`
- **Cause:** B added "Persistent input and status bar" tests; A added "Token counter" and "/model command" tests, and changed `getModel` mock + all `mockRun` returns to include `usage`.
- **Resolution:** Took A's test file as base (it already had the `usage` fields and `getModel` mock needed for the combined code) and appended B's "Persistent input and status bar" describe block. Adjusted B's status-bar assertion to expect `minimax-MiniMax-M2.7` instead of the old `test-model`.

---

## Test Counts

| Stage | Tests | Status |
|-------|-------|--------|
| Baseline (main) | 158 passed | ✅ |
| Post-C (runtime-steering) | 166 passed | ✅ |
| Post-B (cli-statusbar) | 171 passed | ✅ |
| Post-A (cli-followups-a) | 186 passed | ✅ |
| Final | 186 passed | ✅ |

**New tests introduced:**
- `tests/core/mailbox.test.ts`: 5 tests (from C)
- `tests/agent.test.ts`: +3 tests for mailbox steering (from C)
- `tests/cli/App.test.tsx`: +5 tests for persistent input / status bar (from B)
- `tests/cli/App.test.tsx`: +4 tests for token counter, +3 tests for `/model` (from A)
- `tests/cli/commands.test.tsx`: 6 tests (from A)

Total delta: **+28 tests** (158 → 186).

---

## Implementation Reports (Feature Branches)

| Branch | Report Path | Status |
|--------|-------------|--------|
| `phase-1/runtime-steering` | `docs/changes/phase-1-runtime-steering.md` | ✅ Read, no blockers |
| `phase-1/cli-statusbar` | *(none found in branch)* | N/A |
| `phase-1/cli-followups-a` | *(none found in branch)* | N/A |

---

## Live Smoke Notes

- `npm run build` succeeds (TypeScript strict, zero errors).
- `node dist/index.js` renders the layout correctly: `harness · MiniMax-M2.7 · ready · <cwd>`.
- **Known non-fatal warning:** React key-duplication warning in non-interactive terminal (pre-existing, unrelated to merge).
- **Expected error:** `Raw mode is not supported` because smoke runs outside a TTY.

---

## Remaining Caveats / Follow-ups for P.

1. **React key warning:** `Encountered two children with the same key` appears in smoke test. Likely pre-existing; root cause should be investigated separately.
2. **No implementation reports for B and A:** Branches `cli-statusbar` and `cli-followups-a` did not contain `docs/changes/` files. If this was unintended, they may need to be written retroactively.
3. **Worktree cleanup:** Phase-1 worktrees were already removed before merge to allow direct branch checkout. If local branch cleanup is desired:
   ```bash
   git branch -d phase-1/runtime-steering
   git branch -d phase-1/cli-statusbar
   git branch -d phase-1/cli-followups-a
   ```
4. **Origin branches:** Left untouched on origin as requested.
5. **Notion tracker:** ADR / tracker status updates for phase-1 completion are out of scope for this agent.

# Parity Refresh — Slice Audit B: gates cluster

**Auditor**: parity-refresh adversarial diff (gates cluster)
**Date**: 2026-05-19
**Scope**: slices S2 (mutation gate — fail-CLOSED), S10 (exec allowlist / dangerous-flag blocking), S12 (shell-escape layered defense + accept-edits trigger predicate). The security-critical gates.
**In-host source-of-truth**: branch `rebase/pr70071-onto-main-2026-04-25` @ `ea04ea52c7` in `/Volumes/LEXAR/repos/openclaw-pr70071-rebase`.
**Post-surgical context**: PR #90 re-ported S12/S10 (accept-edits gate — trigger predicate fixed, shell-escape coverage backfilled). This refresh re-verifies the surgical port and revisits the three SHARED-bug claims from the Wave-1 S12 report.
**Method**: read-only adversarial diff. Executable-line diff of both gate files vs in-host; trigger-predicate trace through `index.ts` ↔ in-host `pi-tools.before-tool-call.ts` ↔ `sessions-patch.ts` ↔ `resolvePlanApproval`. No code executed; no commits made.

---

## Per-file verdict

| Plugin file | In-host counterpart | Verdict |
|---|---|---|
| `src/gates/mutation-gate.ts` | `src/agents/plan-mode/mutation-gate.ts` | **clean** — executable lines byte-identical; only sound adaptations (import path, `DANGEROUS_FLAGS` module-hoist, `_testing` export). `host_ref:` citations present + correct. |
| `src/gates/accept-edits-gate.ts` | `src/agents/plan-mode/accept-edits-gate.ts` | **clean** — executable lines **byte-identical** (diff EXIT=0). All 8 pattern lists + 6 C4 escape regexes + normalizer + extractor identical. `host_ref:` correct. |
| `tests/gates/mutation-gate.test.ts` | `src/agents/plan-mode/mutation-gate.test.ts` | **clean** — restructured table-driven; semantic SUPERSET of in-host. |
| `tests/gates/accept-edits-gate.test.ts` | `src/agents/plan-mode/accept-edits-gate.test.ts` | **clean** — first 629 lines 1-for-1 with in-host; PR #90 backfill (P0 #4–#10) complete. |
| `src/index.ts:371-479` (gate wiring) | `src/agents/pi-tools.before-tool-call.ts:296-378` | **drift** — see B1 (apply_patch extraction not tool-gated), B2 (filePath priority order), B3 (`params.cmd`/`params.target` over-extraction). All fail-safe for these gate postures. |

**Severity counts**: P0 = 0, P1 = 1 (B4 — trigger-predicate has zero integration test), P2 = 5 (B1, B2, B3, B5, B6).

**Headline**: No security boundary is weakened vs in-host. Both gate algorithms are byte-identical. PR #90's trigger-predicate fix is **correct parity** — and it retroactively resolves the Wave-1 S12 report's "P0 #2" finding, which was a **misdiagnosis** (see §"Wave-1 re-verification" below). The remaining findings are wiring-layer drift (all fail-safe) and one genuine integration-test gap.

---

## Detailed analysis

### mutation-gate.ts — CLEAN

Executable-line diff vs in-host shows exactly three differences, all sound adaptations:

1. **Import path** `../types.js` vs in-host `./types.js` — required seam adaptation (plugin keeps `PlanMode` in `src/types.ts`, not a `plan-mode/` subdir). Benign.
2. **`DANGEROUS_FLAGS` hoisted to module scope** (plugin `mutation-gate.ts:150-161`) vs in-host function-body local (`mutation-gate.ts:213-225`). **Same 10 entries, same order, same case**: `-delete`, `-exec`, `-execdir`, `--delete`, `-rf`, `--output`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`. The hoist enables the `_testing`-driven per-flag test loop — a net coverage improvement, no behavioral change.
3. **`_testing` export added** (`mutation-gate.ts:274-281`) — exposes the 6 lists as `Array.from()` copies for test introspection. In-host has no equivalent. Test-only; copies, not live refs.

All six data lists verified against in-host: `PLAN_MODE_ALLOWED_TOOLS` (17), `MUTATION_TOOL_BLOCKLIST` (11), `MUTATION_SUFFIX_PATTERNS` (3), `READONLY_SUFFIX_PATTERNS` (5), `READ_ONLY_EXEC_PREFIXES` (22), `DANGEROUS_FLAGS` (10) — **all byte-identical**. Shell-operator regex `/[;|&` backtick `\n\r]|\$\(|>>?|<\(|>\(/` identical. Control flow (8-step decision tree) identical. `host_ref:` citations present on every block and point to correct in-host line ranges. Fail-CLOSED default-deny intact.

### accept-edits-gate.ts — CLEAN

Executable-line diff vs in-host: **EXIT=0 — byte-identical**. The only file-level differences are the parity-contract preamble (lines 4–16) and the `>=95%` ASCII swap (in-host `≥95%`) — both pure documentation. Verified identical:

- `DESTRUCTIVE_EXEC_PREFIXES` (8: `rm`, `rmdir`, `unlink`, `shred`, `trash`, `truncate`, `diskutil erasedisk`, `diskutil eraseall`)
- `DESTRUCTIVE_SQL_PATTERNS` (7: `DROP TABLE/DATABASE/SCHEMA`, `DELETE FROM`, `TRUNCATE`, `FLUSHALL`, `FLUSHDB`)
- `DESTRUCTIVE_FIND_FLAGS` (3: `-delete`, `-exec <verb>`, `-execdir <verb>`)
- `DESTRUCTIVE_ESCAPE_PATTERNS` (6 C4 regexes: env-var indirection, backtick subshell, `$()` subshell, quote-concat, hex `\xNN`, octal `\NNN`)
- `SELF_RESTART_PATTERNS` (10), `CONFIG_CHANGE_PATTERNS` (4), `PROTECTED_CONFIG_PATH_PREFIXES` (5), `PATH_WRITER_TOOLS` (5)
- `normalizeCandidatePath`, `checkProtectedPath`, `extractApplyPatchTargetPaths`, `checkAcceptEditsConstraint` — identical.

Fail-OPEN posture intact. `host_ref:` correct.

### Trigger-predicate parity — VERIFIED CORRECT (PR #90)

The in-host fires the accept-edits gate at `pi-tools.before-tool-call.ts:333`:
`latestPlanMode === "normal" && getLatestAcceptEdits?.()`, where `getLatestAcceptEdits` reads `SessionEntry.postApprovalPermissions.acceptEdits === true` live from disk (`fresh-session-entry.ts:115`).

PR #90 changed the plugin predicate (`index.ts:451`) from `autoApprove === true || approval === "edited"` to **`approval === "edited"`**. Trace confirms this is correct parity:

- **In-host `sessions-patch.ts:982-993`** sets `postApprovalPermissions.acceptEdits = true` **only on `action === "edit"`**; `action === "approve"` *explicitly clears* it (verbatim execution — comment: *"`approve` explicitly does NOT grant acceptEdits"*).
- **Plugin `store.ts:511`** sets `approval: "edited"` exactly when `action === "edit"`. The plugin's `resolvePlanApproval` `edit` branch (`approval.ts:121-126`) sets `mode: "normal"` AND `approval: "edited"` together, so the gate-fire state `(mode==="normal", approval==="edited")` is reachable and survives the plan→normal transition.
- **`autoApprove`** in the plugin auto-resolves `exit_plan_mode` "straight to **approved**" (`store.ts:612-616`) → `approval: "approved"`, never `"edited"`. The old `autoApprove === true` disjunct therefore over-fired the gate for operators who pre-toggled auto-mode (a UX regression). In-host autoApprove likewise auto-resolves to `approve` (verbatim, no acceptEdits grant). PR #90's removal of the disjunct is **correct**.

The mode-mutual-exclusion also matches: in-host runs the mutation gate when `mode==="plan"` and the accept-edits gate `else if mode==="normal" && ...`; the plugin does `if (mode==="plan") {...; return}` then the accept-edits block — same mutual exclusion.

### Wave-1 re-verification — "P0 #2" was a MISDIAGNOSIS

The Wave-1 S12 report (`docs/audits/wave-1/S12-shell-escape-accept-edits.md` §4 P0 #2, §6.3) claimed plain "Accept" should fire the gate and the plugin's failure to do so was a P0 silent-bypass. **This is incorrect.** The in-host `sessions-patch.ts:982-993` source proves plain "Accept" (`action==="approve"`) does NOT set `postApprovalPermissions.acceptEdits` — it *clears* it. In-host plain-Accept does **not** fire the gate either. PR #90's `approval === "edited"` predicate is faithful in-host parity. The Wave-1 "P0 #2" / §6.3 "trigger predicate BROKEN" findings are **resolved / withdrawn**.

### Wave-1 SHARED bugs — confirmed STILL SHARED (not plugin regressions)

The Wave-1 S12 report documented three SHARED bugs. Because `accept-edits-gate.ts` is now verified byte-identical to in-host, all three are confirmed **still shared with in-host — not plugin-only regressions**, so out of scope for a parity finding:

- **Trailing-slash normalization bypass** (`~/.openclaw/` → `~/.openclaw`, slash stripped, `startsWith("~/.openclaw/")` false). `normalizeCandidatePath` is byte-identical → shared.
- **`bash -c "rm -rf"` quoted-body bypass** — `matchExecPrefix` is byte-identical → shared.
- **Command-chain bypass** (`ls && rm`) — prefix-anchored matching is byte-identical → shared.

These remain real attack surfaces but are correctly out of scope for the plugin parity audit (a fix belongs upstream in in-host first, then re-ports).

---

## Findings table

| ID | Severity | Type | Plugin loc | In-host loc | Description | Suggested fix |
|---|---|---|---|---|---|---|
| **B1** | P2 | parity-gap | `src/index.ts:464` | `pi-tools.before-tool-call.ts:354-357` | `extractApplyPatchTargetPaths(params.input)` is called **unconditionally** for any path-writer tool. In-host gates it on `toolName === "apply_patch"`. If a non-`apply_patch` tool's `params.input` happens to contain literal `*** Update File:` text, the plugin extracts phantom paths and could over-block. Fail-OPEN gate → worst case is a spurious block, not a bypass. | Gate the extractor call on `event.toolName === "apply_patch"` to match in-host exactly. |
| **B2** | P2 | parity-gap | `src/index.ts:455-462` | `pi-tools.before-tool-call.ts:341` | `filePath` priority order diverges: plugin `file_path ?? path ?? target`; in-host `path ?? filePath ?? file_path`. If a tool ever sends BOTH `path` and `file_path` with different values, the two pick different candidates. No known tool does this today, so currently cosmetic — but it is silent behavioral drift. | Reorder to `params.path ?? params.filePath ?? params.file_path` to match in-host; drop `target` or document the seam reason. |
| **B3** | P2 | parity-gap | `src/index.ts:402-407` | `pi-tools.before-tool-call.ts:312,335` | Command extraction uses `params.command \|\| params.cmd`; in-host uses `params.command` only. The `cmd` fallback is a plugin-only over-extraction. For both a fail-CLOSED (mutation) and fail-OPEN (accept-edits) gate, feeding *more* command text can only cause *more* blocking, never a bypass — fail-safe — but it is undocumented drift. | Either drop the `params.cmd` fallback for byte-parity, or add a `host_ref` note explaining the plugin-specific tool convention it covers. |
| **B4** | P1 | test-gap | `src/index.ts:451` (`isAcceptEditsPhase`); `tests/gates/` | — | The trigger predicate `approval === "edited"` has **zero unit/integration test**. `accept-edits-gate.test.ts:854-865` explicitly defers this to `smoke-4-accept-edits-adversarial`, an Eva live-smoke (not in CI). No CI-runnable test pins: (a) gate FIRES when `approval==="edited"` + `mode==="normal"`; (b) gate does NOT fire when `approval==="approved"` (the autoApprove path — the exact over-fire PR #90 fixed); (c) gate does NOT fire when `mode==="plan"`. A future refactor of the `index.ts` wiring (e.g. reinstating an `autoApprove` disjunct, or an `||`-vs-`&&` slip) passes the green suite silently. The 72-case gate-function suite validates the gate ALGORITHM, never the INVOCATION CONDITION. | Add a CI-runnable wiring test that invokes the `before_tool_call` handler with stubbed `getSessionExtension` / `store` snapshots across the 3 states above. This is the same gap flagged in Wave-1 §7 ("hook-wiring integration is the weak link") and is the single most valuable missing test for this cluster. |
| **B5** | P2 | parity-gap | `src/state/store.ts` (no plan-complete clear) | `plan-snapshot-persister.ts:714-716` | In-host clears `postApprovalPermissions` on plan-complete / close-on-complete. The plugin has no equivalent: `approval: "edited"` persists until the next `enterPlanMode` (`store.ts:347` → `"none"`) or `exitPlanMode` (`store.ts:417` → `"none"`). So the accept-edits gate stays armed for the whole post-approval phase + beyond, where in-host disarms it at plan-complete. This is a *narrowing-not-applied* — the plugin gate stays ON **longer**, i.e. strictly more blocking. Fail-safe for a security gate; not a weakening. Worth noting because it is observable parity drift (a destructive command long after the plan finished is blocked in the plugin, allowed in in-host). | Optional: wire a plan-complete hook (or reuse the existing completion-injection path) to reset `approval` to `"none"` for exact in-host parity. Low priority — current behavior is the safe direction. |
| **B6** | P2 | test-gap | `tests/gates/mutation-gate.test.ts` | `pi-tools.before-tool-call.ts:309-322` | The mutation-gate wiring (`index.ts:412-421` — mode resolution via `getSessionExtension` then `store.readSnapshot`, `command` extraction) has no integration test. `mutation-gate.test.ts` covers the gate function only. Same class as B4 but for the fail-CLOSED gate. Lower severity than B4 because the mutation gate's default-deny means a wiring bug that drops the command tends to fail-closed (block), whereas an accept-edits wiring bug fails-open (allow). | Fold a mutation-gate case into the B4 wiring test (inject `before_tool_call` with `mode: "plan"`, assert block-on-blocklisted-tool). |

---

## Confidence

P(a security regression vs in-host slips through this cluster) = **~0.05** (low).

- Both gate algorithms are byte-identical to in-host — verified by executable-line diff, not eyeball. There is no pattern drift, no dropped/weakened regex, no allowlist/blocklist divergence.
- PR #90's trigger-predicate fix is correct parity and is backed by the in-host `sessions-patch.ts` source — and it resolves the Wave-1 "P0 #2" misdiagnosis.
- PR #90's coverage backfill (P0 #4–#10) is complete: every coded accept-edits pattern now has a positive test.
- All wiring-layer divergences (B1–B3) are fail-SAFE for their respective gate postures (more text/more paths → more blocking, never a bypass).
- B5 (no plan-complete clear) is a narrowing-not-applied — the safe direction.

The residual risk is **B4** — a wiring refactor that re-breaks the trigger predicate (the precise thing PR #90 fixed) would pass the green CI suite, because the predicate has no CI-runnable test. That is a regression-detection gap, not a current bypass. Closing B4 takes this cluster's confidence to ~0.02.

---

## Appendix — files referenced (absolute paths)

- `/Users/lume/repos/Smarter-Claw/src/gates/mutation-gate.ts`
- `/Users/lume/repos/Smarter-Claw/src/gates/accept-edits-gate.ts`
- `/Users/lume/repos/Smarter-Claw/tests/gates/mutation-gate.test.ts`
- `/Users/lume/repos/Smarter-Claw/tests/gates/accept-edits-gate.test.ts`
- `/Users/lume/repos/Smarter-Claw/src/index.ts` (gate wiring: 371-479)
- `/Users/lume/repos/Smarter-Claw/src/state/store.ts` (`recordApproval`, `applyApprovalAction`, `enterPlanMode`, `exitPlanMode`, `setAutoApprove`)
- `/Users/lume/repos/Smarter-Claw/src/plan-mode/approval.ts` (`resolvePlanApproval`)
- `/Volumes/LEXAR/repos/openclaw-pr70071-rebase` @ `ea04ea52c7`:
  - `src/agents/plan-mode/mutation-gate.ts` + `.test.ts`
  - `src/agents/plan-mode/accept-edits-gate.ts` + `.test.ts`
  - `src/agents/pi-tools.before-tool-call.ts` (trigger predicate, 296-378)
  - `src/gateway/sessions-patch.ts:940-1010` (`postApprovalPermissions` set/clear)
  - `src/auto-reply/reply/fresh-session-entry.ts:88-120` (`resolveLatestAcceptEditsFromDisk`)
  - `src/gateway/plan-snapshot-persister.ts:705-720` (plan-complete `postApprovalPermissions` clear)

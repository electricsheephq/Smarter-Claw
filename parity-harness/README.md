# Parity Harness

Mechanical enforcement that this plugin's behavior matches the in-host
reference at `rebase/pr70071-onto-main-2026-04-25` tip `ea04ea52c7`.

## Layers

- **Layer 1 (Wave 2 — here)**: unit-level diff. ~155+ cases across 8
  checks pin the plugin's plan-mode surface against an in-host
  reference. Reference comes from EITHER (a) a vendored snapshot of
  in-host code committed alongside the harness, OR (b) a byte fixture
  captured from the in-host source via `git show`. Any unexplained
  diff fails the CI gate (`pnpm parity-harness`).

- **Layer 2 (future, P-5)**: scenario-level diff. YAML scenarios drive
  both a host gateway session AND a plugin-loaded session; trace
  diff'd.

- **Layer 3 (future, P-14)**: continuous-drift. Periodic CI job pulls
  latest in-host source; regenerates reference snapshots; alerts on
  diff.

## Layer 1 layout

```
parity-harness/
├── README.md                                   — this file
├── diff.ts                                     — multi-check driver (CLI + lib entry)
├── checks/
│   ├── types.ts                                — Check + CheckReport contract
│   ├── persist-approval-request.ts             — Wave-1 P-3.5
│   ├── resolve-plan-approval.ts                — Wave-2
│   ├── accept-edits-gate.ts                    — Wave-2
│   ├── escalating-retry.ts                     — Wave-2 (resolvers + constant byte-pins)
│   ├── sanitize-and-approval-id.ts             — Wave-2
│   ├── prompts.ts                              — Wave-2 (CLOSES W1-D3)
│   ├── mutation-gate.ts                        — Wave-2
│   └── runtime-reject-and-plan-steps.ts        — Wave-2 bonus (W1-D1 + W1-D2 byte-pins)
├── inputs/
│   ├── persistApprovalRequest.json
│   ├── resolvePlanApproval.json
│   ├── acceptEditsGate.json
│   ├── escalatingRetry.json
│   ├── sanitize.json
│   ├── mutationGate.json
│   └── runtimeRejectAndPlanSteps.json
├── runners/
│   ├── shared.ts                               — persist-approval shared types
│   ├── host-reference.ts                       — persist-approval host port
│   ├── plugin-under-test.ts                    — persist-approval plugin driver
│   ├── resolve-plan-approval.reference.ts      — verbatim port of in-host resolvePlanApproval
│   ├── accept-edits-gate.reference.ts          — VENDORED in-host file (git show)
│   ├── mutation-gate.reference.ts              — VENDORED in-host file (git show)
│   ├── escalating-retry.reference.ts           — constants + resolvers verbatim from in-host
│   ├── sanitize-and-approval-id.reference.ts   — verbatim port of in-host sanitize + shape regex
│   └── runtime-reject-and-plan-steps.reference.ts — verbatim port of in-host sessions-patch helpers
└── host-snapshots/
    ├── README.md                               — snapshot-file directory
    ├── capture.ts                              — tsx script: pulls bytes from in-host via `git show`
    ├── PLAN_ARCHETYPE_PROMPT.txt               — byte fixture
    ├── PLAN_MODE_REFERENCE_CARD.txt            — byte fixture
    ├── plan-mode-active-system-context.txt     — byte fixture (attempt.ts:692-732 inline)
    └── plan-mode-available-system-context.txt  — byte fixture (attempt.ts:735-748 inline)
```

## Run

```bash
pnpm parity-harness
```

Returns non-zero on diff. Wired into `pnpm test` via vitest config so
the CI gate fails when parity breaks. The standalone script
(`parity-harness/diff.ts`) is for humans debugging locally:

```bash
npx tsx parity-harness/diff.ts
# → [parity-harness] ✓ 156/156 cases parity-clean across 8 checks
```

## CI gate

`.github/workflows/ci.yml` adds a dedicated `Layer-1 parity harness`
step AFTER the unit-test step. The step is unpiped (no `tee`, no
chained commands) so a non-zero exit from `pnpm parity-harness`
propagates straight to the step's exit code. Wave 0 found that a
prior pipe-through-tee masked test failures with tee's always-zero
exit — that masking is structurally avoided here.

## Adding a case

For an existing check:

1. Append a new entry to the corresponding `inputs/*.json`.
2. Re-run `pnpm parity-harness`. The new case must show as parity-clean.

## Adding a new check

1. Build `parity-harness/checks/<name>.ts` exporting a `ParityCheck`
   per `checks/types.ts`. Mirror the structure of an existing check
   (e.g. `accept-edits-gate.ts`).
2. Vendor or port the in-host reference into `runners/<name>.reference.ts`.
   Prefer `git -C /Volumes/LEXAR/repos/openclaw-pr70071-rebase show
   ea04ea52c7:<path>` for files that are pure functions; for files with
   side effects, hand-port the relevant subset.
3. Add the check to `ALL_CHECKS` in `diff.ts`.
4. Add a per-check `describe()/it()` block in
   `tests/parity/parity-harness.test.ts`.
5. Re-run `pnpm parity-harness` and `pnpm typecheck`. Both must be clean.

## Re-capturing byte fixtures

When the in-host source changes (rare per Wave-0 Decision A — we
pinned at `ea04ea52c7`):

```bash
npx tsx parity-harness/host-snapshots/capture.ts
```

Then `git diff parity-harness/host-snapshots/`. Verify the diff is
intentional and reflects an in-host change you've already agreed to
absorb. Commit the new snapshots alongside the plugin-side update
that matches them.

## When this fails

- **Plugin diverged from in-host**: fix `src/` to match the reference.
  The reference IS the contract.
- **Reference diverged from in-host source-of-truth** (rare): re-capture
  via `host-snapshots/capture.ts` and update the relevant `runners/*.reference.ts`
  files. Cite the in-host line range in your commit message.
- **Input is malformed**: validate it parses; fix the JSON.

## Anti-pattern guardrail

The reference impl + snapshots are updated by **reading the in-host
source** at the cited `host_ref:` line range, NOT by inspecting the
plugin code and back-filling. Reverse-engineering the reference from
the plugin defeats the parity check.

## Vendored snapshot files

`runners/accept-edits-gate.reference.ts` and `runners/mutation-gate.reference.ts`
are direct `git show` extractions from the in-host source. They carry
a "DO NOT EDIT BY HAND" header and re-capture instructions. The single
allowed local edit is the import path (`./types.js` → `../../src/types.js`)
because the plugin's `PlanMode`/`PlanModeSessionState` types live at
the top-level `src/types.ts` rather than in a plan-mode subdirectory.

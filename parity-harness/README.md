# Parity Harness

Mechanical enforcement that this plugin's behavior matches the in-host
reference at `rebase/pr70071-onto-main-2026-04-25` tip `ea04ea52c7`.

## Layers

- **Layer 1 (P-3.5, here)**: unit-level diff. Shared `inputs.json`
  table; both the plugin's `PlanModeStore.persistApprovalRequest` AND a
  faithful TypeScript reference impl of the in-host
  `persistPlanApprovalRequest` are run against each input. Outputs are
  snapshotted as `{ stateAfter, approvalId, reused, audit }`. Any
  unexplained diff fails the build.

- **Layer 2 (P-5)**: scenario-level diff. YAML scenarios drive both a
  host gateway session AND a plugin-loaded session; trace diff'd.

- **Layer 3 (P-14)**: continuous-drift. Periodic CI job pulls latest
  in-host source; regenerates reference snapshots; alerts on diff.

## Layer 1 layout

```
parity-harness/
├── README.md                                — this file
├── inputs/
│   └── persistApprovalRequest.json          — shared input table
├── runners/
│   ├── host-reference.ts                    — faithful in-host logic port
│   ├── plugin-under-test.ts                 — exercises PlanModeStore
│   └── shared.ts                            — common output snapshot shape
├── snapshots/                               — generated; .gitignored
│   ├── host-reference.json
│   └── plugin-under-test.json
└── diff.ts                                  — runs both, diffs, fails on drift
```

## Run

```bash
pnpm parity-harness
```

Returns non-zero on diff. Wired into `pnpm test` via vitest config so
the CI gate fails when parity breaks.

## Adding a case

1. Append a `{id, description, input, state_before}` entry to
   `inputs/persistApprovalRequest.json`. `id` must be unique.
2. Re-run `pnpm parity-harness`. Both runners produce a snapshot for
   the new case. Diff passes.
3. Commit the input change. Snapshots regenerate per-run; not checked
   in.

## When this fails

- **Plugin diverged from in-host**: fix the plugin to match the
  reference. The reference IS the contract.
- **Reference diverged from in-host source**: update the reference,
  citing the new `host_ref:` lines. Commit both.
- **Input is malformed**: validate it parses; fix the JSON.

## Anti-pattern guardrail

The reference impl is updated by **reading the in-host source** at the
cited `host_ref:` line range, NOT by inspecting the plugin code and
back-filling. Reverse-engineering the reference from the plugin defeats
the parity check.

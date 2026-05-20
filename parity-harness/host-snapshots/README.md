# Host snapshots

Byte fixtures captured from the in-host source-of-truth at
`/Volumes/LEXAR/repos/openclaw-pr70071-rebase`, commit `ea04ea52c7`,
branch `rebase/pr70071-onto-main-2026-04-25`.

These files are committed to the repo. The Layer-1 parity harness
reads them and diffs against the plugin's runtime output. Any byte
divergence FAILS the build.

## Files

| File | In-host source |
|------|----------------|
| `PLAN_ARCHETYPE_PROMPT.txt` | `src/agents/plan-mode/plan-archetype-prompt.ts` — the full template literal value of `PLAN_ARCHETYPE_PROMPT` |
| `PLAN_MODE_REFERENCE_CARD.txt` | `src/agents/plan-mode/reference-card.ts` — the joined `[...].join("\n")` value of `PLAN_MODE_REFERENCE_CARD` |
| `plan-mode-active-system-context.txt` | `src/agents/pi-embedded-runner/run/attempt.ts:692-732` — the inline array joined with `\n`, with `PLAN_ARCHETYPE_PROMPT` and `PLAN_MODE_REFERENCE_CARD` substituted from the same in-host sources |
| `plan-mode-available-system-context.txt` | `src/agents/pi-embedded-runner/run/attempt.ts:735-748` — the inline array joined with `\n` |

## Closes W1-D3

Wave-1 finding W1-D3 flagged "no byte-fixture test pins the prompt
artifacts against in-host bytes; docstrings reference a
`tests/parity/archetype-prompt-parity.test.ts` that does not exist."
This directory + the corresponding `parity-harness/checks/prompts.ts`
check closes that gap.

## Re-capture procedure

When the in-host source-of-truth changes (Wave-0 Decision A pins us
at `ea04ea52c7` so this should be rare), regenerate via:

```bash
pnpm tsx parity-harness/host-snapshots/capture.ts
```

This script reads the in-host files via `git show` and writes the
four `.txt` snapshots. Verify the diff before committing.

<!-- Smarter-Claw PR template. Fill in honestly; the checklist is for you, not me. -->

## What this PR does

<!-- One sentence describing the change. -->

## Why

<!-- Link the issue, or explain why the change matters. -->

Closes #

## Risk

- [ ] Pure refactor (no behavior change)
- [ ] Bug fix (existing tests now pass that didn't before)
- [ ] New feature (new behavior; new tests added)
- [ ] Installer patch (modifies host source — needs `installer-roundtrip` green)
- [ ] Schema change (touches `openclaw.plugin.json` or `SmarterClawSessionState`)
- [ ] Release-process change (touches CI / branch protection / `RELEASING.md`)

## Validation

<!-- Pick what applies. Both checks must be green for merge. -->

- [ ] `pnpm build` clean
- [ ] `pnpm test --run` green (state count change: was N → now M)
- [ ] Installer dry-run still applies cleanly
- [ ] Smoke-tested locally against `/Users/lume/repos/sc-smoke-host` (or equivalent worktree)
- [ ] Tested against Eva's gateway (only for Phase D-and-after PRs)

## Docs

- [ ] README updated (if user-facing)
- [ ] `RELEASING.md` updated (if release-process change)
- [ ] No new config knobs added without honoring or documenting them

## Backward compatibility

<!-- If this changes a public surface (manifest schema, exported types,
     installer patch shape), describe the impact + migration path. -->

## Notes for reviewer

<!-- Anything you'd flag verbally if doing this synchronously. -->

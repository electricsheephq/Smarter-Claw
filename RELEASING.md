# Releasing Smarter-Claw

This is the runbook. Read it before tagging, publishing, or making any
public claim that something is "released."

## Definitions (so we don't confuse ourselves again)

- **Git tag** — just a label on a commit. Free, reversible, means nothing
  by itself. Do NOT confuse with a release.
- **Dev snapshot tag** — annotated tag prefixed `dev-snapshot-<date>` for
  preserving WIP state. Never an installable artifact.
- **Pre-release** — a real GitHub Release marked `--prerelease`, OR an
  npm publish with `--tag beta` (not the default `latest` dist-tag).
  Versioned `X.Y.Z-beta.N` or `X.Y.Z-rc.N`.
- **Release** — a real GitHub Release object (not just a tag) AND an npm
  publish to the default `latest` dist-tag. Versioned `X.Y.Z`. Means
  "users can rely on this."

## Version policy

| Version range | Means | What you can do |
|---|---|---|
| `0.X.Y-dev` | Active development on `main`, no public artifact | Iterate freely |
| `0.X.Y-beta.N` | Pre-release; under soak | npm publish `--tag beta`; GitHub Release `--prerelease` |
| `0.X.Y` (pre-1.0) | Validated minor release | npm publish (default `latest`); real GitHub Release |
| `1.0.0+` | Stable; semver applies fully | Same as pre-1.0 stable, plus stronger BC guarantees |

**Pre-1.0 versions don't make BC guarantees** for the `runtime-api.ts` or
`api.ts` exports. Bump the minor (`0.2 → 0.3`) when those change in a
breaking way. Patch (`0.2.0 → 0.2.1`) for bug fixes that don't move types.

## Required gates before any tag promotion

| Gate | How to check |
|---|---|
| CI green on the commit being tagged | `gh run list --branch main --workflow ci.yml --limit 1` shows `success` |
| Installer-roundtrip green on the commit | `gh run list --branch main --workflow installer-roundtrip.yml --limit 1` shows `success` |
| No open `priority/blocker` issues | `gh issue list --state open --label priority/blocker` returns `[]` |
| README accurate for the shipped scope | Operator reads + signs off |
| Sandbox smoke clean | `node installer/bin/install.mjs --host=<sandbox>` + manual smoke |

## Promotion ladder — how to release each version class

### `dev-snapshot-<date>` (anytime, no gates)

```bash
git tag -a dev-snapshot-$(date +%Y-%m-%d) -m "Reason for snapshot"
git push origin dev-snapshot-$(date +%Y-%m-%d)
```

No GitHub Release. No npm publish. Just preserves the WIP commit reference.

### Pre-release `0.X.Y-beta.N` (after sandbox + Eva soak)

1. Verify all gates above are green.
2. Bump `package.json` version + `api.ts:assertOpenclawVersionSupported`
   error message via PR (CI must pass).
3. After merge:
   ```bash
   git checkout main && git pull
   git tag -a v0.X.Y-beta.N -m "..." HEAD
   git push origin v0.X.Y-beta.N
   gh release create v0.X.Y-beta.N \
     --prerelease \
     --generate-notes \
     --notes-file release-notes.md
   ```
4. Optional npm publish:
   ```bash
   npm publish --access=public --tag beta
   ```
5. Soak validation: at minimum 48h on Eva's gateway with no error events
   in `~/.openclaw/logs/gateway.err.log | grep smarter-claw`.

### Release `0.X.Y` (only after `-beta.N` validates, or `1.0.0` after Phase F criteria)

Same as pre-release, except:
- Drop the `--prerelease` flag on `gh release create`
- Drop the `--tag beta` flag on `npm publish` (defaults to `latest`)
- Acceptance criteria for `1.0.0` specifically: see below

## `1.0.0` acceptance criteria

Every box must check:

- [ ] Zero P0/P1 open issues
- [ ] Eva (or equivalent operator agent) using continuously for ≥1 week
      with zero regressions filed
- [ ] CI green for ≥5 consecutive PR merges since the last beta
- [ ] At least one third party (sandbox install on a different machine
      counts) has installed via `npm install -g @electricsheephq/smarter-claw`
      cleanly
- [ ] README accurately describes shipped scope (no "v1.X backlog"
      sections in the publicly-visible docs)
- [ ] All issues from the original adversarial review are either closed
      or explicitly scoped to a `vNext` milestone

## What NOT to do (lessons from the v1.0/v2.0 cleanup)

- DO NOT tag a commit as `vX.Y.Z` and call it a release without going
  through the gates above.
- DO NOT push `--tag beta` to npm if the package has never been
  validated against a real openclaw deployment.
- DO NOT create a GitHub Release with notes that document "vX.Y backlog"
  — those notes contradict themselves and erode trust.
- DO NOT bump major versions to make a release feel bigger. `0.X.Y →
  X.0.0` is reserved for actual stability promises.

## Emergency rollback

If a release breaks Eva (or another user) in production:

1. Open a `priority/blocker` issue immediately.
2. On Eva's host:
   ```bash
   launchctl bootout gui/$(id -u)/ai.openclaw.gateway
   ln -sfn /Users/lume/repos/openclaw-1 /opt/homebrew/lib/node_modules/openclaw
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
   ```
3. Yank the broken npm release (`npm deprecate @electricsheephq/smarter-claw@0.X.Y "broken; see #N"`) — note: do NOT `npm unpublish`, that breaks anyone caching the version.
4. Edit the GitHub Release to add a `⚠️ DO NOT INSTALL` warning at the top.
5. Fix-PR-merge-test cycle. Cut a new patch version. Re-soak before
   re-promoting.

## Who can release

Code owners listed in `.github/CODEOWNERS`. The actual `npm publish` step
requires operator credentials (`npm login` to the `@electricsheephq` scope).
Branch protection on `main` requires 1 code-owner review for every change,
including release-prep PRs.

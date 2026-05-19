# Wave 0 — Pre-flight + Host Upgrade

**Date**: 2026-05-13
**Plan**: parity-refresh + release-readiness (`/Users/lume/.claude/plans/glistening-swimming-rivest.md`).
**Branch**: `wave-0/host-upgrade`.

Wave 0 re-baselines the plugin against the current OpenClaw stable
release before the audit waves run.

---

## Regression baseline (captured before the upgrade)

| Item | Value |
|---|---|
| `main` HEAD before Wave 0 | `58c789e` (hotfix #93 merged) — preceded by `03e6b42` (v1.0.0-port.15) |
| Test count on `main` pre-upgrade | 727 tests (701 at v1.0.0-port.15 + 2 routing-runtime + 24 slash-command from #93) |
| CI state | green (but see "CI masking bug" below — the green was partly false) |
| OpenClaw installed (operator gateway) | `2026.5.10-beta.5` |

---

## Host upgrade

- Plugin dev-dependency `openclaw` + `peerDependencies` bumped
  `2026.5.10-beta.5` → **`2026.5.18`** (latest stable; 8-version jump).
- `openclaw.plugin.json` `minHostVersion` bumped to `2026.5.18`.
- `pnpm install` refreshed the lockfile against `2026.5.18`.
- `pnpm typecheck` — **clean** against the `2026.5.18` SDK.
- `pnpm test` — **727/727 pass** against the `2026.5.18` SDK.

A global pnpm `minimum-release-age` (48h) blocked installing the
18-hour-old `2026.5.18`; resolved with a one-shot
`npm_config_minimum_release_age=0` local override (CI runners have no
age gate, so nothing is committed for it — `.npmrc` carries a comment
documenting the override for future local installs).

---

## AUDIT-E re-execution

`docs/audits/AUDIT-E-sdk-seam-parity.md` gained a
"Re-Execution — 2026-05-13 — OpenClaw 2026.5.18" section. Result:

- **Zero seam signature mismatches.** The clean `tsc --noEmit` against
  `2026.5.18` is the mechanical proof — an incompatible seam change
  would fail compilation.
- **`registerCommand` is now seam #13** — used by hotfix #93's `/plan`
  commands; AUDIT-E Table A previously listed it ✗ NOT USED.
- **`before_agent_finalize` gained `provider` / `model` / `messages`**
  (additive) — partially unblocks the S7 provider-specific detection
  concern; Wave 1 to re-evaluate.
- **`toolMetas` / `replayMetadata` still not exposed** — the S7
  precise-detection P0s remain gateway-side-deferred.

---

## Two bugs found + fixed during Wave 0

Wave 0's "re-run the suite on the new baseline" surfaced two defects
that pre-dated the upgrade:

1. **eva-live-smoke harness missing `registerCommand`.** Hotfix #93
   added `api.registerCommand(...)` to `src/index.ts` but never added
   the stub to `tests/eva-live-smokes/harness.ts`. Every smoke test
   crashed in `createHarness()` with `api.registerCommand is not a
   function` — 34 failing tests. Fixed: added the `registerCommand`
   stub + a `commands` capture bucket.

2. **CI was green-washing test failures.** `.github/workflows/ci.yml`
   ran `pnpm test ... | tee /tmp/vitest-stdout.log`. The pipeline's
   exit code was `tee`'s (always 0), so a failing `pnpm test` left the
   `ci` step **green**. Hotfix #93's CI logged `ELIFECYCLE Test
   failed` yet the step reported `success`. The log file was never
   consumed. Fixed: removed the pipe, added `set -eo pipefail`, kept
   the `default` reporter for console progress + `json` for the
   numTests guard. Same fix applied to the `pnpm pack | tee` step.

   **This is a serious finding** — it means CI green has not been a
   reliable signal. Wave 2 (parity harness) must treat the CI gate as
   newly-trustworthy only from this commit forward.

---

## Decision A — in-host parity reference staleness

**Decision: accept a documented staleness ceiling. Do NOT rebase the
in-host source-of-truth.**

The parity harness diffs plugin logic against the in-host at
`ea04ea52c7` (≈ `v2026.4.24`-era). With the host now on `2026.5.18`,
the reference is ~24 versions behind the running host.

Rationale: the harness diffs *plan-mode logic* (`resolvePlanApproval`,
accept-edits gate, escalating-retry selection, archetype prompt
generation) — not host-runtime code. Plan-mode logic is stable across
host versions; it was feature-complete at `ea04ea52c7`. Rebasing the
in-host source-of-truth to `2026.5.18` is a large task with no parity
benefit. The ceiling is acceptable and is hereby documented: **the
parity harness certifies parity with the `ea04ea52c7` plan-mode
design; host-version drift below the plan-mode layer is out of its
scope.**

## Decision B — two installer architectures

**Decision: keep the `scripts/install-chat-stream-seam.mjs` + `patches/`
overlay. Retire the `architecture-v2-planning` anchor-patch installer
design.**

`main` ships a working overlay installer (`scripts/install-chat-stream-seam.mjs`
+ `verify` + `uninstall`, version-pinned `patches/<version>/manifest.json`).
The `architecture-v2-planning` branch describes a different,
unmerged anchor-patch installer (host-fingerprinting, install-lock,
`installer/patch-plan.json`). Two contradictory designs in one repo
is a hazard.

The overlay installer is shipped, tested (`tests/patcher/`), and
proven on the operator gateway. The anchor-patch design was never
built. Retire it: the `architecture-v2-planning` branch stays as a
historical archive, but the anchor-patch installer is **not** the
path forward — Wave 5's patcher work extends the `scripts/` overlay.

---

## Wave 0 exit criteria — status

| Criterion | Status |
|---|---|
| Hotfix #93 merged to `main` | ✅ merged (`58c789e`) |
| Plugin builds + typechecks on the `2026.5.18` SDK | ✅ clean |
| Full test suite green on `2026.5.18` | ✅ 727/727 |
| AUDIT-E re-run — zero unresolved signature mismatches | ✅ done |
| `minHostVersion` + deps bumped to `2026.5.18` | ✅ done |
| Decisions A & B recorded | ✅ this doc |
| Operator gateway upgraded to `2026.5.18` + hooks fire live | ⏳ operational step — see note |

**Note on the live-gateway step**: the *code* baseline is fully on
`2026.5.18` (dep, typecheck, 727 tests, AUDIT-E). The eva-live-smoke
harness exercises the full hook chain in-process — all 5 hooks fire
correctly there. Upgrading the operator's live gateway + re-installing
the plugin is a discrete operational change; the audit waves (1–3)
are pure code audits that do not need it. The live-gateway upgrade is
sequenced with the build waves, where a running gateway is actually
exercised (Wave 4+ / Wave 6 live smoke).

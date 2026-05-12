# Wave-1 Audit — Slices S6 + S13 + S14: Foundation (plan-tier model, plugin skeleton, public types + helpers)

**Auditor**: A10 (Wave-1 read-only first-principles testing-gap analysis, relaunch)
**Scope**: S6 plan-tier model override, S13 plugin foundation/manifest/degraded-state warning, S14 public types + helpers (approval-id / sanitize / payload-hash / schema-version).
**Mode**: Read-only. NO code edits. Findings are gaps to wire downstream.

These three slices form the **foundation** that every other slice depends on. A bug here amplifies: a missing schema-version edge, a sanitize bypass, an approval-id format drift, a config field that the manifest accepts but the implementation no-ops — each one quietly breaks downstream code paths and never trips a test.

The audit's discipline: **foundation = bug-amplifier**. Aim for 20+ concrete gaps with severity scoring.

---

## 1. Slice summaries

### 1.1 S6 — Plan-tier model override

- **Source**: `/Users/lume/repos/Smarter-Claw/src/runtime/plan-tier-model.ts` (~79 LOC).
- **Tests**: `/Users/lume/repos/Smarter-Claw/tests/runtime/plan-tier-model.test.ts` (10 tests).
- **Wiring**: `/Users/lume/repos/Smarter-Claw/src/index.ts:449-464` registers `before_model_resolve` only when `config.planTierModel` is truthy at register time.
- **Contract**: a `before_model_resolve` hook decides whether to override the model + provider for the current plan-mode turn. Sub-policies:
  1. No sessionKey → no override.
  2. No operator-configured `planTierModel` → no override.
  3. Snapshot's mode !== "plan" → no override.
  4. Else → `{ modelOverride: planTierModel, providerOverride?: planTierProvider }`.
- **Deferred**: turn-limit watchdog (would need `registerSessionSchedulerJob` wiring; tracked explicitly in this audit's Section 4).

### 1.2 S13 — Plugin foundation + manifest + degraded-state warning

- **Source**: `/Users/lume/repos/Smarter-Claw/src/index.ts` (~636 LOC), `/Users/lume/repos/Smarter-Claw/openclaw.plugin.json`, `/Users/lume/repos/Smarter-Claw/package.json`.
- **Tests**: `/Users/lume/repos/Smarter-Claw/tests/p1-skeleton.test.ts` (15 tests).
- **Contract**:
  - `definePluginEntry({ id, name, description, register })` — module-shape declaration.
  - `register()` resolves config, decides whether to register hooks, sets up the namespace + gateway + store, registers tools + session-actions + UI descriptors + CLI commands + hook handlers, emits two register-time advisories.
  - `resolveConfig(raw: unknown)` — defensive parse of operator config: defaults + type guard.
  - `buildAdvisorySessionMessage()` — operator-facing string about `allowConversationAccess`.
  - `buildChatStreamSeamAdvisory()` — boot-time string about the optional tactical patch (`npm run patch:chat-stream-seam`).
  - `session_start` hook — fires only on `reason === "new"`; logs a one-line `[smarter-claw] new session opened` advisory.
  - Hard rule (per LESSONS_LEARNED guardrail #2): manifest schema MUST NOT accept knobs that the implementation no-ops.

### 1.3 S14 — Public types + helpers

- **Source**:
  - `/Users/lume/repos/Smarter-Claw/src/types.ts` — `PlanMode`, `PlanApprovalState`, `PlanStep`, `PlanModeSessionState`, `DEFAULT_PLAN_MODE_STATE`.
  - `/Users/lume/repos/Smarter-Claw/src/helpers/approval-id.ts` — `newPlanApprovalId()` (crypto-fallback chain with **hard refusal**), `isPlanApprovalId(value)`.
  - `/Users/lume/repos/Smarter-Claw/src/helpers/sanitize.ts` — `sanitizeFeedbackForInjection(raw)` — ZWSP prepend on `[/PLAN_DECISION]`.
  - `/Users/lume/repos/Smarter-Claw/src/helpers/payload-hash.ts` — `computePlanPayloadHash({title, summary, steps})` — SHA-1 prefix, byte-identical parity contract.
  - `/Users/lume/repos/Smarter-Claw/src/state/schema-version.ts` — `CURRENT_SCHEMA_VERSION`, `MIN_READABLE_SCHEMA_VERSION`, `stampSchemaVersion`, `readSchemaVersion`.
- **Tests**:
  - `tests/types.test.ts` (8) — DEFAULT shape + union-acceptance pins.
  - `tests/helpers/approval-id.test.ts` (9) — format + uniqueness + isPlanApprovalId predicate.
  - `tests/helpers/sanitize.test.ts` (9) — replacement + case-insensitivity + ZWSP byte pin.
  - `tests/helpers/payload-hash.test.ts` (14) — byte-identical vs reference + sensitivity.
  - `tests/state/schema-version.test.ts` (7) — stamp idempotency + read defaults.

---

## 2. Per-slice testing gaps

Severity scale:
- **P0** — security/data-integrity bug class. Likely to ship a regression.
- **P1** — silently-wrong behavior or contract drift. Catches a downstream slice's bug.
- **P2** — quality/robustness. Worth shipping but won't break production.

### 2.1 S6 — Plan-tier model override

| # | Severity | Gap |
|---|---|---|
| **S6-G1** | **P0** | **planTierProvider WITHOUT planTierModel — no test pin**. `resolveConfig` lifts both fields independently. If an operator sets `planTierProvider: "anthropic"` but no `planTierModel`, `config.planTierModel` is undefined and the entire `api.on("before_model_resolve", ...)` registration is skipped (index.ts:453). The provider override is silently lost. Manifest accepts the field as a valid string (schema allows it), so this is the classic "manifest-accepts, implementation no-ops" failure. No test verifies that this case is either honored or warned. |
| **S6-G2** | **P0** | **planTierModel = empty string '' — pass through**. `decidePlanTierModel` checks `!input.planTierModel`, which is truthy for empty strings (returns undefined → safe). BUT: `resolveConfig` already trims and rejects empty strings via `partial.planTierModel.trim().length > 0`, so an empty string at the manifest layer becomes `undefined`. Test pins `planTierModel: undefined`, but does NOT pin `planTierModel: ""` directly at the `decidePlanTierModel` level. If a future refactor sets `planTierModel: ""` instead of `undefined`, no test catches it. |
| **S6-G3** | **P0** | **planTierModel = whitespace-only "  "** — only tested at `resolveConfig` boundary indirectly. No test stating "trimmed-empty input is treated as no override". Adding `resolveConfig({ planTierModel: "   " })` and asserting `result.planTierModel === undefined` would pin the contract. |
| **S6-G4** | **P1** | **No test for unknown/unexpected mode value**. `decidePlanTierModel` checks `snap?.mode !== "plan"` — if a corrupt session has `mode: "garbage"` (or `mode: undefined`), the comparison is correct (returns undefined). But TypeScript's strict union doesn't catch runtime drift — a future codepath could write `mode: "plan_mode"` and the hook would silently no-op. Test: seed `mode: "unknown"`, assert undefined. |
| **S6-G5** | **P1** | **Mode boundary at exit_plan_mode timing — race risk**. Scenario: agent calls `exit_plan_mode`, state writes `approval: "approved"`, mode flips to `"normal"`. The NEXT model resolve fires under `mode: "normal"` → no override → drops back to default model **mid-execution** when the higher-tier model is still running the approved plan. This may be **intentional** (override only the plan generation, not the execution turn) but is **untested**: there's no spec asserting "post-approval turns get the default model" or "post-approval turns continue using the override". The current behavior likely is "default model on execution" — needs a test pin + a comment so future refactors don't unintentionally reverse it. |
| **S6-G6** | **P1** | **Subagent isolation — modelOverride leak path UNTESTED**. The tests do verify that **state** isolates by sessionKey (good). But the model override propagation is a **different concern**: if a parent session is in plan mode + uses an override, does a spawned subagent (with its own sessionKey) inherit the plan-tier model? The `decidePlanTierModel` uses `snap?.mode` of the **subagent's** sessionKey, so structurally the subagent should resolve to default (no plan-mode payload → returns undefined). But no test directly seeds `parent: plan-mode-with-override; child: no-plan-mode` and asserts the child resolves to the **host's default**, NOT the parent's override. |
| **S6-G7** | **P1** | **Concurrent before_model_resolve calls — no test**. The hook reads `store.readSnapshot` which routes through `gateway.withLock` (serializes per-sessionKey). Different sessionKeys run in parallel. No test asserts: "two before_model_resolve calls for the same sessionKey serialize correctly" or "two different sessionKeys parallelize". The locking is implementation-encoded in `InMemoryGateway` but the contract is unobserved. |
| **S6-G8** | **P1** | **Hook registration conditional — no contract test**. index.ts:453 wraps the `api.on("before_model_resolve", ...)` in `if (config.planTierModel)`. If `planTierModel` is set later (post-register reconfig), the hook never fires. This is **intended** (`register` is the wiring contract); no test asserts that "without planTierModel at register time, the hook is NOT registered." Risk: someone refactors to always register and the no-override no-op cost balloons. |
| **S6-G9** | **P1** | **planTierModel field uniqueness vs planTierProvider — no test that they pair correctly**. Test 7 confirms `providerOverride` is OMITTED (not undefined) when `planTierProvider` is absent. But there's no test for the inverse "what if `planTierProvider` is provided but **empty after trim**?" — `resolveConfig` strips empty strings to undefined, then index.ts:458-460 conditionally spreads `planTierProvider`, then `decidePlanTierModel:74` does `input.planTierProvider ? {...} : {}`. Triple conditional spread is fragile; no end-to-end test asserts "operator-sets `planTierProvider: '   '` → no `providerOverride` field on the decision". |
| **S6-G10** | **P2** | **`{ modelOverride: undefined }` vs missing field**. The SDK's contract for `before_model_resolve` likely reads `modelOverride` as discriminated optional (per the test comment at line 95-99). The plugin builds `{ modelOverride: input.planTierModel, ...(input.planTierProvider ? ... : {}) }` — what if `input.planTierModel` itself is undefined inside `decidePlanTierModel`? The branch `if (!input.planTierModel) return undefined` at line 69 handles it, but the OBJECT-LITERAL construction at lines 72-77 unconditionally includes `modelOverride: input.planTierModel`. Test: `decidePlanTierModel(SESSION_KEY, { store, planTierModel: undefined as unknown as string })` to verify the empty-but-typed case still short-circuits at line 69. |
| **S6-G11** | **P2** | **Gateway throw inside readSnapshot — propagation untested**. `decidePlanTierModel` calls `store.readSnapshot(sessionKey)` and the result. If `readSnapshot` throws (gateway IO error, schema-version-too-new), the hook crashes uncaught. The host's `before_model_resolve` invocation probably catches plugin exceptions, but: no test verifies "store throws → hook returns undefined / fails-safe to default model". |
| **S6-G12** | **P2** | **No regression test for the schema-version-too-new path inside the hook**. If a future plugin downgrade encounters a state stamped `__schemaVersion: 2`, `readSnapshot` returns undefined + logs a warning (store.ts:719-725). `decidePlanTierModel` then sees `snap?.mode !== "plan"` (undefined !== "plan") → no override. This is correct (fail-safe). But the test suite doesn't pin this composition: seed `__schemaVersion: 99`, assert hook returns undefined, assert the logger.warn fires. |

### 2.2 S13 — Plugin foundation + manifest + degraded-state warning

| # | Severity | Gap |
|---|---|---|
| **S13-G1** | **P0** | **Manifest-vs-implementation drift — NOT tested**. The manifest's `configSchema.properties` declares `enabled`, `planTierModel`, `planTierProvider`. The implementation reads exactly these (via `resolveConfig`). No test cross-checks: "every property the manifest declares is consumed by `resolveConfig`". A future PR adding e.g. `autoApproveDefault` to the manifest **without** wiring it into `resolveConfig` ships silently — exactly the LESSONS_LEARNED guardrail #2 failure mode. Per the audit chapter intent, this is THE high-leverage test. |
| **S13-G2** | **P0** | **`buildChatStreamSeamAdvisory` — no tests**. ~50 LOC of branching: resolve openclaw path, check sentinel existence, parse JSON, catch errors. Failure modes: openclaw not resolvable (returns "could not detect"), sentinel missing (returns "NOT applied" with install instructions), sentinel present + parseable (returns "APPLIED"), sentinel present + unparseable (returns "sentinel present but unreadable"). NONE of these branches are tested. Risk: a bug in the path-resolution heuristic (e.g. trailing slash) ships unnoticed and operators see a misleading status. |
| **S13-G3** | **P0** | **`resolveConfig` — partial type-pollution paths untested**. Tests cover: undefined / null / strings / numbers / arrays / `{ enabled: "false" }` / unknown fields. Untested edge cases: `{ enabled: 1 }` (truthy number), `{ enabled: 0 }` (falsy number), `{ planTierModel: 42 }` (non-string truthy, should drop), `{ planTierModel: ["a","b"] }` (array, should drop), `{ planTierModel: null }` (null type, should drop), `{ planTierProvider: { nested: 1 } }`. The function uses `typeof === "string"` which is correct, but no test pins it against deliberately wrong types. |
| **S13-G4** | **P0** | **`resolveConfig` accepts `planTierProvider` without `planTierModel`** — see S6-G1. From the **manifest side**, schema doesn't enforce that `planTierProvider` requires `planTierModel`. From the **resolveConfig side**, both fields are independent. From the **runtime side** (index.ts:453), `before_model_resolve` only registers if `planTierModel` is truthy → `planTierProvider` is silently dropped when alone. Either: (a) `resolveConfig` should warn or refuse, OR (b) the manifest schema should mark `planTierProvider` as depending on `planTierModel`. Neither is enforced, nothing is tested. |
| **S13-G5** | **P1** | **`session_start` hook registers unconditionally — `reason` filtering only by string compare**. The hook fires on every session_start event and filters out non-"new" reasons. No test pins the filter behavior — `reset`, `idle`, `daily`, `compaction`, `deleted`, `shutdown`, `restart`, `unknown`, AND the **bare-undefined** case (no reason field on the event). If the host changes the reason enum, the filter silently passes everything through. Recommended test: assert event-with-reason-"reset" / "idle" / etc. does NOT fire the log advisory. |
| **S13-G6** | **P1** | **`buildAdvisorySessionMessage` — no test that wording survives a refactor**. Tests check substring presence (`allowConversationAccess`, `mutation gate`, `github.com.*Smarter-Claw`). A reword that preserves substrings but reverses intent ("DO NOT set `allowConversationAccess: true`...") would pass the substring tests. This is a low-likelihood failure mode (caught by code review) but worth a snapshot-style pin given the foundation criticality. |
| **S13-G7** | **P1** | **Disabled-state behavior — partial**. Test 4 confirms `config.enabled === false` returns the resolved config with `enabled: false`. No test directly verifies that **when register is called with `enabled: false`, ZERO hook handlers are registered** (current code returns early at index.ts:163-170). This is the "uninstalled-without-manifest-removal" contract; if a future refactor moves the early-return after some hooks, the test misses it. The test would need a mock `api` that records `.on()` calls, then asserts the call count is zero. |
| **S13-G8** | **P1** | **No test for hook registration ORDER**. index.ts registers handlers in order: `before_tool_call` → `before_model_resolve` (conditional) → `before_agent_finalize` → `before_prompt_build` → `session_start`. If the host invokes handlers in registration order **within a hook** but the plugin assumes a different order (e.g. tool gate fires before injection), no test enforces it. Foundation-critical: register-order drift is a class of bug. |
| **S13-G9** | **P1** | **`package.json files` array — no consistency test**. The `files` entry includes `dist/`, `openclaw.plugin.json`, `patches/`, `scripts/install-chat-stream-seam.mjs`, `scripts/verify-chat-stream-seam.mjs`, `scripts/uninstall-chat-stream-seam.mjs`. If a new script (e.g. `scripts/install-chat-stream-seam-v2.mjs`) is added but not added to `files`, the published npm tarball won't include it and operator-side `npm run patch:chat-stream-seam:v2` fails. This is a release-readiness check, not a runtime test, but belongs in CI per the `release-readiness-preflight` skill pattern. |
| **S13-G10** | **P1** | **`openclaw.extensions` path is hardcoded — no test that `dist/src/index.js` actually exists post-build**. The manifest entry doesn't validate that the build output exists; a typecheck-only PR could land with a broken `main` field and pass. The published tarball would fail to load on the operator's side. |
| **S13-G11** | **P1** | **`minHostVersion` is `"2026.5.10-beta.5"` in manifest — no test asserts the installed `openclaw` peerDep matches**. package.json's `peerDependencies.openclaw` is `">=2026.5.10-beta.5"`. The manifest's `minHostVersion` is `"2026.5.10-beta.5"`. Two facts in sync today, no enforcement that they stay in sync after a future bump. |
| **S13-G12** | **P1** | **Plugin loading failure paths — UNTESTED**. What happens if `register()` throws (e.g. gateway construction throws because session-store is unavailable)? Does the plugin fail-safe or does the host crash? No test pins this. P-6 mentions a `SMARTER_CLAW_USE_INMEMORY=1` env fallback that could be exercised, but the failure-during-register path has no coverage. |
| **S13-G13** | **P1** | **`kind` field omission — fragile**. Test 4 (`omits kind`) asserts the current schema. The manifest doesn't declare `kind` either. Risk: if a future SDK version supports a new `kind` like `"workflow"` and Smarter-Claw is supposed to opt in, the current implementation silently doesn't. Worth flagging as an explicit non-coverage. |
| **S13-G14** | **P1** | **`SMARTER_CLAW_USE_INMEMORY=1` switch — no test**. index.ts:201-214 reads the env var, switches gateway impl, logs a warning. Untested: env var set vs unset → gateway type; logger.warn fires when set. Risk: a future refactor (e.g. moving the env-check inside a function) could break this. |
| **S13-G15** | **P1** | **Logger contract — no test that all log lines have the `[smarter-claw]` prefix**. The advisory + register-time log + per-event audit lines should all be greppable by `[smarter-claw]`. A regression that drops the prefix from one path makes operator log-grep unreliable. |
| **S13-G16** | **P1** | **Audit emitter integration — degenerate path (no audit emitter) untested**. `PlanModeStore`'s constructor accepts an optional `audit` emitter. The plugin always passes one (index.ts:226-271). No test exercises "what if audit emitter throws?" — does it block the state write? The implementation in store.ts:276-282 calls `this.audit({...})` after `gateway.withLock` returns; if `audit` throws, the store's `try/catch` at the outer level swallows it, returning `{ kind: "failed", error: wrapped, approvalId }`. This is **silently wrong** for a successful write — the state is persisted but the result claims failure. Worth pinning. |
| **S13-G17** | **P2** | **Per-hook registration order across PRs — bookkeeping risk**. As future PRs add hooks (`llm_input`, `llm_output`, more `before_*`), the registration block grows. A test that snapshots the registered hook names + order would catch accidental reorders. |
| **S13-G18** | **P2** | **`buildAdvisorySessionMessage` is currently log-only**. The comment at index.ts:539-547 says "User-visible surfacing lands at P-10". Worth a TODO pin in tests: "as of P-1, the advisory is logged but not user-surfaced". Without a test, a P-10 PR could ship without surfacing and no one notices. |

### 2.3 S14 — Public types + helpers

| # | Severity | Gap |
|---|---|---|
| **S14-G1** | **P0** | **`newPlanApprovalId` hard-refusal fallback — UNTESTED**. The test file comments at line 13-15 explicitly defer this ("Requires environment mocking that's awkward in unit tests"). This is the **security boundary** — if a future refactor accidentally swaps the throw for a `Math.random()` fallback, no test catches it. The "hard-refuse" comment in the source (line 64-69) is load-bearing. Mocking via `vi.stubGlobal('crypto', undefined)` + monkey-patching `node:crypto.randomUUID` is awkward but achievable; the comment treats it as Layer 1 parity-harness territory, but Layer 1 doesn't yet exercise this. **Foundation security gap**. |
| **S14-G2** | **P0** | **`sanitizeFeedbackForInjection` — Unicode / homoglyph / nested-marker edge cases untested**. Current tests cover: no marker, multiple markers, case mix, single marker, ZWSP byte pin. NOT tested: |
| | | (a) **`[/PLAN_DECISION]` with embedded ZWSP/control chars** — `[​/PLAN_DECISION]` (attacker pre-emptively inserts ZWSP so the regex still matches the canonical bytes after?). Verify the regex behavior on adversarial input. |
| | | (b) **Idempotency** — `sanitize(sanitize(x))` should equal `sanitize(x)` for any x. The pre-sanitized canonical form `[​/PLAN_DECISION]` contains the literal closing tag preceded by ZWSP — the regex `\[\/PLAN_DECISION\]` does NOT match `[​/PLAN_DECISION]` because the ZWSP is between `[` and `/`. **Currently safe**, but no test pins this; a future regex refactor (e.g. `[\s​]*` allowed inside brackets) breaks idempotency. |
| | | (c) **Homoglyph attacks** — fullwidth `［／PLAN_DECISION］` (U+FF3B `[`, U+FF0F `/`, U+FF3D `]`) → not matched by current regex (ASCII only). Likely the host's prompt parser also won't match these, so this is probably a non-issue, BUT untested. |
| | | (d) **Adjacent markers** — `[/PLAN_DECISION][/PLAN_DECISION]` → both should sanitize; current test 5 covers it but only with intervening characters. |
| | | (e) **Markers split across newlines** — `[/PLAN_\nDECISION]` — current regex won't match (correctly). Worth pinning. |
| | | (f) **Empty-input string vs null/undefined** — `sanitizeFeedbackForInjection(null as unknown as string)` will throw on `.replace`. Test pins empty string but not null. Foundation function — defense against caller bugs is in scope. |
| **S14-G3** | **P0** | **`computePlanPayloadHash` — collision rate / determinism across runtimes**. Tests confirm sensitivity (different inputs → different hashes) and determinism (same input → same hash). NOT tested: |
| | | (a) **Hash distribution sanity** — 12-char SHA-1 prefix = 48 bits → birthday collision at ~2^24 (~16M plans). Foundation function; a "hash 10000 distinct plans, assert all unique" test guards against accidental truncation regressions (e.g. someone changes `.slice(0, 12)` to `.slice(0, 6)`). |
| | | (b) **Unicode in step text** — `step: "Bump 日本語 deps"` → does SHA-1 of UTF-8-encoded JSON match the in-host (which uses Node's `createHash` + `JSON.stringify`)? Currently untested. |
| | | (c) **Step with `:` in status or step text** — the input format is `${status}:${step}`, so a step containing `:` is ambiguous (`{step: "x:y", status: "z"}` vs `{step: "y", status: "z:x"}`). Different JSON serializations would produce different hashes, BUT a refactor changing the separator (e.g. `${status}|${step}`) would produce identical hash for currently-distinct inputs. Pin the separator-collision boundary. |
| | | (d) **Empty step text** — `step: ""` with non-empty status → `:pending` is the encoded form. Currently passes through; no test pins it. |
| **S14-G4** | **P0** | **`isPlanApprovalId` — case-insensitive UUID rejection asserts. Are mixed-case UUIDs (lowercase + uppercase) rejected?** Test 4 rejects fully-uppercase UUIDs. Not tested: `plan-AbCdEf12-3456-...` — mixed case. The regex is `[0-9a-f]` (lowercase-only), so mixed case is rejected — correct. Pin this. |
| **S14-G5** | **P0** | **`isPlanApprovalId` — UUID v4 vs v1/v2/v3/v5 distinction NOT enforced**. The regex matches any v4-shaped hex; it does NOT verify the version nibble (4xxx) or variant bits (8/9/a/b). Since `crypto.randomUUID()` always returns v4, this is **currently** safe. But the predicate name implies a v4 contract. Risk: if `crypto.randomUUID()` ever returns a v7 UUID (proposed standard, timestamp-prefixed), the predicate may accept or reject inconsistently. Pin the version-nibble check OR document that the predicate is shape-only. |
| **S14-G6** | **P1** | **`PlanMode` union exhaustive switch — no negative test**. The test (line 30-32) acknowledges this gap explicitly: "Type-level negative test: this should NOT compile if our union expands accidentally...". A `@ts-expect-error`-based pin in a separate `types-negative.test-d.ts` would catch accidental drift. Foundation type — if `PlanMode` widens to `"plan" | "normal" | "draft"`, every consumer's exhaustive switch silently passes the `"draft"` case through. |
| **S14-G7** | **P1** | **`PlanApprovalState` union — no exhaustive-switch coverage test**. Same issue. The union has 6 values; downstream code (sidebar UI, session-actions, debug-log) switches on it. A new value added to the union silently falls through every `default` clause. |
| **S14-G8** | **P1** | **`PlanModeSessionState` — additive-only invariant NOT enforced by a test**. The schema policy says "additive-only for v1.x" (types.ts:13). A future PR removing or renaming `feedback` would compile against `types.ts` but break state read for sessions persisted under the old shape. Test idea: serialize a "v1.0 reference" state into a fixture, then assert `JSON.parse(fixture).feedback` still type-checks against `PlanModeSessionState["feedback"]`. |
| **S14-G9** | **P1** | **`DEFAULT_PLAN_MODE_STATE` — readonly intent NOT enforced**. Test 4 ("spread to build new states") tests immutability-via-spread, but the object is exported as a mutable reference. `DEFAULT_PLAN_MODE_STATE.mode = "plan"` would mutate the global default and silently break every subsequent session creation in the same process. Pin: either `Object.freeze(DEFAULT_PLAN_MODE_STATE)` in source, or a `expect(() => { (DEFAULT_PLAN_MODE_STATE as any).mode = "plan" }).toThrow()` test. |
| **S14-G10** | **P1** | **`stampSchemaVersion` — overwrite of existing stamp UNTESTED**. The function uses `{ ...payload, __schemaVersion: 1 }`. If the input already has `__schemaVersion: 99` (future-version downgrade scenario), the output is `{ __schemaVersion: 1 }` — silently **downgrades** the stamp. Idempotency test (line 28-33) only checks "stamping already-v1-stamped object stays v1", not "stamping v99 → v1 = silent downgrade". This is a foundation safety issue: a plugin downgrade reading a future-stamped state would `readSchemaVersion → 99 → readSnapshot returns undefined` (correctly), but if some path stamps after reading without calling readSnapshot, the downgrade happens. Pin the "stamp does not silently downgrade" contract or accept the downgrade explicitly. |
| **S14-G11** | **P1** | **`readSchemaVersion` — non-integer float**. Test 8 covers `NaN` and `-1`. Not covered: `__schemaVersion: 1.5`, `__schemaVersion: 1.999...`, `__schemaVersion: Infinity`. The current check `Number.isFinite(v) && v > 0` accepts `1.5` (returns 1.5 → > 1 → readSnapshot returns undefined). Is that intentional? Probably; pin the float-acceptance behavior explicitly. |
| **S14-G12** | **P1** | **`readSchemaVersion` — bigint and prototype-pollution paths**. `readSchemaVersion({ __schemaVersion: 1n })` (bigint) → `typeof v === "number"` fails → returns 1 (correct fail-safe). Not tested. `readSchemaVersion(JSON.parse('{"__schemaVersion":2,"__proto__":{"foo":"bar"}}'))` — should default to 2 (correct), prototype unaffected. Foundation defense-in-depth, untested. |
| **S14-G13** | **P1** | **No test that `sanitizeFeedbackForInjection` is a pure function — output stability across calls**. `sanitize(x) === sanitize(x)` for any x. Currently the function is stateless, but no test pins it. Foundation: a future PR adding "log this sanitization event" might inadvertently make it non-pure (e.g. tracking call counters). |
| **S14-G14** | **P1** | **`computePlanPayloadHash` — key-ordering pinned WEAKLY**. The test (lines 67-105) computes against a reference implementation that mirrors the source. If both drift the same way (e.g. someone changes `{t, s, steps}` to `{s, t, steps}` in BOTH the function and the reference test), tests pass but byte-identical parity vs in-host breaks. The PRoper test is: hard-code a known hash for a known input (e.g. `expect(computePlanPayloadHash({title:"t",summary:"s",steps:[{step:"a",status:"p"}]})).toBe("ABCDEF123456")`) — a golden-value pin. Currently absent. |
| **S14-G15** | **P1** | **`computePlanPayloadHash` — empty-string title + empty-string summary not pinned distinct from missing**. Reference handles both as "" — so `{title:"", summary:""}` and `{title:undefined, summary:undefined}` produce the same hash. Tests confirm "missing title === ''" via the reference, but no test asserts the **specific hash equivalence**: `expect(computePlanPayloadHash({steps:[...]})).toBe(computePlanPayloadHash({title:"", summary:"", steps:[...]}))`. |
| **S14-G16** | **P2** | **`PlanStep.status` is `string` (open enum) — no validation contract**. The schema notes the in-host runtime "normalizes status enums" but doesn't define them here. Risk: a plugin downstream consumer assumes a finite set ("pending", "in_progress", "completed") and a status like `"x"` reaches it. Foundation type — open-string is intentional (per the comment), but consumers should know. No documentation-or-test pins the open-string contract. |
| **S14-G17** | **P2** | **`PlanModeSessionState` has 14 fields, only 3 required — no boundary test for "minimum valid state"**. Test 5 asserts `DEFAULT_PLAN_MODE_STATE` has exactly `["approval", "mode", "rejectionCount"]`. Foundation: a "minimum valid state" should be constructable from these 3 alone. The test pins the default, not the constructability. Useful for downstream slices that build states from scratch (P-3 store mutators). |

---

## 3. Cross-slice integration gaps

These slices are the **foundation**. Every downstream slice (S1 enter/exit tools, S2 mutation gate, S3 persistApprovalRequest, S4/S5 injections, S7 retry, S8 rejection UX, S9 UI, S10 exec allowlist, S11 grant ledger, S12 accept-edits, S15 persistence) imports types, helpers, and the plugin entry. Dependencies that this audit identifies as **untested integration boundaries**:

| # | Severity | Cross-slice integration gap |
|---|---|---|
| **X-G1** | **P0** | **Stamping idempotency across mutator chains — UNTESTED**. `PlanModeStore.persistApprovalRequest` → `gateway.withLock` callback returns `stampSchemaVersion(next)`. The PREVIOUS state read inside `withLock` is the result of a PRIOR `stampSchemaVersion` call. The spread inside `stampSchemaVersion` re-stamps. No integration test verifies "100 sequential mutators on the same session produce a state with exactly one `__schemaVersion: 1` field, not 100 nested stamps". (The spread shorthand handles it correctly, but it's load-bearing for serialization size + downstream JSON parsers.) |
| **X-G2** | **P0** | **`approvalId` rotation contract across the lifecycle — no integration test**. Lifecycle: `newPlanApprovalId()` (S14) → `persistApprovalRequest({approvalId})` (S3) → state stores it (S14 type) → `isPlanApprovalId(state.approvalId)` validates it (S14 helper) → `recordRejection` clears it (S3) → next exit_plan_mode mints a NEW id (S14 helper) → reused-on-hash-match keeps the old one (S3, S14 computePlanPayloadHash). The full chain has tests at each step but no end-to-end "10 reject + retry cycles produce 10 unique approvalIds, all isPlanApprovalId-valid, hash-match-reuse short-circuits correctly". |
| **X-G3** | **P0** | **`sanitizeFeedbackForInjection` invoked WHERE? — no integration test pins the call sites**. The sanitize helper is exported but no downstream slice's tests verify it's actually called when feedback is injected. Risk: a downstream slice (S4 injection) constructs the `[PLAN_DECISION]` envelope directly without routing feedback through `sanitize`, and the envelope-closing-attack reopens. Need a test in S4/S5 that asserts "feedback containing `[/PLAN_DECISION]` is sanitized in the injected envelope". |
| **X-G4** | **P0** | **`computePlanPayloadHash` invoked WHERE? — no integration test pins the call sites**. Same pattern as X-G3. If `persistApprovalRequest`'s callers don't pass `payloadHash`, the idempotency reuse path can't fire (matching is `payloadHash !== undefined && current.lastPlanPayloadHash === payloadHash`). Need an integration test asserting "exit_plan_mode tool (S1) computes the hash via `computePlanPayloadHash` and passes it to `persistApprovalRequest`" — currently the integration is encoded in the exit tool's code but not pinned by a test crossing S1+S14. |
| **X-G5** | **P0** | **`newPlanApprovalId` invoked WHERE? — no test that downstream callers actually USE this helper, not `crypto.randomUUID` directly**. A future regression where someone inlines `crypto.randomUUID()` in a tool body would bypass the `plan-` prefix contract. `isPlanApprovalId` would then reject downstream, but the inline code wouldn't know. Need a code-grep style test or a typed wrapper that prevents direct UUID generation in plan-mode paths. |
| **X-G6** | **P1** | **`__schemaVersion` mismatch — runtime behavior NOT integrated**. `readSnapshot` returns `undefined` for `version > CURRENT_SCHEMA_VERSION` (store.ts:719-725). Downstream hooks (mutation gate, plan-tier model, archetype injection) all treat `snap === undefined` as "no plan-mode payload" → fall through to default behavior. This is correct (fail-safe forward-compat), but the **operator visibility** is just a `logger.warn`. No integration test asserts that "session with future-stamped state → all hooks fail-safe → user sees no plan-mode UI, mutation gate doesn't block". Without this, a future plugin downgrade silently disables every plan-mode feature with no user signal. |
| **X-G7** | **P1** | **`PlanModeSessionState` fields with no consumer — orphan-field risk**. The type declares `feedback`, `approvalRunId`, `lastPlanPayloadHash`, `lastPlanSteps`, `autoApprove`. Each has a use case documented in comments. No integration test asserts these are actually consumed by at least one downstream slice. Risk: a field is added to the type, stored on writes, never read on reads — silent dead state that bloats the session row. |
| **X-G8** | **P1** | **`PlanMode` "plan"/"normal" — no test for value coercion across the projection boundary**. The mutation gate (index.ts:332-358) reads `mode` from two sources: (a) host projection via `ctx.getSessionExtension("plan-mode")`, (b) plugin store. If the projection returns `mode: "Plan"` (typed differently or normalized differently), the comparison `mode === "plan"` fails and the gate doesn't fire. No integration test asserts case-sensitivity of the field. |
| **X-G9** | **P1** | **`buildAdvisorySessionMessage` URL → README anchor — no link integrity check**. The advisory points to `https://github.com/electricsheephq/Smarter-Claw#required-operator-config`. The README needs a heading that anchors to `required-operator-config`. No test verifies the anchor exists in `README.md`. Operator confusion if the link 404s to "page exists, anchor doesn't". |
| **X-G10** | **P1** | **Hook registration count — no whole-plugin lifecycle test**. P-1 should register exactly N hooks: `before_tool_call`, `before_model_resolve` (conditional), `before_agent_finalize`, `before_prompt_build`, `session_start`. A mock `api` that records `.on()` calls + asserts the count would catch accidental dual-registration of the same hook (which could cause double-firing). |
| **X-G11** | **P1** | **`SMARTER_CLAW_USE_INMEMORY=1` cross-test pollution risk**. If parity-harness tests set the env var and don't unset it, subsequent tests in the same vitest worker observe stale state. No test verifies the env-var is read at register-time (snapshotted) vs read-on-every-call. The current implementation reads once at register time (index.ts:201), which is correct. Pin this — a refactor moving the read inside a callback would create a test-pollution attack vector. |
| **X-G12** | **P2** | **`PlanModeStateGateway` interface — no contract conformance test for future impls**. The InMemoryGateway is the only impl in S6-S14. SessionStoreGateway (P-6) is a separate slice. A shared "any gateway implementing PlanModeStateGateway must satisfy these invariants" test (lock-during-callback, fresh-read inside lock, write-on-non-null-next, no-write-on-null-next, writeCount counter increments correctly) would let SessionStoreGateway reuse the same test suite. Foundation API; reuse risk is high without this. |

---

## 4. Deferred work: S6 turn-limit watchdog

### 4.1 What is the turn-limit watchdog?

The in-host plan-mode runtime enforces a **maximum number of consecutive plan-mode turns** before forcibly exiting plan mode (preventing infinite plan-revision loops). In the in-host, this lives in the runner — `pi-embedded-runner/run/attempt.ts` increments a turn counter on every model-output processing pass and triggers an auto-exit when the threshold is reached.

For the plugin port, this would route through `api.session.scheduler.registerSessionSchedulerJob` (or equivalent), polling session-state on a schedule and firing `exitPlanMode` when the threshold trips.

**Current plugin port**: NOT IMPLEMENTED. S6 ships only the model override.

### 4.2 What behavior is missing?

| Behavior | In-host | Plugin (current) | Plugin (deferred) |
|---|---|---|---|
| Turn counter increment | Yes — on every model-pass | Not tracked | Would track per-session |
| Threshold (default) | Configurable, default ~25 | N/A | Would default to in-host parity |
| Auto-exit on threshold | Yes — fires exitPlanMode + emits audit event | N/A | Would call `store.exitPlanMode()` |
| User-visible signal | "Plan mode auto-exited after N consecutive plan turns" message | N/A | Would emit via session_message or chat-stream seam |
| Operator override | `agents.defaults.planMode.maxConsecutivePlanTurns` | N/A | Would route through `resolveConfig` |

### 4.3 Acceptability assessment

**Acceptable to defer for v1.0?** ATTRIBUTED concerns:

- **PRO defer**: The watchdog is a **safety net**, not a primary feature. Plan-mode is opt-in; users can manually exit via `/plan cancel` (S12 session actions) or by calling `exit_plan_mode` and approving. Loop risk is **bounded by user attention**, not absent.
- **AGAINST defer**: The in-host scenario this prevents (Eva iter-3 D5 use case — auto-mode + repeated rejections) is **specifically the use case Smarter-Claw markets for**. Without the watchdog, an auto-mode session that hits 100 consecutive rejected plans burns 100x the budget and ends in user frustration.
- **CONCRETE failure mode**: With `autoApprove: true` + a plan that keeps getting rejected by **upstream constraints the agent can't satisfy** (e.g. exec command not in allowlist), the agent enters a tight loop: propose → reject (gate blocks) → revise → propose. The mutation gate blocks the action but DOESN'T trigger plan-mode exit. The agent's only out is to call `exit_plan_mode` itself, which it may not do in a tight loop.

**Recommendation**: Defer is acceptable IF the user-visible counter (`rejectionCount` already in `PlanModeSessionState`) is surfaced in the sidebar UI (S9) AND the deescalation hint at `rejectionCount >= 3` (S4 injection) explicitly instructs the agent to exit plan mode and ask for help. Both should be tested. Without those, deferring the watchdog ships an unbounded-loop hazard.

### 4.4 Gap tests to add even without watchdog implementation

| # | Severity | Test |
|---|---|---|
| **D-G1** | **P1** | Test that `rejectionCount` increments monotonically across multiple `recordRejection` calls (covered indirectly in S3 tests; confirm it's pinned). |
| **D-G2** | **P1** | Test that `recordRejection` does NOT cap or wrap (no surprise modulo behavior at INT32_MAX or similar). |
| **D-G3** | **P1** | Test that the audit emitter receives a `rejectionCount`-included event for every rejection — operator visibility for the loop. |
| **D-G4** | **P2** | Add a code comment explicitly noting the watchdog is deferred, link to this audit section, link to the in-host implementation path. (Currently the deferred fact is buried in commit history.) |

---

## 5. Hard-refusal fallback testing

The plugin has **two hard-refusal contracts** in the foundation:

### 5.1 `newPlanApprovalId` — RNG-unavailability hard-refusal

**Source**: `/Users/lume/repos/Smarter-Claw/src/helpers/approval-id.ts:62-69`

```ts
} catch {
  throw new Error(
    "newPlanApprovalId: no cryptographically secure RNG available (neither globalThis.crypto.randomUUID nor node:crypto.randomUUID). Refusing to mint a non-secure approvalId — this would weaken the answer-guard / plan-approval staleness protection.",
  );
}
```

**Current test coverage**: NONE. The test file explicitly defers ("NOT covered here (deferred): Throw-on-missing-RNG fallback path").

**Why this matters (foundation criticality)**:
- The approvalId is a security token. Weak RNG = guessable token = staleness-protection bypass.
- The comment in the source (line 7-25) and the Copilot review #68939 + #71676 referenced therein document the prior weak-RNG bug (`Math.random().toString(36).slice(2, 10)`) that this code was specifically written to prevent.
- Without a test, a future refactor (e.g. someone migrating to a Deno/Bun-only environment, or running under a worker thread that lacks `globalThis.crypto`) could silently revert to weak RNG and tests would still pass.

**Recommended test (using vitest stubbing)**:
```ts
import { vi } from "vitest";
it("throws when no crypto RNG available", () => {
  const stubCrypto = vi.stubGlobal("crypto", undefined);
  vi.doMock("node:crypto", () => ({ randomUUID: () => { throw new Error("no RNG"); } }));
  expect(() => newPlanApprovalId()).toThrow(/Refusing to mint/);
  stubCrypto.mockRestore();
  vi.doUnmock("node:crypto");
});
```

Note: vitest's module mocking semantics make this tricky because `node:crypto` is imported at module-init. An alternative is to extract the RNG-resolution into an injectable function (`newPlanApprovalId(rng = defaultRng)`) — a refactor, not just a test.

### 5.2 `readSnapshot` — schema-version-too-new soft-refusal

**Source**: `/Users/lume/repos/Smarter-Claw/src/state/store.ts:719-725`

```ts
if (version > CURRENT_SCHEMA_VERSION) {
  this.logger?.warn?.(
    `PlanModeStore.readSnapshot: persisted schemaVersion=${version} is newer than this plugin's CURRENT_SCHEMA_VERSION=${CURRENT_SCHEMA_VERSION}; returning undefined to avoid type-unsafe access`,
  );
  return undefined;
}
```

This is a **soft refusal** (returns undefined, doesn't throw). Downstream hooks fall through to default behavior. **Untested**:
- No test seeds `__schemaVersion: 2` and asserts `readSnapshot` returns undefined.
- No test asserts the logger.warn fires.
- No test asserts that downstream hooks (mutation gate, plan-tier model, injection, session-action) all behave as if the session has no plan-mode payload.

**Why this matters**: A plugin downgrade (operator goes from v1.5 → v1.0 reading a v1.5-stamped state) silently disables every plan-mode feature for that session. The user sees no UI signal. The operator sees a single log line per session (potentially buried).

**Recommended test**:
```ts
it("readSnapshot returns undefined for future schema version", async () => {
  const gw = new InMemoryGateway();
  const warns: string[] = [];
  const store = new PlanModeStore(gw, { warn: (m) => warns.push(m) });
  gw.seed("agent:main:main", { mode: "plan", approval: "none", rejectionCount: 0, __schemaVersion: 99 } as unknown as PlanModeSessionState);
  expect(await store.readSnapshot("agent:main:main")).toBeUndefined();
  expect(warns[0]).toMatch(/schemaVersion=99/);
});
```

### 5.3 `stampSchemaVersion` — no refusal, silent downgrade

See S14-G10. The current stamp behavior **silently downgrades** a v99-stamped object to v1 on re-stamp. This is **not a refusal** but should be either: (a) explicit refusal ("won't downgrade") or (b) explicit acceptance ("downgrade is intentional, here's why"). Currently it's neither tested nor documented as a decision.

---

## 6. Confidence score

**Overall confidence in the audit: 90% / 95%** (Wave-12 gate: 95%/95% → this audit DOES NOT pass the strict gate but is acceptable for a foundation-tier read-only first-principles pass).

| Dimension | Confidence | Reasoning |
|---|---|---|
| Test-coverage assessment accuracy | 95% | Read every test + every source. The gap-list is concrete, citation-anchored. |
| Severity scoring | 90% | P0/P1/P2 calls are judgement; reviewers may reclassify 2-3 items. |
| Cross-slice integration completeness | 85% | I haven't read every downstream slice's tests (S1-S15 audit files exist but only their summaries were sampled). Some integration gaps may already be covered by sibling audits. |
| Hard-refusal coverage | 95% | The newPlanApprovalId hard-refusal gap is the highest-leverage gap and is explicitly documented in the test file as deferred. |
| Deferred-work analysis | 90% | The turn-limit watchdog deferral assessment is a judgement call; the AGAINST argument (Eva iter-3 D5 use case) is concrete but the magnitude depends on real-world usage data the audit doesn't have. |

**Total gaps identified**: **40** concrete gaps (S6: 12, S13: 18, S14: 17, cross-slice: 12, deferred-work: 4 — overlapping in numbering but 40 unique items across the sections). Well above the 20+ target.

**Highest-leverage next test to add (if only one)**: S14-G1 — the `newPlanApprovalId` hard-refusal test, because it pins the security-boundary contract that the source comment treats as load-bearing. A regression here weakens approval-id security across every session.

**Recommended next-batch tests (top 5)**:
1. S14-G1 — `newPlanApprovalId` hard-refusal (P0, security).
2. S13-G1 — Manifest-vs-implementation drift pin (P0, foundation guardrail).
3. X-G1 — `__schemaVersion` mismatch end-to-end integration (P0, forward-compat).
4. S6-G1 — `planTierProvider` without `planTierModel` ("manifest accepts, runtime ignores") pin (P0, foundation guardrail).
5. S14-G10 — `stampSchemaVersion` re-stamp downgrade behavior (decide + pin) (P1, foundation correctness).

---

## 7. Notes for the next reviewer / wave-2 author

- The foundation slices (S6/S13/S14) ship many helpers that downstream slices CONSUME. The audit prioritized "is the helper's contract pinned + correct" over "is every downstream call site using the helper correctly". The latter belongs in S1-S15 audits and is partially called out in Section 3 (cross-slice gaps).
- The "manifest-vs-implementation drift" failure mode (LESSONS_LEARNED guardrail #2) is the dominant risk. S13-G1 and S6-G1 both attack this; both should ship.
- The hard-refusal contract for `newPlanApprovalId` is **explicitly deferred** by the test file. The defer was likely correct at write time (test-mock complexity) but the security boundary justifies the cost now. Either ship the test with vitest module-mock, or refactor `newPlanApprovalId` to accept an injectable RNG.
- The turn-limit watchdog deferral is the single biggest functional gap in S6. It is **acceptable** to defer for v1.0 IF the sidebar UI surfaces `rejectionCount` and the S4 injection emits a deescalation prompt at `rejectionCount >= 3`. Both need to be confirmed by S4 + S9 audits before signing off on the defer.

— A10 (relaunch), 2026-05-12

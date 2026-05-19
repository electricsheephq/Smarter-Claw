# Parity Refresh — Slice Audit D: prompt + injection cluster

**Auditor**: parity-refresh adversarial diff (prompt + injection cluster)
**Date**: 2026-05-19
**Scope**: slices S4 (planMode runtime context propagation), S5 (archetype prompt),
S8 (rejection UX / `[PLAN_DECISION]` injection).
**In-host source-of-truth**: branch `rebase/pr70071-onto-main-2026-04-25` @ `ea04ea52c7`
in `/Volumes/LEXAR/repos/openclaw-pr70071-rebase`.
**Post-surgical context**: PR #88 re-ported S4/S5 (system-prompt block + wired
`buildApprovedPlanInjection`/`buildAcceptEditsPlanInjection`); PR #86 re-ported
`approval.ts`; hotfix #93 wired the PLAN MODE AVAILABLE branch into `before_prompt_build`.

**Method**: byte-level diff. The three prompt artifacts were extracted and compared
char-for-char; the assembled `buildPlanModeActiveSystemContext()` / `…Available…()`
outputs were produced by *executing* the plugin TypeScript via `tsx` and diffed against
an in-host reconstruction (in-host `attempt.ts` array elements decoded with JS-string
semantics + the evaluated `PLAN_ARCHETYPE_PROMPT` / `PLAN_MODE_REFERENCE_CARD`).

---

## Per-file verdict

| Plugin file | In-host counterpart | Verdict |
|---|---|---|
| `src/prompt/plan-mode-injection.ts` | `attempt.ts:691-749` (inline block) | **clean** — assembled ACTIVE + AVAILABLE bytes byte-identical |
| `src/prompt/archetype-prompt.ts` | `plan-mode/plan-archetype-prompt.ts` | **clean** — byte-identical (5980-byte source, 5979-byte evaluated) |
| `src/prompt/reference-card.ts` | `plan-mode/reference-card.ts` | **clean** — byte-identical (100-element array literal) |
| `src/prompt/pending-injections.ts` | `plan-mode/injections.ts:347-360` | **clean** — `composePromptWithPendingInjections` byte-identical; stale `host_ref:` line numbers (D4) |
| `src/prompt/plan-decision-injection.ts` | `plan-mode/types.ts:185-209` | **drift** — function byte-identical but wired as a live emitter the in-host runtime never uses (D1); stale `host_ref:` (D4) |
| `src/runtime/injection-writer.ts` | `plan-mode/injections.ts` (write side) | **drift** — see D1, D3, D5 |
| `src/plan-mode/approval.ts` | `plan-mode/approval.ts` | **clean** — byte-identical (only the documented `./types.js`→`../types.js` import adaptation) |

**Severity counts**: P0 = 0, P1 = 3 (D1, D2, D3), P2 = 2 (D4, D5).

**Byte-level prompt drift**: NONE. All three system-prompt artifacts
(`plan-mode-injection.ts` ACTIVE + AVAILABLE, `archetype-prompt.ts`,
`reference-card.ts`) are confirmed byte-identical to the in-host. The prompt-cache key
is intact. The findings below are about injection *builders* and *wiring*, not the
cached system-prompt prefix.

---

## Findings table

| ID | Class | Sev | One-line |
|----|-------|-----|----------|
| D1 | parity-gap | P1 | `[PLAN_DECISION]: rejected` injection wired through `buildPlanDecisionInjection`; in-host runtime emits a different inline 2-line form |
| D2 | parity-gap | P1 | Approved-plan step lines append `status` enum; in-host appends `activeForm` gerund |
| D3 | test-gap | P1 | No byte-fixture test pins prompt artifacts against in-host bytes — only `.toContain()` + a 2000-byte-wide length window |
| D4 | parity-gap | P2 | `host_ref:` line numbers stale in `plan-decision-injection.ts` + `pending-injections.ts` |
| D5 | parity-gap | P2 | Plan-decision idempotency key includes `:${decision}`; in-host upserts by `approvalId` alone |

---

## Detailed analysis

### plan-mode-injection.ts — CLEAN (byte-identical assembled output)

`buildPlanModeActiveSystemContext()` assembles from sub-constants
(`PLAN_MODE_HEADER`, `PLAN_MODE_PREAMBLE`, `PLAN_MODE_ACTION_CONTRACT`,
`PLAN_MODE_INVESTIGATION_PHASE`, `PLAN_MODE_HARD_RULES`, `PLAN_MODE_SEPARATOR`,
`PLAN_ARCHETYPE_PROMPT`, `PLAN_MODE_REFERENCE_CARD`) joined with blank-line
separators. The in-host emits the equivalent as one inline array in
`attempt.ts:692-732`.

**Verification (executed, not eyeballed)**: the plugin's `buildPlanModeActiveSystemContext()`
was run via `tsx`; the in-host ACTIVE string was reconstructed by decoding the
`attempt.ts` array elements with JS-string-literal semantics and substituting the
*evaluated* archetype + reference-card constants. Result:

```
host_active  (evaluated) = 14332 bytes
plug_active             = 14332 bytes
BYTE-IDENTICAL: True
```

`buildPlanModeAvailableSystemContext()` likewise: in-host 979 bytes, plugin 979 bytes,
`diff` empty. The 29-char bottom rule on the AVAILABLE block (vs the ACTIVE block's
25-char separator) is correctly preserved — the inline comment at
`plan-mode-injection.ts:104` flags it explicitly.

The plugin's sub-constant split (kept "exposed for byte-level test pinning") does NOT
change output bytes: the embedded `""` inside `PLAN_MODE_ACTION_CONTRACT` (between
step 3 and the defect clause) reproduces the in-host array's `""` element at
`attempt.ts:701`; all other blank lines come from the assembler's interleaved `""`
entries, which match the in-host array structure 1:1.

**`before_prompt_build` wiring (`src/index.ts:563-590`)** — correct vs the in-host
branch logic with one documented divergence:

- In-host `attempt.ts`: `planMode === "plan"` → ACTIVE block; else if
  `planModeFeatureEnabled` (`config.agents.defaults.planMode.enabled === true`) →
  AVAILABLE block; else → `""` (nothing injected).
- Plugin: reads `snap?.mode`; `=== "plan"` → `buildPlanModeActiveSystemContext()`;
  otherwise **always** → `buildPlanModeAvailableSystemContext()`.

The plugin has no per-session feature flag — `register()` is gated on `config.enabled`
(`src/index.ts:170-177`), so "plugin installed + enabled" *is* the feature flag. The
plugin's "always inject AVAILABLE when not in plan mode" therefore corresponds exactly
to the in-host's "feature enabled" branch. The third in-host case (feature OFF →
`""`) is unreachable in the plugin because a disabled plugin registers no hook at all.
Hotfix #93's rationale comment at `index.ts:577-586` documents this. **Not a finding** —
the wiring is faithful to the in-host's two reachable branches.

The output goes through `appendSystemContext` (prompt-cached prefix) — the right
channel for cache-key stability, matching the intent of the in-host's
`planModeAppendPrompt` (prepended to `appendPrompt`, cached).

### archetype-prompt.ts — CLEAN (byte-identical)

`PLAN_ARCHETYPE_PROMPT` template literal extracted from both sources and `diff`'d:
identical, 5980-byte source on each side (5979 bytes evaluated — the source has 50
escaped backticks `` \` `` that evaluate to 50 literal backticks). Em-dash (U+2014) in
the header preserved; `≤` (U+2264), `≥` (U+2265), `↻`, `✓` all intact. The
plugin-only `buildPlanFilenameSlug` / `buildPlanFilename` helpers present in the
in-host file are NOT ported here — out of this cluster's scope (filename slug is a
persistence concern), no finding.

### reference-card.ts — CLEAN (byte-identical)

`PLAN_MODE_REFERENCE_CARD` is a 100-element string array `.join("\n")` on both sides.
Array-literal bodies extracted and `diff`'d: identical (6562-byte literal source on
each side). The box-drawing diagram (`┌ ┐ └ ┘ │ ─ ┬ ┴ ↻ ▼`), the 37-char bottom rule,
and the escaped grep patterns (`'\\[plan-mode/'`) all match byte-for-byte. Confirmed
transitively: the evaluated reference card is embedded in the byte-identical
`buildPlanModeActiveSystemContext()` output.

### pending-injections.ts — CLEAN (compose contract byte-identical)

`composePromptWithPendingInjections` is byte-identical to the in-host
`injections.ts:347-360`: empty-queue → `userPrompt` unchanged; whitespace-only user
prompt → `preamble` alone; otherwise `${preamble}\n\n${trimmedUser}` with entries
joined `\n\n`. The brief notes this is a "parity-reference function" (host owns the
real drain) — correct: the plugin re-exports the type contract
(`PendingAgentInjectionEntry`, `PendingAgentInjectionKind`,
`DEFAULT_INJECTION_PRIORITY`, `MAX_QUEUE_SIZE`) and the read-side composer; the host's
`enqueueNextTurnInjection` SDK seam owns steps 1-4 of the drain. `DEFAULT_INJECTION_PRIORITY`
values (`plan_decision:10` … `plan_nudge:1`) and `MAX_QUEUE_SIZE = 10` match the
in-host `injections.ts:52-66`. See D4 for stale `host_ref:` line numbers.

### plan-decision-injection.ts — DRIFT (see D1, D4)

`buildPlanDecisionInjection(decision, feedback, rejectionCount)` is **byte-identical**
to the in-host `types.ts:185-209` function: same one-line opener, same
`feedback: ${JSON.stringify(sanitizeFeedbackForInjection(feedback))}` line, same
"Revise your plan based on the feedback and call update_plan again." line, same
`rejectionCount >= 3` deescalation hint, same `expired`/`timed_out` resume text. The
`sanitizeFeedbackForInjection` helper (`src/helpers/sanitize.ts`) byte-matches the
in-host inline function at `types.ts:158-160` (`/\[\/PLAN_DECISION\]/gi` → ZWSP form).
The plugin-only `buildPlanApprovedDecisionLine` / `buildPlanEditedDecisionLine`
one-liners are documented fallbacks. Function-level parity is intact — the drift is in
*how it is wired* (D1).

### injection-writer.ts — DRIFT (see D1, D3, D5)

The WRITE-side adapters over the SDK seam `api.session.workflow.enqueueNextTurnInjection`.
`enqueuePlanApprovedInjection` (the approve/edit emitter) and
`enqueuePlanDecisionInjection` (the reject/timeout emitter) are sound SDK adaptations
of the in-host's direct `appendToInjectionQueue` writes — except the reject path emits
a different injection (D1) and the idempotency key diverges (D5).

### approval.ts — CLEAN (byte-identical)

`resolvePlanApproval`, `buildApprovedPlanInjection`, `buildAcceptEditsPlanInjection`,
`DEFAULT_APPROVAL_CONFIG`, `SUBAGENT_SETTLE_GRACE_MS`,
`MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE` are byte-identical to the in-host
`plan-mode/approval.ts`. The only delta is the documented `./types.js` → `../types.js`
import-path adaptation. The state-machine guards (stale-`approvalId` fail-closed,
terminal-state guard, no-token "none" defense), the approve/edit `rejectionCount: 0` +
`feedback: undefined` reset, and the reject `rejectionCount + 1` are all faithful.
`buildApprovedPlanInjection` / `buildAcceptEditsPlanInjection` strings match the
in-host char-for-char (verified incl. the `≥95%` figure and the 3 hard-constraints
block). No findings in this file itself — but see D2: the *callers* in
`session-actions.ts` feed these builders mis-formatted step lines.

---

## Finding details

### D1 — `[PLAN_DECISION]: rejected` injection diverges from the in-host runtime — parity-gap, P1

**In-host**: `src/gateway/sessions-patch.ts:1043-1056`
**Plugin**: `src/ui/session-actions.ts:412-418` → `src/runtime/injection-writer.ts:61-97`
→ `src/prompt/plan-decision-injection.ts:47-73`

The in-host runtime — the code that actually fires when a user rejects a plan via
`sessions.patch { planApproval: "reject" }` — builds the reject injection **inline**:

```js
// sessions-patch.ts:1045-1050
const safeFeedback = (feedback ?? "")
  .replace(/@(channel|here|everyone)\b/gi, "@\u{FE6B}$1")
  .replace(/<@/g, "<\u{200B}@");
const rejectText = safeFeedback
  ? `[PLAN_DECISION]: rejected\nfeedback: ${safeFeedback}`
  : `[PLAN_DECISION]: rejected`;
```

The in-host runtime reject injection is **at most 2 lines**:
`[PLAN_DECISION]: rejected` + (optionally) `feedback: <raw text>`. The feedback is
sanitized with **mention-stripping** (`@channel`/`@here`/`@everyone` → `@﹫…`,
`<@` → `<​@`) and is **not** JSON-quoted.

`buildPlanDecisionInjection` (in-host `types.ts:185`) **exists** but has **zero
non-test callers** in the in-host tree — `git grep` over `src/` (excluding `*.test.*`)
finds only the definition (`types.ts:185`) and the barrel re-export
(`plan-mode/index.ts:2`). It is a test-only / latent function. The in-host
runtime does not use it.

The plugin ports `buildPlanDecisionInjection` byte-faithfully (correct, it is a named
parity target) **and then wires it as the live reject emitter**. The plugin's runtime
`[PLAN_DECISION]: rejected` injection therefore differs from the in-host's in three
observable ways:

1. **Extra instruction lines** — the plugin appends
   `Revise your plan based on the feedback and call update_plan again.` and (at
   `rejectionCount >= 3`) the `Multiple revisions have been rejected…` deescalation
   hint. The in-host runtime emits neither.
2. **Feedback encoding** — plugin: `feedback: "looks wrong"` (JSON-quoted, with
   surrounding double-quotes, `[/PLAN_DECISION]`→ZWSP sanitized). In-host runtime:
   `feedback: looks wrong` (raw, unquoted, mention-stripped).
3. **Sanitization domain** — plugin neutralizes the envelope-closing tag; in-host
   runtime neutralizes chat-platform mentions. Neither applies the other's sanitizer,
   so an adversarial feedback string is differently (and incompletely) defended on
   each side.

**Why this is P1 not P2**: the `[PLAN_DECISION]:` injection is a synthetic message the
agent reads verbatim at the top of its next turn; its bytes steer behavior. A plugin
that emits a different reject injection than the in-host is, by the audit's mandate, a
parity break — and the `feedback:` line difference is directly user-visible in the
agent's context. It is not P0 because both forms are individually well-formed and the
plugin's variant is arguably *better* (the revise steer + deescalation hint are
useful). The brief's note that `buildPlanDecisionInjection` is a parity target is
satisfied at the *function* level; the gap is that the in-host runtime emitter is
`sessions-patch.ts`, not that function.

**Recommended resolution** — pick ONE and document it:
- (a) **True parity**: change `enqueuePlanDecisionInjection`'s reject branch to emit
  the in-host runtime's 2-line inline form (incl. the `@channel`/`<@` mention-strip),
  and keep `buildPlanDecisionInjection` as a parity-pinned-but-unused mirror of
  `types.ts` (matching its in-host latent status). OR
- (b) **Documented intentional upgrade**: keep `buildPlanDecisionInjection` as the live
  emitter but add a `host_ref:` + a `PARITY NOTE` stating the plugin deliberately uses
  the richer (test-covered) `types.ts` form rather than the in-host runtime's thinner
  inline form, and ALSO add the mention-stripping so the chat-safety property is not
  lost on Telegram/Slack channels. (b) is the better product outcome; (a) is stricter
  parity. Either is acceptable — silent divergence is not.

### D2 — Approved-plan step lines append `status`, not `activeForm` — parity-gap, P1

**In-host**: `src/gateway/sessions-patch.ts:1002-1004`
**Plugin**: `src/ui/session-actions.ts:69-79` (`planStepsToInjectionLines`)

When a plan is approved, the in-host builds the per-step lines that feed
`buildApprovedPlanInjection` / `buildAcceptEditsPlanInjection` like this:

```js
// sessions-patch.ts:1002-1004
const approvedSteps = (next.planMode?.lastPlanSteps ?? []).map((step) =>
  step.activeForm ? `${step.step} (${step.activeForm})` : step.step,
);
```

The parenthetical carries **`activeForm`** — the gerund/progress phrasing
(e.g. `Run migration (Running migration)`), present iff `activeForm` is set.

The plugin's `planStepsToInjectionLines` does:

```js
// session-actions.ts:69-79
return steps.map((s) => {
  if (s.status === "pending") return s.step;
  return `${s.step} (${s.status})`;
});
```

The parenthetical carries **`status`** — the status enum
(e.g. `Run migration (in_progress)`), present iff `status !== "pending"`.

The plugin's own inline comment (`session-actions.ts:71-73`) claims *"Match in-host's
per-step format"* — but it does not. The in-host appends the gerund description; the
plugin appends the status string. Different field, different gating condition.

The plugin's `PlanStep` type (`src/types.ts:85-89`) has **both** `status: string` and
`activeForm?: string`, and the in-host `lastPlanSteps[]` shape
(`config/sessions/types.ts:334-340`) has the same `step` / `status` / `activeForm?`
trio — so the data is available on both sides. The plugin simply reads the wrong field.

**Impact**: the step list inside the `[PLAN_DECISION]: approved` (and `: edited`)
injection — the concrete plan the agent executes from — has different bytes than the
in-host emits. For a fresh plan (all steps `pending`, no `activeForm`) the outputs
coincide (both emit bare `step`), which is why existing tests pass. They diverge for
any partially-started plan (a resumed cycle, a re-approval after revision).

**Recommended resolution**: change `planStepsToInjectionLines` to
`s.activeForm ? \`${s.step} (${s.activeForm})\` : s.step` and correct the misleading
comment. Add a test with a step carrying `activeForm` so the regression is pinned.

### D3 — No byte-fixture test pins prompt artifacts against in-host bytes — test-gap, P1

**Plugin**: `tests/prompt/plan-mode-injection.test.ts`,
`tests/prompt/reference-card.test.ts`, `tests/parity/parity-harness.test.ts`

The cluster's docstrings advertise byte-identity enforcement that does not exist:

- `archetype-prompt.ts:18-20`: *"Tests assert byte-identical match against the in-host
  source (parity-harness Layer 1 extension at
  `tests/parity/archetype-prompt-parity.test.ts`)."* — **that file does not exist.**
- `plan-mode-injection.ts:36-40`: refers to a "parity-harness Layer-1 diff" catching
  drift in the system-prompt block.

The actual parity harness (`tests/parity/parity-harness.test.ts` →
`parity-harness/diff.ts`) runs `inputs/persistApprovalRequest.json` — it tests the
`PlanModeStore` state machine, **not** any prompt string.

Every prompt-string test is a substring `.toContain()` assertion or a wide length
window:

- `plan-mode-injection.test.ts` — all `.toContain()` / ordering `indexOf` checks. The
  closest thing to a byte pin, *"byte count is stable (regression sentinel)"*
  (line 239-246), only asserts `length > 4000 && length < 6000` — a **2000-byte**
  tolerance window. A paraphrase, an added sentence, or whitespace drift of up to
  ~1000 bytes passes.
- `reference-card.test.ts` — `.toContain()` for sections/tags/commands; `length > 1000`;
  `.toBe(PLAN_MODE_REFERENCE_CARD)` against *itself* (tautology, line 69).
- `plan-decision-injection.test.ts` — phrase `.toMatch()` only.

None of these would catch the byte drift this cluster is explicitly chartered to
prevent (cache-bust). Today the artifacts *are* byte-identical (verified in this
audit), so the gap is latent — but the test suite gives a false sense of protection: a
future paraphrase in `archetype-prompt.ts` would ship green.

**Recommended resolution**: add a real fixture test. Either (a) commit the three
in-host strings as fixtures under `tests/prompt/__fixtures__/` (snapshotted from
branch `rebase/pr70071-onto-main-2026-04-25` @ `ea04ea52c7`) and `expect(actual).toBe(fixture)`,
or (b) extend the parity harness with a Layer-1 prompt diff that reads the in-host
files directly (the harness already knows the in-host path). Tighten the
`byte count is stable` sentinel to an exact `===` once a fixture exists. Create the
`archetype-prompt-parity.test.ts` the docstring promises, or delete the docstring
claim.

### D4 — Stale `host_ref:` line numbers — parity-gap, P2

**Plugin**: `src/prompt/plan-decision-injection.ts:6`,
`src/prompt/pending-injections.ts` (multiple)

The `host_ref:` citations have drifted from the in-host at `ea04ea52c7`:

- `plan-decision-injection.ts:6` cites `types.ts:172-209` for `buildPlanDecisionInjection`.
  Actual: the function declaration is at `types.ts:185`; the docstring begins ~`:166`.
  The `:172-209` range is approximately right but the headline number (`172`) is off.
- `plan-decision-injection.ts:5` (and the test header) also cite `types.ts:172-209`.
- `pending-injections.ts:5-7` cites `injections.ts:43-103` for a port of
  `appendPendingAgentInjection`. **There is no function named
  `appendPendingAgentInjection`** in the in-host `injections.ts` — the writers are
  `enqueuePendingAgentInjection` (`:209`), `appendToInjectionQueue` (`:183`),
  `upsertIntoQueue` (`:159`). The `:43-103` range covers the priority table +
  migration helper, not those writers.
- `pending-injections.ts:111` cites `injections.ts:347-360` for
  `composePromptWithPendingInjections` — **correct** (`:347` is the declaration).
- `sanitize.ts` cites `types.ts:158-160` for `sanitizeFeedbackForInjection` —
  **correct** (`:158`).

These are documentation-accuracy defects, not behavioral — hence P2. But they actively
mislead the next porter (e.g. someone looking for `appendPendingAgentInjection` will
not find it). Recommended: re-derive every `host_ref:` against `ea04ea52c7` and pin the
function name, not just a line range.

### D5 — Plan-decision idempotency key includes `:${decision}` — parity-gap, P2

**In-host**: `src/gateway/sessions-patch.ts:1011-1016, 1051-1056`
**Plugin**: `src/runtime/injection-writer.ts:78, 153`

The in-host queue-entry id for a plan decision is `plan-decision-${approvalId}` — the
decision string is **not** part of the key. Because `appendToInjectionQueue` upserts by
`id`, an approve-then-reject (or reject-then-approve) on the **same** `approvalId`
**replaces** the earlier entry — last write wins, one entry drains.

The plugin's idempotency key is `smarter-claw:plan_decision:${approvalId}:${decision}`
— the decision string **is** part of the key. So approve and reject on the same
`approvalId` become **two distinct entries**; both survive to drain time and the agent
sees both, relying on drain-order recency to pick the winner.

The plugin documents this explicitly (`injection-writer.ts:31-40, 55-57`) as an
intentional choice ("Approve-then-reject races become two distinct enqueues … the
later one wins by drain-time recency"). It is a defensible SDK-seam adaptation — the
host's `idempotencyKey` is per-plugin-per-session and the plugin cannot reach the
host's raw `id`-upsert. But it is still a behavioral divergence from the in-host's
upsert-by-`approvalId` semantics, and on a genuine approve/reject race the agent gets
two `[PLAN_DECISION]:` lines instead of one. P2 because the race window is narrow and
the docstring owns the decision; flagged so it is a *known* divergence, not a silent
one. Recommended: keep, but cross-reference D1's resolution — if the reject path is
re-aligned, revisit whether the `:${decision}` suffix should stay.

---

## Cross-cutting note — `buildPlanDecisionInjection` is a latent in-host function

D1 and D3 share a root cause worth stating once. `buildPlanDecisionInjection`
(in-host `types.ts:185`) is **defined and tested but never called by in-host runtime
code**. The in-host runtime reject path (`sessions-patch.ts`) re-implements the
2-line form inline. The plugin port treated `buildPlanDecisionInjection` as the
source-of-truth for the reject injection — a reasonable assumption from the function's
name and its presence in `approval.test.ts`, but the *runtime* source-of-truth is
`sessions-patch.ts`. When re-porting an injection, verify the **runtime caller**, not
just the most plausibly-named builder. (This mirrors MEMORY's
`feedback_wire_as_you_go` / `code-as-ground-truth` lessons: the live emitter is the
contract.)

---

## Verdict summary

The **system-prompt prefix is byte-clean** — `plan-mode-injection.ts` (ACTIVE +
AVAILABLE), `archetype-prompt.ts`, and `reference-card.ts` are all confirmed
byte-identical to the in-host at `ea04ea52c7`. The prompt-cache key is not at risk.
`approval.ts` and `composePromptWithPendingInjections` are likewise byte-identical.

The real exposure is in the **injection builders + their wiring**: the live reject
injection (D1) and the approved-plan step formatting (D2) diverge from the in-host
*runtime* emitter, and the test suite does not actually pin prompt bytes against the
in-host (D3) despite docstrings claiming it does. None are P0 — no crash, no data loss,
both prompt variants well-formed — but D1/D2 produce observably different agent-facing
bytes for the reject and resumed-plan paths, and D3 leaves the cluster's core
parity guarantee unenforced.

# Wave-1 Audit — S4 + S5: planMode runtime context, archetype injection, ask_user_question, pending-injections

**Auditor:** A6 (read-only)
**Date:** 2026-05-12
**Scope:** Slices S4 (`before_prompt_build` hook + archetype injection) and S5 (Plan archetype + `ask_user_question` + auto-mode toggle)
**Method:** Read-only diff of plugin ports vs in-host source-of-truth (`/Volumes/LEXAR/repos/openclaw-pr70071-rebase`)

---

## 1. Slice summary

### S4 — `before_prompt_build` hook + plan-mode archetype injection

The in-host injects an inline ~50-line block directly into the system prompt at `src/agents/pi-embedded-runner/run/attempt.ts:702-732` when `params.planMode === "plan"`. The block has FOUR parts:

1. `═══ PLAN MODE ACTIVE ═══` header
2. An "ACTION CONTRACT" block (5 short paragraphs, ~10 lines)
3. `PLAN_ARCHETYPE_PROMPT` (~120 lines, decision-completeness standard)
4. `PLAN_MODE_REFERENCE_CARD` (~85 lines, state diagram + tool contract + tag taxonomy)

When `planMode !== "plan"` but the operator has `agents.defaults.planMode.enabled === true`, the in-host emits a DIFFERENT block: `═══ PLAN MODE AVAILABLE ═══` (~12 lines) instructing the agent to call `enter_plan_mode` for planning workflows.

**Plugin ports:**
- `src/prompt/archetype-prompt.ts` — verbatim port of `PLAN_ARCHETYPE_PROMPT` (byte-clean diff).
- `src/prompt/reference-card.ts` — verbatim port of `PLAN_MODE_REFERENCE_CARD` (byte-clean diff).
- `src/prompt/plan-mode-injection.ts` — `buildPlanModeSystemContext()` composer, mounts header + hard-rules + separator + archetype + reference-card.

**Hook wiring (`src/index.ts:512-525`):**
```ts
api.on("before_prompt_build", async (_event, ctx) => {
  if (!ctx.sessionKey) return undefined;
  const snap = await store.readSnapshot(ctx.sessionKey);
  const mode: PlanMode = snap?.mode ?? "normal";
  if (mode !== "plan") return undefined;
  return { appendSystemContext: buildPlanModeSystemContext() };
});
```

### S5 — Plan archetype + `ask_user_question` + auto mode

**Plugin ports:**
- `src/tools/ask-user-question.ts` — TypeBox schema + execute() with input validation, returns `{status, questionId, question, options, allowFreetext}` details.
- `src/prompt/pending-injections.ts` — drain-side compose contract + types + `DEFAULT_INJECTION_PRIORITY` table + `MAX_QUEUE_SIZE = 10`.
- `src/prompt/reference-card.ts` (same file as S4 — overlaps).

**Plugin tests:** 17 (S4 injection composer) + 8 (reference card) + 10 (pending injections) + 16 (ask_user_question) = **51 cases**.

**Auto-mode (`/plan auto on|off`)**: documented in the reference card as a slash command but is otherwise NOT ported. The in-host's `auto-enable.ts` (regex-pattern matching against model id for auto-activation at session start, plus malformed-pattern defense-in-depth) is **not present in the plugin tree at all**.

---

## 2. Byte-identical contract — what bytes must remain stable?

The agent reads these prompt fragments verbatim, and bytes hash into the prompt-cache prefix key. A single byte of drift across a turn busts the prefix cache and pays full prefix re-evaluation cost on every plan-mode turn.

**Stable surfaces:**
- `PLAN_ARCHETYPE_PROMPT` (~120 lines / ~4700 bytes) — `src/prompt/archetype-prompt.ts`
- `PLAN_MODE_REFERENCE_CARD` (~85 lines, joined from string array via `\n`) — `src/prompt/reference-card.ts`
- `PLAN_MODE_HEADER` = `═══ PLAN MODE ACTIVE ═══`
- `PLAN_MODE_HARD_RULES` (5-line block, exact wording pinned)
- `PLAN_MODE_SEPARATOR` = `═════════════════════════` (exactly 25 box-drawing chars)

**Drift hot-spots (high cache-bust risk):**
- Em-dash `—` (U+2014) vs hyphen `-` — used in headers, bullets, mid-sentence.
- Box-drawing chars `═` `┌` `┐` `└` `┘` `│` `├` `▼` (U+2500–U+257F) in state diagram.
- Smart-quote unicode `'` `"` vs ASCII `'` `"`.
- Trailing whitespace per line (template-literal-format-on-save can strip).
- Final newline on `PLAN_ARCHETYPE_PROMPT` — the in-host template literal ends with backtick at column 0 on its own line, so a single trailing `\n` exists. The plugin port preserves this.

**How drift is tested today:**

The plugin's coverage is **structural / spot-check only**, not byte-equality:
- `plan-mode-injection.test.ts:50-79` ("byte stability") only checks: `buildPlanModeSystemContext()` is idempotent across two calls, header bytes match, separator bytes match, hard-rules line-count + per-line `.toMatch(/regex/)`. It does NOT pin the full archetype byte-string.
- `plan-mode-injection.test.ts:81-146` ("PLAN_ARCHETYPE_PROMPT byte-parity") pins headings (`### Primary objective`, `### Quality bar`, `### Anti-patterns`), required-field bullets, em-dash sentinel, and a length bucket `[4000, 6000]` — but NOT the full string.
- `reference-card.test.ts` similarly does fuzzy section checks + tag/command lists + em-dash sentinel + a final-line `.toMatch(/═════════════════════════════════════\s*$/)` — does NOT pin the full byte sequence.

**Critical gap:** **There is no byte-equality test of either fragment against the in-host source-of-truth.** The plugin tests prove "we still have headings + em-dashes + the bottom rule" but allow paraphrasing inside paragraphs, reordering bullets within a section, and inserting blank lines without test failure.

The `parity-harness` at `parity-harness/diff.ts` is Layer 1 (`persistApprovalRequest`) only — there is **no Layer 2 covering archetype-prompt or reference-card byte-parity against the in-host file**, despite the explicit doc-comment claim in `archetype-prompt.ts:18-20` ("Tests assert byte-identical match against the in-host source (parity-harness Layer 1 extension at tests/parity/archetype-prompt-parity.test.ts)" — **that file does not exist**).

---

## 3. Test coverage matrix

| Contract surface | In-host test exists? | Plugin test exists? | Byte-equality? |
|---|---|---|---|
| `PLAN_ARCHETYPE_PROMPT` headings | yes (`plan-archetype-prompt.test.ts`) | yes (`plan-mode-injection.test.ts:86-145`) | NO |
| `PLAN_ARCHETYPE_PROMPT` full bytes vs in-host | n/a (canonical) | NO | NO |
| `PLAN_MODE_REFERENCE_CARD` sections | n/a (no `reference-card.test.ts` in-host) | yes (`reference-card.test.ts`) | NO |
| `PLAN_MODE_REFERENCE_CARD` full bytes vs in-host | n/a (canonical) | NO | NO |
| `PLAN_MODE_HEADER` exact bytes | implicit in attempt.ts | yes (`plan-mode-injection.test.ts:58-62`) | YES (pinned) |
| `PLAN_MODE_SEPARATOR` exact bytes | implicit in attempt.ts | yes (`plan-mode-injection.test.ts:64-68`) | YES (pinned) |
| `PLAN_MODE_HARD_RULES` exact bytes | implicit in attempt.ts | yes (`plan-mode-injection.test.ts:70-78`) | regex-pinned only |
| `PLAN MODE ACTIVE` ordering header → rules → archetype → ref-card | yes (implicit) | yes (`plan-mode-injection.test.ts:37-47`) | YES (substring index order) |
| **`PLAN MODE AVAILABLE` branch (`enabled && mode !== "plan"`)** | yes (inline in attempt.ts) | **NO** | NO |
| `ACTION CONTRACT` block (5 paragraphs above "Hard rules") | yes (inline in attempt.ts) | **NO** | NO |
| `composePromptWithPendingInjections` empty queue | yes (in-host `injections.test.ts:198`) | yes (`pending-injections.test.ts:32-36`) | YES |
| `composePromptWithPendingInjections` multi-entry join | yes | yes (`pending-injections.test.ts:59-67`) | YES |
| `composePromptWithPendingInjections` empty user prompt | yes | yes | YES |
| `composePromptWithPendingInjections` whitespace user prompt | yes | yes | YES |
| `composePromptWithPendingInjections` preserves preamble bytes | n/a | yes (`pending-injections.test.ts:76`) | YES |
| `sortAndCapQueue` priority-DESC ordering | yes (in-host `injections.test.ts:117`) | **NO** | n/a |
| `sortAndCapQueue` createdAt-ASC tiebreaker | yes (in-host) | **NO** | n/a |
| `sortAndCapQueue` `id.localeCompare` deterministic tertiary | yes (in-host `injections.test.ts:179`) | **NO** | n/a |
| `sortAndCapQueue` cap at MAX_QUEUE_SIZE + warn log | yes (in-host `injections.test.ts:137`) | **NO** | n/a |
| `sortAndCapQueue` evicts NEWEST (not oldest!) | yes (in-host, comment :148) | **NO** | n/a |
| `MAX_QUEUE_SIZE = 10` constant | yes | yes (`pending-injections.test.ts:110`) | YES |
| `DEFAULT_INJECTION_PRIORITY` 6 kinds + ordering | yes | yes (`pending-injections.test.ts:86-108`) | YES |
| `enqueuePendingAgentInjection` (writer) | yes (in-host `injections.test.ts:299`) | **NO** (port omits writer) | n/a |
| `consumePendingAgentInjections` (drain) | yes | **NO** (port omits consumer) | n/a |
| `migrateLegacyPendingInjection` | yes (in-host `injections.test.ts:61`) | **NO** | n/a |
| `upsertIntoQueue` dedup-by-id | yes (in-host `injections.test.ts:92`) | **NO** | n/a |
| `filterExpired` | yes (in-host, via consume tests `injections.test.ts:358`) | **NO** | n/a |
| `ask_user_question` schema accept 2 options | yes | yes (`ask-user-question.test.ts:114`) | n/a |
| `ask_user_question` schema accept 6 options | yes (in-host `:58`) | NO (only "rejects >6" — boundary at 7) | n/a |
| `ask_user_question` schema reject 0 options | implicit (typebox) | NO (only "missing" case) | n/a |
| `ask_user_question` schema reject 1 option | yes (`:101`) | yes (`:71-74`) | n/a |
| `ask_user_question` schema reject 7 options | yes (`:110`) | yes (`:77`) | n/a |
| `ask_user_question` reject duplicate option text | yes | yes (`:87-94`) | n/a |
| `ask_user_question` trim option whitespace | yes | yes (`:96-110`) | n/a |
| `ask_user_question` filter empty options | yes | yes (`:96-110`, but via "trims" test) | n/a |
| `ask_user_question` reject empty question | yes | yes (`:48-52`) | n/a |
| `ask_user_question` reject whitespace-only question | yes | yes (`:54-61`) | n/a |
| `ask_user_question` `questionId = q-${toolCallId}` deterministic | yes | yes (`:152-168`) | YES |
| `ask_user_question` allowFreetext default false | implicit | yes (`:142-150`) | n/a |
| `ask_user_question` allowFreetext stored in details | implicit | yes (`:125-140`) | n/a |
| `ask_user_question` "Other..." flow / freetext value | NO (handled in subscribe-handler) | **NO** | n/a |
| `evaluateAutoEnableForMatch` happy path | yes (`auto-enable.test.ts`) | **NO** (auto-enable.ts NOT ported) | n/a |
| `evaluateAutoEnableForMatch` malformed regex | yes | **NO** | n/a |
| `before_prompt_build` returns `undefined` when mode !== "plan" | n/a | NO (paths exist but untested) | n/a |
| `before_prompt_build` returns `appendSystemContext` shape | n/a | NO (not exercised in tests; only `buildPlanModeSystemContext` itself) | n/a |
| `before_prompt_build` no-op when `sessionKey` undefined | n/a | NO | n/a |
| `before_prompt_build` reads via `store.readSnapshot` | n/a | NO | n/a |

**Net coverage:** 51 plugin tests cover the static prompt content + the compose function + the tool's input validation surface — but coverage of (a) the hook itself, (b) byte-equality vs in-host, (c) the writer side of pending-injections, (d) auto-enable matching, and (e) the `PLAN MODE AVAILABLE` branch is **absent**.

---

## 4. Testing gaps

### P0 (ship-blockers — drift surfaces or missing core paths)

1. **No byte-equality test of `PLAN_ARCHETYPE_PROMPT` vs the in-host file** — the doc-comment promises a parity-harness Layer 1 extension at `tests/parity/archetype-prompt-parity.test.ts`, but that file does not exist. A reviewer can paraphrase any paragraph inside the archetype and the test suite stays green; the prompt-cache silently busts on every plan-mode turn for every user.

2. **No byte-equality test of `PLAN_MODE_REFERENCE_CARD` vs the in-host file** — same drift surface as #1 but for the state-diagram unicode characters (`═` `┌` `┐` `│`...). Easy to corrupt via terminal copy-paste, font substitution, or an "improved" editor's whitespace-trim. No test catches this.

3. **`buildPlanModeSystemContext()` omits the "ACTION CONTRACT" block** — in-host `attempt.ts:692-701` injects a 5-paragraph "ACTION CONTRACT" between the header and the hard rules (covers: 1-sentence acknowledgement, call `exit_plan_mode` same turn, stop after tool call, treat ack-without-tool-call as defect, investigation phase guidance for LOGS, ask_user_question guidance). **The plugin's `buildPlanModeSystemContext()` skips it entirely.** This is a major byte-diff vs the in-host's prompt, and would degrade the steering quality the in-host wired (specifically the LOGS guidance and the "ack-without-tool-call = defect" framing).

4. **`PLAN MODE AVAILABLE` branch is not ported at all** — when `agents.defaults.planMode.enabled === true` but the session is in normal mode, the in-host injects a ~12-line "PLAN MODE AVAILABLE" block instructing the agent to call `enter_plan_mode`. The plugin's hook returns `undefined` in that case, so the agent never gets the discovery prompt and is more likely to miss the plan-mode entry point on fresh installs. No test catches this because no plugin file mentions "AVAILABLE".

5. **`auto-enable.ts` (regex-pattern auto-toggle on model id) is not ported** — the in-host has 96 lines + 5 test groups (empty/invalid, happy path, malformed patterns, compiled-cache stability) for auto-enabling plan mode when the resolved model id matches a config-driven regex. The plugin tree has zero implementation and zero tests. Per the user's CLAUDE.md, plan-mode auto-on for `^openai/gpt-5\.` (Eva uses GPT-5.4) was a key product affordance; without this port, the operator config knob is silently inert.

6. **Pending-injection writer side (`enqueue` / `consume` / `upsert` / `migrate` / `sortAndCapQueue`) is not in the plugin module at all** — the plugin's `pending-injections.ts` only ports the **read-side composer** plus the type table. There is NO `enqueuePendingAgentInjection`, NO `consumePendingAgentInjections`, NO `sortAndCapQueue`, NO `migrateLegacyPendingInjection`, NO `upsertIntoQueue`, NO `filterExpired`. These are the seams the host runtime uses to actually queue `[PLAN_DECISION]`, `[QUESTION_ANSWER]`, `[PLAN_COMPLETE]` into the next agent turn. If the plugin needs to deliver these (per the architecture-v2 catalog), this is a substantial behavioral gap. Tests are equally absent.

7. **The hook itself (`api.on("before_prompt_build", …)`) is untested** — the test suite exercises `buildPlanModeSystemContext()` in isolation, but never asserts: (a) hook returns `undefined` when `ctx.sessionKey` is missing; (b) hook returns `undefined` when `mode === "normal"`; (c) hook returns `{ appendSystemContext }` when `mode === "plan"`; (d) hook handles a `null` snapshot; (e) hook handles a snapshot with `mode === undefined` (default to "normal"); (f) integration with `store.readSnapshot` failure (rejected promise — should the hook crash the prompt build or no-op?). Manual reading shows the hook reads `snap?.mode ?? "normal"` so an undefined snapshot is fine, but no test pins that.

8. **`appendSystemContext` vs `prependContext` return-shape is never asserted** — if a future refactor flipped the return key from `appendSystemContext` to `prependContext`, the bytes would now sit in the per-turn token cost band instead of the prompt-cached prefix band. Cache hits collapse silently. No test catches this regression.

### P1 (substantive gaps)

9. **No test asserts that `before_prompt_build` returning `{ appendSystemContext, prependContext }` together is handled correctly by the host** — the plugin returns only `appendSystemContext`, but the SDK contract for both-fields-set is undocumented at the plugin layer. If the SDK ever silently picks one and drops the other, the plugin should pin which one wins.

10. **`composePromptWithPendingInjections` is NOT integrated with `before_prompt_build`** — the plugin's hook only emits the static archetype via `appendSystemContext`. The in-host runtime drains the pending-injection queue and PRE-PENDS the composed text to the user prompt. The plugin currently has no path between (a) "`[QUESTION_ANSWER]: …` got queued by the runtime intercept" and (b) "the next turn's user prompt has the injection prepended". The `composePromptWithPendingInjections` function exists but has no callers. The integration test is missing.

11. **`ask_user_question` "Other..." / freetext payload validation is untested** — the schema accepts `allowFreetext: boolean`, the tool stores it in details, but no test exercises what happens when the user types a freetext answer that arrives via `/plan answer <text>`. The runtime intercept reads `allowFreetext` and either accepts the typed answer or coerces to a labeled option — that contract is invisible to the plugin tests.

12. **`ask_user_question` zero-option array reject is implicit (typebox `minItems: 2`)** — the JS path also rejects on `options.length < 2`, but no test asserts what error the user sees when `options: []`. The typebox layer may short-circuit before reaching the readable error string; the test should pin that the agent gets a usable message.

13. **`ask_user_question` very-long option text is unbounded** — there is NO upper length check on option text. A 100KB option string would pass the typebox + execute() validation and break the UI / message channel limits (Telegram caption is 1024 chars). No test asserts a sane upper bound.

14. **`ask_user_question` very-long question text is unbounded** — same as #13 for the `question` field. The displaySummary description in the in-host says "one or two short sentences" but nothing enforces it. A multi-page question would silently render to a single approval card.

15. **`ask_user_question` non-string option entries are filtered silently** — `rawOptions.filter((entry): entry is string => typeof entry === "string")` drops numbers/null/booleans without warning. The 3-option array `["yes", 42, "no"]` becomes a 2-option array. This is permissive on bad agent output but masks a bug. No test pins the silent-filter behavior.

16. **`ask_user_question` empty-string filtering happens AFTER `< 2` check** — the test at `:96-110` shows `["  opt 1  ", "opt 2", "", "   "]` succeeds with 2 options. But the order of operations means a payload like `["a", ""]` is rejected by `< 2` check (raw length is 2, but after filter/trim only 1 remains, falling under the `< 2` post-filter check). Test exists for `["yes", "", "  "]` but not for the 2→1 transition with non-trivial first option.

17. **`ask_user_question` schema `additionalProperties: false` is asserted, but the inner `Type.Array(Type.String())` allows any string-shaped entry**. There's no test asserting that nested non-string types (e.g., `options: [{label: "a"}, "b"]`) get rejected with a readable error.

18. **No "AVAILABLE branch" test parallel to the "PLAN MODE ACTIVE" block tests** — even if the AVAILABLE branch is intentionally not ported (defensible — Smarter-Claw is the plugin and the host's default is "no plan mode"), there should be a TEST asserting that decision. Otherwise, when someone adds AVAILABLE branch later, the regression of "now it fires twice" is invisible.

19. **No test that `buildPlanModeSystemContext()` output contains NO trailing whitespace per line** — a single trailing space on any line bumps the cache. Easy regression target for editors that auto-format on save.

20. **No test that the joined output of `[header, "", rules, "", separator, "", archetype, "", reference-card].join("\n")` matches a stable byte-count or hash snapshot** — current tests only check substring presence + ordering. A `__snapshot__` or `expect(s.length).toBe(EXACT_LENGTH)` assertion would catch all silent drift in one line.

### P2 (defensive / nice-to-have)

21. **No integration test that the S4 hook + S5 compose run together inside a single before_prompt_build cycle** — see Integration gaps #1 below.

22. **No test that the in-host's `attempt.ts:711` "calling them wastes a turn" wording is preserved character-for-character** — the rules block is the most stable byte-band in the active-mode prompt; current tests use `.toMatch(/regex/)` not `.toBe(string)`.

23. **`buildPlanModeSystemContext()` lacks an "expected output" snapshot test** — a single `expect(buildPlanModeSystemContext()).toMatchInlineSnapshot(…)` pins every byte. Cheap to add; catches everything in P0-P1 #1, #2, #19, #20 in one assertion.

24. **No tests for subagent propagation** — see Integration gaps #4 below.

25. **No fuzz / property test on `composePromptWithPendingInjections`** — given the byte-stability requirement, a property-based test asserting `compose(es, userPrompt).startsWith(es.map(e=>e.text).join("\n\n"))` (when queue non-empty) would lock the prefix-cache hash regardless of unicode shenanigans in user prompts.

26. **No test that the pending-injection text content is NOT escaped/transformed by the composer** — the in-host test at `composePromptWithPendingInjections` line 220 trims user prompt only. The plugin's port test at `:76-82` asserts this. But there's no test for what happens when a pending entry's `text` contains `\r\n` (CRLF) — the composer just passes bytes through, but a CRLF in the prompt-cache prefix is a real cache-bust risk on Windows-origin transcripts.

---

## 5. Prompt-cache risk — drift surfaces

The in-host prompt-cache key hashes the entire system-prompt prefix (header + ACTION CONTRACT + hard rules + separator + archetype + reference-card). Any byte drift between the in-host and the plugin OR within the plugin's own outputs across two calls invalidates the cache and pays the full prefix re-evaluation cost on every plan-mode turn.

**Surfaces ranked by risk:**

1. **ACTION CONTRACT block omission (P0 #3)** — already a guaranteed 100% miss vs in-host. Plugin users see a strictly different prompt than in-host users. Cache hashes computed against the plugin-baseline are NOT portable to the in-host build.

2. **Em-dash drift `—` ↔ `-`** — `plan-mode-injection.test.ts:132-136` pins the header em-dash, but only in the header. Inside paragraph bodies (`Plan mode — currently active`, etc.) the em-dash is unpinned.

3. **Box-drawing chars in state diagram** — the reference card has ~40 lines of `═┌┐│└┘├─▼↻`. None are pinned to specific characters; only "contains 'NORMAL MODE'" sort of checks exist.

4. **Trailing newline at end of `PLAN_ARCHETYPE_PROMPT`** — the template literal ends with `re-evaluate.\n` (the newline is implicit before the closing backtick). The plugin port preserves this, but no test asserts `.endsWith("re-evaluate.\n")` byte-exactly. A trailing-whitespace-strip on save would silently drop the `\n`.

5. **Line endings (CRLF/LF)** — if a Windows contributor's editor saves with CRLF, the file's bytes change; the test suite still passes (toMatch is line-ending agnostic) but the prompt bytes drift. No test guards against this. (Recommendation: `.gitattributes` + a `not.toContain("\r")` assertion.)

6. **`PLAN_MODE_HARD_RULES.join("\n")` vs `"\n\n"` between lines** — the in-host inline block emits lines separated by `\n` (single newline). The plugin port uses `.join("\n")` (same). But there's no test asserting the SPECIFIC `\n` (vs `\r\n` or `\n\n`).

7. **`composePromptWithPendingInjections` join with `"\n\n"`** — pinned by `pending-injections.test.ts:38-43`. Stable.

8. **Reference-card final-line bottom-rule** — pinned by `reference-card.test.ts:77-80` via regex `═════════════════════════════════════\s*$`. The `\s*` allows trailing whitespace — a soft pin that's slightly weaker than `.endsWith("\n")` or no-trailing-whitespace assertion.

9. **JSON-key ordering in the queue entries** — when the in-host writes a `PendingAgentInjectionEntry` to disk JSON, the key order matters if the consumer parses + re-stringifies for cache purposes. The plugin port preserves the interface but doesn't pin key order in any persistence path (and the plugin doesn't ship the writer side anyway).

10. **`Map`/`Set` iteration order for `DEFAULT_INJECTION_PRIORITY`** — both in-host and plugin use a plain object `Record<string, number>`. Object-property iteration order is well-defined in modern JS for string keys (insertion order for non-integer keys). The test asserts `Object.keys(...).sort()` so it doesn't pin insertion order. If someone reorders keys at the source, the iteration order changes — but it doesn't affect the prompt-cache because only the lookup result matters, not the iteration. Low risk.

---

## 6. Integration gaps — S4 ↔ S5 ↔ `before_prompt_build`

1. **`buildPlanModeSystemContext()` and `composePromptWithPendingInjections()` are not composed** — when the session is in plan mode AND has a `[PLAN_DECISION]: approved` waiting in `pendingAgentInjections`, the in-host emits BOTH:
   - The static archetype prefix (cache-friendly, in system prompt)
   - The dynamic injection preamble (per-turn, in user prompt slot)

   The plugin's `before_prompt_build` returns only `{ appendSystemContext: buildPlanModeSystemContext() }`. There is no path that reads `pendingAgentInjections` from the session store and prepends the composed text to the user prompt. The hook signature for `before_prompt_build` may expose a `prependUserPrompt` or similar — but the plugin doesn't use it. **Result:** in-mode turns work (static archetype fires), but `[PLAN_DECISION]: approved` and `[QUESTION_ANSWER]: …` deliveries never reach the agent through this plugin's hooks. No test catches this because there's no test exercising the queue → hook → prompt path end-to-end.

2. **No test that S4 archetype injection happens for the same session where S5 queues an injection** — even if (1) were wired, a turn where BOTH paths fire simultaneously needs a regression test. The expected byte layout is `[system-prompt-prefix][buildPlanModeSystemContext()] [user-message-prefix][composePromptWithPendingInjections(queue, userPrompt)]`. Plugin tests cover each half in isolation.

3. **`ask_user_question` → `pendingAgentInjections` write seam is not in the plugin tree** — the in-host's `pi-embedded-subscribe.handlers.tools.ts:1965-2030` intercepts the tool result, emits a `kind:"plugin"` approval event, and (on user answer) enqueues `[QUESTION_ANSWER]: …` to `pendingAgentInjections`. The plugin ships the TOOL but not the intercept that wires `allowFreetext` + the user-answer round-trip. So `ask_user_question` ports as input-validation-only; the actual answer-delivery path is missing.

4. **Subagent propagation is untested and undocumented** — the in-host's `attempt.ts:702-732` injection is added to the PARENT agent's system prompt. When the parent calls `sessions_spawn(...)`, the spawned subagent's prompt is built independently. Does the plugin's `before_prompt_build` hook fire for subagents too? If yes — the subagent gets the full plan-mode archetype but is NOT bound by the plan-mode mutation gate (gates are session-scoped). If no — the subagent sees no plan-mode prompt and may not know it's investigating a plan. Either way, no test pins the chosen behavior and no docstring documents it.

5. **Hook ordering vs `before_agent_finalize` for escalating-retry** — both `before_prompt_build` (S4) and `before_agent_finalize` (the escalating-retry detector at `src/index.ts:479-510`) fire for the same session. The retry detector's `event.lastAssistantMessage` is the OUTPUT of a turn whose system prompt was set by S4. If the agent's reply is "chat-only" the retry triggers; but the retry's `instruction` is then prepended on the NEXT turn — and that next turn's `before_prompt_build` still emits the same static archetype. There is no test asserting that the retry instruction and the static archetype don't tangle (e.g., contradict each other, or one shadows the other).

6. **`PLAN MODE AVAILABLE` branch — not integrated at all (P0 #4)** — see test gap above. From the integration perspective, the plugin gives operators a binary on/off (plan mode active vs no archetype prompt) when the in-host has three states (active / available / disabled). The middle state is silently missing.

---

## 7. `ask_user_question` gaps — input validation + state isolation

1. **No upper bound on option text length** — see P1 #13. UI cap is 1024 chars (Telegram caption), no enforcement.
2. **No upper bound on question text length** — see P1 #14.
3. **No regex / character validation on options** — markdown special chars (`*`, `_`, `` ` ``, `[`, `]`) in option text could break the approval card render. Untested.
4. **No content-policy check** — an option text like `"DROP TABLE users"` is accepted verbatim. While this is the agent's output not user input, a malicious-prompt-injection scenario could exploit this. Out of scope but worth noting.
5. **`questionId` collision across sessions** — `questionId = q-${toolCallId}`. If the host's toolCallId is unique per session (likely) this is fine; but if two sessions call ask_user_question in the same gateway lifetime with the same toolCallId (e.g., from a deterministic test harness), the questionIds collide. No test pins toolCallId uniqueness assumption.
6. **`questionId` does NOT include sessionKey** — the questionId is only `q-${toolCallId}`. If the runtime intercept routes answers by questionId without sessionKey context, cross-session answer-routing is possible. The in-host's subscribe-handler likely scopes by sessionKey separately, but the plugin tool can't enforce that.
7. **No test for what happens when the same tool fires twice in one turn with the same toolCallId** — the questionId is identical, but is the second call a no-op? a duplicate-queue? an error? Behavior is undefined and untested.
8. **No test that `details.status === "invalid-input"` paths return a non-empty `content[0].text`** — the in-host's "lossless-claw paired-tool-result fix" mandates non-empty content. The plugin's invalid-input path returns `text: \`ask_user_question: \${err.message}\``. Tests check `(r.details as { status: string }).status` but not that `r.content[0].text.length > 0` for invalid-input. Minor.
9. **No test for `params.options` being a non-array but truthy** (e.g., `"yes,no"` string or `{0: "a", 1: "b"}` object). The current check `!Array.isArray(rawOptions)` catches it, but no test asserts the specific error message.
10. **No test for `params.allowFreetext` being a non-boolean** (e.g., `1` or `"true"`). The current code falls back to `false` silently. A test should pin "non-boolean → false (not throw)".
11. **In-host vs plugin: `question.trim()` is applied to BOTH the `details.question` field AND the user-facing text in the in-host (`ask-user-question-tool.ts:117, 123`). In the plugin, `readStringParam` already trims, so the local `question` variable is the trimmed version — but the plugin echoes it without re-trimming (which is fine because it's already trimmed). The byte-output of `details.question` should match in-host; pin with a test where the input has leading/trailing whitespace.**
12. **No test for the "Other..." free-form answer arriving back** — the runtime intercept layer that translates a user's freetext into a `[QUESTION_ANSWER]:` message is in the in-host (`pi-embedded-subscribe.handlers.tools.ts`), not in the plugin. The plugin tool can't test the round-trip.
13. **No test that the tool's `description` text is byte-stable** — `TOOL_DESCRIPTION` in `ask-user-question.ts:70-77` is the agent-visible description. Bytes hash into prompt-cache. Plugin test (`ask-user-question.test.ts:26-31`) only does `.toMatch(/2-6/)` style fuzzy checks. Drift from "2-6 option buttons" to "two-to-six option buttons" silently busts cache.

---

## 8. Confidence score

**Overall confidence: 55/100**

| Dimension | Score | Notes |
|---|---|---|
| Static byte content (archetype + reference-card text bytes) | 90/100 | Files byte-clean diff against in-host. Only the trailing newline / line-ending vectors are unpinned. |
| Byte-equality test discipline | 25/100 | Tests use `.toContain` / `.toMatch` regex / length-bucket; never byte-equal. The promised parity-harness file is absent. |
| `buildPlanModeSystemContext()` composition vs in-host | 40/100 | Missing the ACTION CONTRACT block entirely. Header + hard rules + archetype + reference-card port cleanly. |
| `composePromptWithPendingInjections` parity | 95/100 | Functional behavior matches in-host. Single-function port. Tests cover 7 cases. |
| Pending-injection writer side (enqueue/consume/sort/cap/migrate) | 0/100 | Not ported, not tested. |
| `ask_user_question` input validation parity | 80/100 | Schema + tool logic match. Missing upper-length bounds, freetext round-trip, content-policy edge cases. |
| Auto-mode (regex-pattern auto-enable) port | 0/100 | Not ported. Not tested. Per CLAUDE.md, was a key affordance. |
| `PLAN MODE AVAILABLE` branch | 0/100 | Not ported. Not tested. |
| `before_prompt_build` hook end-to-end test | 10/100 | Hook is wired in `index.ts` but never invoked by any plugin test. Cargo-cult shape, untested integration. |
| S4 ↔ S5 integration | 10/100 | The two halves exist in isolation. Composition end-to-end (queue → hook → user-prompt prepend) is undefined and untested. |
| Subagent propagation | 0/100 | Behavior is undocumented; no tests. |

**Bottom line:** The static content (archetype + reference-card) is faithfully byte-copied, but the discipline of testing it byte-equal is absent. The composition function omits the in-host's ACTION CONTRACT block, omits the AVAILABLE branch, and the writer side of the pending-injection queue is not in the plugin tree at all. Auto-enable is missing. The hook itself is untested. Confidence in "the plugin's plan-mode injection matches the in-host's behavior" is moderate-low.

**Priority recommendation for next wave:** Land the parity-harness Layer 2 (`tests/parity/archetype-prompt-parity.test.ts`, `tests/parity/reference-card-parity.test.ts`) with strict `.toBe(IN_HOST_SOURCE_FROM_FS_READ)` assertions; port the ACTION CONTRACT block into `buildPlanModeSystemContext()`; decide whether the AVAILABLE branch is in scope and either port-it-or-test-that-omission; port the queue writer/consumer/sort/cap helpers under `src/state/` (or `src/runtime/`) with the 11 in-host test groups copied across; port `auto-enable.ts` with its 5 test groups; add a `__snapshot__` test of `buildPlanModeSystemContext()` to catch any silent drift in a single assertion.

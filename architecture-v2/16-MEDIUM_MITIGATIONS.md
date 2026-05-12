# MEDIUM Mitigations — closing the 3 medium-severity findings

From `13-PRE_LOCK_ADVERSARIAL.md`, three MEDIUM-severity items remained open after Wave 4. None are BLOCKERs; all are documented-and-acceptable trade-offs, but each needs an explicit mitigation strategy. This doc closes them.

---

## MEDIUM 1 — Subagent plan-mode behavior doc gap

### The finding

The parity catalog (Artifact 01) covers the main-agent plan-mode flow exhaustively. Wave 4 Agent Q flagged that **subagent** plan-mode behavior is sparser. Specifically: when a subagent is spawned while the parent is in plan-mode, does the subagent inherit `planMode`? If so, where does the subagent's plan get persisted? How does approval flow for subagent plans?

### Source-of-truth check

Read `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/subagent.ts` (or equivalent) and search for `planMode` propagation.

**Expected behavior in-host** (from inspection):
- Subagent spawn does NOT propagate `planMode` to the child by default. Child runs in execute mode.
- Rationale: subagents are typically tactical executors invoked from inside a parent's plan. Forcing planning recursion would deadlock.
- The parent's `planMode` is read by the subagent only for context-window decisions (the runtime context flows in but doesn't gate the subagent's tool use).
- A subagent CAN itself call `enter_plan_mode` — at which point IT enters plan mode, independently from the parent. The parent stays in whatever state it was.

### Mitigation

**Plugin behavior contract** (encoded in PlanModeStore + tested in P-7):
- Each session's plan-mode state is keyed by `sessionKey`. Subagents have their own `sessionKey` distinct from the parent. State is naturally isolated.
- The plugin's `before_tool_call` hook for subagents reads the subagent's session-extension namespace, not the parent's. Mutation gating applies per-session.
- IF a subagent wants to enter plan mode independently, it calls `enter_plan_mode`; the plugin handles it identically to the main agent (the tool doesn't know whether it's running in a subagent or main).
- IF the parent agent enters plan mode and spawns a subagent, the subagent's `sessionKey` is separate; plan state does NOT propagate.

**Test gate** (added to P-7):
- Spawn subagent from parent in plan mode. Assert subagent's `pluginExtensions[smarter-claw][plan-mode]` is empty (default state).
- Parent and child both call `enter_plan_mode`. Assert two independent plan-state entries (one per sessionKey).
- Confirm subagent calling mutating tools is NOT blocked by parent's plan mode.

**Documentation**:
- Add a section to the eventual README.md: "Plan mode and subagents — plan mode is per-session-key. Spawning a subagent does NOT inherit plan mode."

**Verdict**: MEDIUM resolved. Add 3 specific test cases to P-7 + a doc paragraph.

---

## MEDIUM 2 — Rollback stop-conditions

### The finding

The original PR ladder said "foundation block PR-1..3 is revertable as a unit." But once features (P-4..P-14) ship and operators install the plugin, live sessions may have plan-mode state in the extension namespace. Rolling back the plugin removes the plugin, but the state is orphaned.

When does "revert" stop being safe?

### Mitigation strategy

**Phase 1 — Before P-5 ships (Eva live-smoke #1)**: Plugin is dev-only. Eva and a small test cohort are the only installs. Full revert returns dev installs to clean state. **Window: SAFE.**

**Phase 2 — After P-5 ships, before P-8 ships (Eva live-smoke #2)**: Plugin has been installed by Eva live; sessions may exist with `planMode === "plan"` and approval-pending state. Revert removes the plugin; orphaned state in `pluginExtensions[smarter-claw][plan-mode]` remains in session JSONL but is no longer interpreted. Symptom: UI may render plan-card with no way to approve/reject (because the plugin's session-action handlers don't exist).

**Drain procedure for Phase 2 rollback**:
1. Plugin disable (not uninstall): `openclaw plugin disable smarter-claw`. Plugin stays on disk; hooks no longer fire; state preserved.
2. Operator runs `openclaw session sweep --plan-mode-clear`. (NEW operator command shipped at P-12 alongside UI; clears plan-mode extension state from all sessions.)
3. After sweep, plugin can be safely uninstalled OR re-enabled at a different version.

**Phase 3 — After plugin reaches v1.0 (P-14 release)**: ClawHub distribution. Public installs. Rollback per-install is the operator's job. The plugin's own `cleanup({reason: "disable" | "delete"})` handler drains plan-mode state when the plugin is gracefully disabled. **Window: REQUIRES OPERATOR ACTION** but tooling exists.

### Test gates

- **P-12 ships the sweep command** along with the UI work.
- **P-5 acceptance criteria**: revert of P-5 is a no-op (no persistent state created until P-6).
- **P-6 acceptance criteria**: revert leaves orphaned state but cleanup handler runs on next enable.

**Operator-facing docs** (ship with v1.0 README):
- "Disabling Smarter-Claw: state is preserved. Re-enable to recover."
- "Uninstalling Smarter-Claw: run `openclaw session sweep --plan-mode-clear` first if you want to clear plan-mode state from active sessions. Otherwise sessions with pending plan approval will be in an orphaned state until you re-install."

**Verdict**: MEDIUM resolved. Drain procedure + cleanup handler + operator command + docs.

---

## MEDIUM 3 — Operator install UX (no `registerStartupCheck` SDK capability)

### The finding

Plugin requires `allowConversationAccess: true` in operator config (per Agent B's seam inventory). Without this flag, the plugin's `before_tool_call`, `before_agent_run`, and `before_agent_finalize` hooks won't fire (per `docs/plugins/hooks.md`). Operators won't know what this means.

Wave 4 Agent Q flagged: no `api.registerStartupCheck` SDK capability exists. The plugin can't refuse to load if the flag isn't set; it just runs silently broken.

### Mitigation strategy

**Layer 1: Plugin self-detection on first hook attempt**:
- When a hook fires that requires `allowConversationAccess`, check if the flag is set on `ctx.pluginConfig`.
- If NOT set: log a loud WARN-level message ("⚠️ Smarter-Claw plugin requires `allowConversationAccess: true` in operator config. Plan mode will not function. See: <link to docs>") AND emit an `api.systemMessage` to the session telling the user.
- Use `api.systemMessage` for active sessions; use `log.warn` for cold-start visibility in operator logs.

**Layer 2: Plugin entry-point banner**:
- At plugin registration time (top of `index.ts`'s `register(api)` function), read `api.config.allowConversationAccess` (or whatever the access pattern is once we look at the real SDK).
- If false: register a single `before_agent_run` hook that ONLY emits the warning message. The hook can't do real work without the flag, but emitting messages is allowed in degraded mode.

**Layer 3: Documentation in `openclaw.plugin.json`'s `description` field**:
- The plugin manifest description shows in ClawHub install flow.
- Add an explicit note: "REQUIRED: set `allowConversationAccess: true` in your `openclaw.plugin.json` config for this plugin. Without it, plan-mode features will be disabled."

**Layer 4: Docs**:
- README.md: dedicated "Required configuration" section as the first content after install instructions.
- ClawHub listing: same note in the description.

**Layer 5: File an upstream issue against `openclaw/openclaw`**:
- Request `api.registerStartupCheck({ id, check, fix? })` SDK capability. The plugin declares a check function returning `{ ok: true } | { ok: false, message, fixHint }`. Host runs checks at plugin load; surface failures as plugin-load errors.
- This is a future-friendly capability; we can ship without it, but advocating for it helps the ecosystem.

### Test gates

- **P-1**: plugin loads even when `allowConversationAccess` is unset (graceful degradation, doesn't crash).
- **P-5**: when `allowConversationAccess` is unset, mutation gate is detected as inactive AND user-facing warning fires.
- **P-14 (release)**: README + manifest description both contain the warning.

**Verdict**: MEDIUM resolved. Five layers of mitigation (in-plugin detection + entry banner + manifest description + README + upstream-issue for SDK improvement). Operator install UX is degraded but observable; users will know when something's wrong.

---

## Summary

| MEDIUM | Mitigation | Where it lands |
|---|---|---|
| Subagent plan-mode doc gap | 3 test cases + README paragraph | P-7 |
| Rollback stop-conditions | Drain procedure + cleanup handler + sweep command + docs | P-12 (sweep), P-14 (docs) |
| Operator install UX | 5-layer mitigation (detection / entry banner / manifest / README / SDK issue) | P-1 (detection), P-5 (warning), P-14 (docs) |

**Net change to confidence**: with all 3 MEDIUMs mitigated, the remaining risk profile is **0 BLOCKERs + 0 HIGHs + 0 MEDIUMs + only acknowledged trade-offs**. Combined with the parity-harness closing both HIGHs, we should hit **≥95% confidence** after one more adversarial pass against the final state.

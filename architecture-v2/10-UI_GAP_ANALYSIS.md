# Step 10 — In-Host Plan-Mode UI Gap Analysis

**Purpose**: Make Eva's Path A/B/C decision (from `08-DECISION_DRAFT.md` Amendment 2) concrete by cataloging every in-host plan-mode UI element and classifying it against the three paths.

**Working tree**: `/Users/lume/repos/openclaw-pr70071-rebase`, branch `rebase/pr70071-onto-main-2026-04-25`, tip `ea04ea52c7`.

**Methodology**: read every plan-mode UI file end-to-end, identified each distinct render target, traced its parent container, and classified the render-surface options.

---

## Files inventoried

| File | Purpose | LOC |
|---|---|---|
| `ui/src/ui/chat/plan-cards.ts` | `renderPlanCard()` + `formatPlanAsMarkdown()` | 122 |
| `ui/src/ui/chat/plan-resume.ts` | Hidden `chat.send` to resume agent post-approval | 21 |
| `ui/src/ui/chat/mode-switcher.ts` | Mode-chip + dropdown + Ctrl+1..6 shortcut | 424 |
| `ui/src/ui/chat/slash-command-executor.ts` | `/plan on/off/auto/view/accept/revise/reject/answer` (~80 plan-only of 1305) | — |
| `ui/src/ui/views/plan-approval-inline.ts` | Inline approval card above input | 306 |
| `ui/src/ui/views/chat.ts` | Chat-render template (~250 plan-mode of 1652) | — |
| `ui/src/ui/app.ts` | Host class (~600 plan-mode of 1733: state, handlers, hydrate, sidebar) | — |
| `ui/src/ui/app-tool-stream.ts` | `PlanApprovalRequest` + plan-event handlers (~400 plan-relevant) | — |
| `ui/src/ui/app-render.helpers.ts` | "Plan view" toggle button in `chat-controls` | — |
| `ui/src/ui/app-chat.ts` | Slash dispatcher for `toggle-plan-view` | — |
| `ui/src/styles/chat/plan-cards.css` | Plan-card styles | 134 |

**Total plan-mode UI**: **~2,700 LOC production + ~2,700 LOC tests** (`plan-approval-inline.test.ts` 295 + `plan-cards.test.ts` 159 + `mode-switcher.test.ts` 388 + `plan-resume.node.test.ts` 26 + `slash-command-executor.node.test.ts` ~1000 plan-relevant + `chat.test.ts` ~200 plan-relevant + `app-chat.test.ts` ~50). Eva's prior 4,237 LOC was the file-count upper bound; **load-bearing plan-only logic is ~2,700 + 2,700 tests**.

**Critical finding (dead code)**: `renderPlanCard()` is exported but **never imported by any production file** (only its own test). The function appears intended for inline chat-stream rendering of `update_plan` events; current build emits plan progress **only into the sidebar markdown** (via `refreshLivePlanSidebar`). Important for Path C analysis.

---

## UI elements catalog (master table)

| # | Element | Render location | State owner | Classification | Paths it works in |
|---|---|---|---|---|---|
| 1 | **Mode-switcher chip** (Default/Ask/Accept/Plan/Plan⚡/Bypass) | `agent-chat__mode-switcher` inside `agent-chat__toolbar-left`, **inside the chat input bar** | View state (menuOpen) + session state (planMode, autoApprove, execSecurity, execAsk) | **NEEDS_CHAT_STREAM** — physically inside the input toolbar | A, B-w/-degradation, C |
| 2 | **Mode dropdown menu** | Anchored under the chip | View state | **NEEDS_CHAT_STREAM** (anchor to chip) | A, B-w/-degradation, C |
| 3 | **Ctrl+1..6 shortcut handler** | `document` keydown | Stateless | EITHER_WAY (host-level keybinding) | A, B (host owns keybind), C |
| 4 | **Inline plan-approval card** (Accept / Accept w/edits / Revise) | `plan-inline-card` rendered **above the chat input** (replaces input bar) | host @state `planApprovalRequest`, `planApprovalBusy`, `planApprovalError` | **NEEDS_CHAT_STREAM** — user expects this in-context with the message that proposed it | A, B-w/-degradation, C |
| 5 | **Plan-card title strip** ("Agent proposed a plan — <summary>") | Inside the inline card header | Same | **NEEDS_CHAT_STREAM** — part of (4) | A, B-w/-degradation, C |
| 6 | **"Open plan" link** | Inside the inline card | Same | EITHER_WAY — opens the sidebar regardless | A, B, C |
| 7 | **Rejection-feedback textarea** (inline-revise) | Replaces the action-button row in-place inside the card | host @state `planApprovalReviseOpen`, `planApprovalReviseDraft` | **NEEDS_CHAT_STREAM** — Claude Code's revise UX is in-place inline; sidebar move = focus jump | A, C; **HARD GAP for B** |
| 8 | **AskUserQuestion card** (question prompt + option buttons) | Same card shell as (4), question variant | Same as (4) | **NEEDS_CHAT_STREAM** — same in-context affordance as (4) | A, B-w/-degradation, C |
| 9 | **AskUserQuestion "Other…" textarea** | Replaces options in-place inside the card | host @state `planApprovalQuestionOtherOpen`, `planApprovalQuestionOtherDraft` | **NEEDS_CHAT_STREAM** — same reason as (7) | A, C; **HARD GAP for B** |
| 10 | **Inline-card error banner** (handler-missing / offline / blocked-by-subagents details) | Inside the card | host @state `planApprovalError` | **NEEDS_CHAT_STREAM** — co-located with the action | A, B-w/-degradation, C |
| 11 | **Subagent-blocking toast** ("Subagents still running — try in 8s") | Bottom of chat, above input | host @state `subagentBlockingStatus` (auto-clears 8s) | EITHER_WAY — toast surface; can pop in sidebar but loses chat anchoring | A, B-w/-degradation, C |
| 12 | **Plan-view sidebar widget** (the right-side panel rendering full plan markdown) | Right sidebar (`sidebarContent.kind === "markdown"`) | host @state `sidebarOpen`, `sidebarContent`, `latestPlanMarkdown` | **FITS_SIDEBAR** — it IS the sidebar | A, B, C |
| 13 | **Live plan checklist refresh** (update_plan events ticking boxes) | Same sidebar markdown surface | host @state `latestPlanMarkdown` updated by `refreshLivePlanSidebar()` | **FITS_SIDEBAR** | A, B, C |
| 14 | **Plan title in sidebar header** ("(planning)" → real title) | First H1 of sidebar markdown | Derived from `SessionEntry.planMode.title` | **FITS_SIDEBAR** | A, B, C |
| 15 | **Plan archetype sections** (analysis / assumptions / risks / verification / references) | Sidebar markdown body | Derived from `PlanApprovalRequest` archetype fields | **FITS_SIDEBAR** | A, B, C |
| 16 | **"Plan view" toggle button in chat-controls** | Top of chat area, in `chat-controls` toolbar | Computed from sidebar state | **NEEDS_CHAT_STREAM** (physical location) but action targets sidebar — could move to sidebar header | A, B-w/-degradation, C |
| 17 | **Plan-card inline (`renderPlanCard`)** | Currently **NOT WIRED** — exported but unused in production | n/a (dead code) | EITHER_WAY (does not currently render anywhere) | n/a (deferrable) |
| 18 | **`/plan view` slash command** | Triggers via composer `/plan view`; dispatches `toggle-plan-view` action | Stateless | EITHER_WAY (the action result is sidebar-only) | A, B, C |
| 19 | **`/plan on/off/auto` slash commands** | Calls `sessions.patch` to toggle session state | Stateless | EITHER_WAY | A, B, C |
| 20 | **`/plan accept/revise/reject/answer` slash commands** | Calls `sessions.patch { planApproval: ... }` | Stateless | EITHER_WAY (commands work regardless of UI surface) | A, B, C |
| 21 | **Hidden plan-resume `chat.send`** (post-approval continue ping) | Network only, no UI | Stateless | EITHER_WAY (invisible) | A, B, C |
| 22 | **Input-bar suppression while approval is showing** | Chat input replaced by the approval card | View | **NEEDS_CHAT_STREAM** — the suppression IS the integration | A, C; **HARD GAP for B** (the input never gets suppressed; user can keep typing into it) |
| 23 | **Auto-open sidebar when fresh approval arrives** | host `openPlanInSidebar()` fires from `handlePlanApprovalEvent` | host code | **FITS_SIDEBAR** | A, B, C |
| 24 | **Hydration from `SessionEntry.planMode.lastPlanSteps`** on session change / page refresh | host `hydratePlanViewFromSession()` + `hydratePlanApprovalFromSession()` | host code | EITHER_WAY | A, B, C |
| 25 | **Dismissed-approvalId set** (prevents stale-state popup blink loop) | host @state `planApprovalDismissedApprovalIds` | host code | EITHER_WAY (logic, not visual) | A, B, C |

**Counts**: 25 distinct elements catalogued.

- **NEEDS_CHAT_STREAM** (8): #1, #2, #4, #5, #7, #8, #9, #10, #16, #22 → **10 elements** (counting #16 which is physically chat-toolbar)
- **FITS_SIDEBAR** (5): #12, #13, #14, #15, #23
- **EITHER_WAY** (10): #3, #6, #11, #17, #18, #19, #20, #21, #24, #25

(The classification of #11 "subagent-blocking toast" as EITHER_WAY is the most contested. The 8s auto-clear toast is conventionally a chat-stream affordance, but its content is short enough to be a top-of-sidebar banner without total loss of meaning.)

---

## Path A — In-host UI PR

**Files to ship**:
- New files: `chat/plan-cards.ts` (122) + `chat/plan-resume.ts` (21) + `chat/mode-switcher.ts` (424) + `views/plan-approval-inline.ts` (306) + `styles/chat/plan-cards.css` (134)
- Patches: `views/chat.ts` (~250) + `app.ts` (~600) + `app-tool-stream.ts` (~400) + `app-render.helpers.ts` (~30) + `app-chat.ts` (~5) + `app-view-state.ts` (~30) + `chat/slash-command-executor.ts` (~80)
- i18n: `locales/en.ts` strings + regenerated bundles (~30 locale files via `pnpm ui:i18n:sync`)
- Tests (~2,700 LOC): all 6 plan-mode test files

**Total: ~5,400 LOC** (production + tests).

**Host-code dependencies** (all already shipped in main): `GatewayBrowserClient`; `SessionEntry.planMode`; `agent_plan_event` + `approval` streams; `sessions.patch { planApproval: ... }`; `chat.send { deliver: false }`; existing sidebar machinery (`handleOpenSidebar`, `sidebarContent`); Lit + lit-html.

**PR review difficulty**: **MEDIUM-HARD**. Reviewers will scrutinize state-machine correctness around (a) dismissed-approvalId stale-state, (b) hidden chat.send idempotency, (c) shadow-DOM focus guard in `handleModeShortcut`. Race-fix invariant is server-side, not UI, so UI review is bounded.

**Estimated review/merge cycle**: **3–6 weeks** as one omnibus; **4–8 weeks** split into 4–6 sub-PRs at <600 LOC each (per AGENTS.md preference): mode-switcher / inline-card / sidebar-hydrate / slash-commands / plan-view-toggle / i18n.

---

## Path B — Sidebar UI only

**Fits cleanly in sidebar**: #12 plan markdown, #13 live update_plan refresh, #14 title, #15 archetype sections, #23 auto-open, slash commands #18/19/20, hidden plan-resume #21.

**Degrades gracefully (acceptable)**:
- #1 Mode-switcher chip → sidebar header strip. *MINOR–MEDIUM* (no longer in input toolbar).
- #4 Plan-approval card → sidebar (Accept/Edit/Revise buttons). *MEDIUM* (not in-context with proposing message).
- #5 Title strip / #8 Question buttons → same as #4. *MEDIUM*.
- #10 Error banner / #11 Subagent toast → sidebar header. *MINOR*.
- #16 "Plan view" toggle → redundant (sidebar always shows).

**HARD GAPS (impossible in sidebar)**:
- **#7 Rejection-feedback textarea**: works in sidebar but breaks Claude Code's in-place revise UX. Focus jumps chat → sidebar → chat. *Real UX loss but workable*.
- **#9 AskUserQuestion "Other…" textarea**: same loss as #7.
- **#22 Input-bar suppression — CORRECTNESS GAP**: `registerControlUiDescriptor` cannot suppress the host's chat input. Users can keep typing into chat while approval is pending in the sidebar. If they hit Enter, the typed message sends as a normal chat reply — agent is still waiting on approval — confusion. **This is a bug, not just degradation**. No mitigation banner can prevent the keystroke from reaching the host's chat-send handler.

**Recommended sidebar structure**:

```
┌─────────────────────────────────────┐
│ Plan Mode  [Default | Ask | Plan ⚡] │  <- mode chip (header strip)
├─────────────────────────────────────┤
│ Status: ⚠ Approval pending          │  <- badge
├─────────────────────────────────────┤
│ [Approve] [Accept+edits] [Revise]   │  <- buttons (replaces inline card)
│ (Revise → in-sidebar textarea)      │
├─────────────────────────────────────┤
│ # Plan Title                        │
│ ## Analysis / Plan / Risks / etc.   │  <- archetype sections
│ - [x] step 1 (live checklist)       │
└─────────────────────────────────────┘
```

**UX cost — 5 user-flow examples**:

1. **Approve**: In-host = read card inline → click Accept inline (~2s). Sidebar = read inline banner → "see sidebar →" → focus shift → click Accept → focus return (~5s + context switch).
2. **Revise with feedback**: In-host = Revise → IN-PLACE textarea → Cmd+Enter → done, stays in chat. Sidebar = Revise → sidebar textarea → submit → focus returns to chat. Lost: feedback is in non-chat surface.
3. **Answer "Other…"**: same focus-shift trade-off as #2.
4. **CORRECTNESS BUG — user types into chat while approval pending**: In-host = input HIDDEN, cannot type. Sidebar = input visible, user types "looks good" + Enter → sends as normal chat → agent still waiting on approval → confusion. **Real bug**.
5. **Switch modes mid-session**: In-host = chip in toolbar → menu → Plan (<1s). Sidebar = scroll sidebar → mode strip → click (~3s).

---

## Path C — New SDK seam for chat-stream rendering

**Proposed seam signature** (analogy with existing seams):

```typescript
api.registerChatStreamRenderer({
  pluginId: "smarter-claw",
  filter: (msg: SessionMessage) => boolean,
  render: (msg, ctx: { sessionKey, onAction }) => HTMLElement,
  suppressInputWhileVisible?: (msg) => boolean,
});
// Sidecar for #22:
api.registerInputBarStateProjector({
  projector: (sessionKey) => { hidden: boolean, reason?: string },
});
```

**Why this seam doesn't exist yet** (read of SDK + AGENTS.md):
- Existing SDK has `registerControlUiDescriptor` (sidebar widget) and tool-output sidebar projection (read-only popup). No precedent for plugins owning a slice of the chat thread — host's `grouped-render.ts` (~1500 LOC) owns everything between user-message blocks.
- Architectural pushback risk: **stream-order coherence**. If plugins inject widgets, message numbering / search / export-to-markdown / the no-token-delta channel rule all need policies.
- Input-bar suppression is a **security-sensitive surface change**: no plugin currently has any say over chat composer visibility.

**Upstream PR contents (estimated)**:
- `src/plugin-sdk/chat-stream-renderer.ts` + `input-bar-projector.ts` — typed API surfaces
- `src/plugins/registry/chat-stream-renderer-registry.ts` — registry impl
- `ui/src/ui/chat/plugin-renderer-slot.ts` — host-side renderer slot
- Patches to `ui/src/ui/chat/grouped-render.ts` (~50–150 LOC) + `views/chat.ts` (~20 LOC)
- Contract tests + browser tests + integration smoke
- Docs: `docs/plugins/chat-stream-rendering.md`

**Estimated upstream PR review/merge cycle**: **6–10 weeks**. New SDK surface + security-sensitive surface change + likely two rounds of design pushback. Easily 12 weeks if a maintainer goes deep on the stream-order question. Faster if Eva drives the RFC herself.

**Alternative: would `registerSessionExtension` projector with HTML output suffice?**

I searched `src/plugin-sdk`, `src/plugin-sdk-internal`, `src/gateway`, and the wider `src/` — there is **no `registerSessionExtension`** in the current rebase. The only existing seams in this neighbourhood are `registerControlUiDescriptor` (Path B's foundation) and the control-UI auth machinery in `src/gateway/server.auth.control-ui.suite.ts`. If a richer seam exists in a different branch or draft PR, Path C may collapse into "use that seam" — but Eva would need to confirm the surface name. As of today's tree, **no existing seam suffices for inline plan-card rendering**; Path C requires a real upstream PR.

---

## My recommendation: **Path A**

Confidence: ~78%.

**Rationale (300 words)**:

Path B has a **correctness gap, not just a UX gap**. Element #22 (input-bar suppression) cannot be solved with any current SDK seam. When a plan approval is pending, users will still be able to type into the chat input and hit Enter — sending an out-of-band chat message that the agent will interpret as a regular reply, not as a plan-mode answer. We can mitigate with banners and disabled-state CSS overlays, but we cannot prevent the keystroke from reaching the host's chat-send handler. This is a regression vs the in-host implementation, and once users hit it, the fix-it-by-banner workaround will look like a half-built feature.

Path B's other compromises (focus-shifting between chat and sidebar for #7 inline revise, #9 ask-question "Other") are recoverable. But the input-bar correctness gap is not.

Path C is architecturally the right answer, but it adds 6–10 weeks of upstream-PR risk on the critical path. Reading openclaw/AGENTS.md and the SDK boundaries, this PR will face serious design pushback ("stream-order coherence" + "input-bar suppression is a security surface change") and could easily take 12 weeks if a maintainer goes deep. We don't have evidence that any plugin author besides us would benefit, which means upstream may legitimately say "do it in-host, not as a seam." If that happens we're back to Path A having lost weeks.

Path A — landing the UI in upstream — *is* the upstream PR, just without the new abstraction. It will be a large but reviewable PR (~5,400 LOC including tests, the heavy logic already written and tested), staged into 4–6 sub-PRs at ~600 LOC each per OpenClaw norms. The fidelity is exact (it IS the in-host code). The plugin then owns only backend (plan-mode runtime gate, race-fix invariant, slash-command parity); the UI ships with the host. Eva's "downloadable from anywhere" constraint becomes "needs OpenClaw ≥v2026.X.Y" — already true for bundled plugins.

**Strongest argument**: Path B has a real correctness regression we can't engineer away. Path C trades certainty for an unbounded review cycle. Path A is the most fidelity-preserving and the work is already done — it just needs to be staged into upstream-friendly PRs.

---

## Open questions for Eva

1. **Path selection**: A / B / C? (this doc's recommendation: A)
2. If A: do we split the in-host UI work into 4–6 sub-PRs by feature (mode-switcher / inline-card / sidebar-hydrate / slash-commands / plan-view-button / i18n) or one omnibus PR?
3. If B: do we accept the input-bar correctness gap with a documented "known limitation"? (My read: this is a release blocker.)
4. If C: who drives the upstream SDK RFC + design discussion? (this affects timeline significantly)


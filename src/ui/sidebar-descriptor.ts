/**
 * Plan-Mode sidebar UI descriptor.
 *
 * Registers a Control-UI surface that operators' UI clients can
 * discover + render. The actual rendering is host-side / client-side
 * — the plugin only DECLARES the slot. UI clients call
 * `gateway.listControlUiDescriptors()` and render any surface they
 * recognize.
 *
 * # Status
 *
 * This ships the **sidebar variant** (Phase A of architecture-v2's
 * UI strategy). Operators see a sidebar widget that renders the
 * current plan-mode state + Approve/Edit/Reject/Cancel buttons.
 *
 * The Phase B inline-chat-stream UI (mode-switcher chip, inline plan
 * cards, input-bar suppression) is gated on an upstream SDK seam that
 * doesn't exist yet (`registerChatStreamRenderer` or similar). See
 * architecture-v2/15-CURRENT_STATE_FOR_EVA.md "Upstream SDK gaps". The
 * sidebar variant is internally usable until the chat-stream seam
 * lands and P-final integrates it.
 *
 * # Why declare instead of render?
 *
 * Plugins don't ship UI bundles in this OpenClaw version. The
 * `PluginControlUiDescriptor` records the slot's metadata
 * (label, surface, schema for the data it exposes) and the host's
 * Control UI builds the actual widget. The plugin owns the DATA
 * (read via session-extension projection) and the ACTIONS (the
 * `plan.accept` / `plan.reject` / etc. session-actions). The host
 * owns the rendering.
 *
 * host_ref: in-host UI lives across `ui/src/ui/` (chat.ts, settings.ts,
 *   plan-cards.ts) at the same commit. The plugin port can't render
 *   those directly without the chat-stream seam; the sidebar
 *   descriptor below is the v1 dev-UX path.
 */

import type { PluginControlUiDescriptor } from "openclaw/plugin-sdk/plugin-entry";

export const PLAN_MODE_SIDEBAR_DESCRIPTOR_ID = "smarter-claw.plan-mode.sidebar";

/**
 * Build the sidebar descriptor. The schema describes the shape of the
 * data the operator's UI can pull via the session-extension projection
 * at `pluginExtensions["smarter-claw"]["plan-mode"]`.
 *
 * The schema is informational — clients use it for type generation +
 * validation; the plugin produces data via the PlanModeStore which
 * stamps `__schemaVersion` on every write.
 */
export function buildPlanModeSidebarDescriptor(): PluginControlUiDescriptor {
  return {
    id: PLAN_MODE_SIDEBAR_DESCRIPTOR_ID,
    surface: "session",
    label: "Plan Mode",
    description:
      "Plan-then-execute workflow. When the agent enters plan mode, " +
      "mutations are blocked until you approve the proposed plan. " +
      "Approve / Edit / Reject / Cancel through the sidebar actions.",
    // No placement — let the host's Control UI decide based on surface.
    schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["plan", "normal"] },
        approval: {
          type: "string",
          enum: [
            "none",
            "pending",
            "approved",
            "edited",
            "rejected",
            "timed_out",
          ],
        },
        rejectionCount: { type: "integer", minimum: 0 },
        approvalId: { type: "string" },
        title: { type: "string" },
        feedback: { type: "string" },
        lastPlanSteps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: { type: "string" },
              activeForm: { type: "string" },
            },
            required: ["step", "status"],
          },
        },
        autoApprove: { type: "boolean" },
        __schemaVersion: { type: "integer" },
      },
      required: ["mode", "approval", "rejectionCount"],
    },
    requiredScopes: [
      // The sidebar can READ session state (rendering) — basic operator
      // access is enough. The action handlers above (plan.accept etc.)
      // are where actual STATE MUTATION privilege gating happens.
    ],
  };
}

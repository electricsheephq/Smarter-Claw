export const OPENCLAW_2026_6_1_ACTIVE_SESSION_ATTACHMENT_BLOCK =
  "active-session-attachments-bundled-only";

export type PlanNotificationDeliveryFailureCode =
  | typeof OPENCLAW_2026_6_1_ACTIVE_SESSION_ATTACHMENT_BLOCK
  | "delivery-unavailable";

export type PlanNotificationDeliveryFailure = {
  code: PlanNotificationDeliveryFailureCode;
  releaseGate: boolean;
  fallback: string;
  message: string;
};

const PLAN_NOTIFICATION_FALLBACK =
  "/plan commands and persisted Markdown plan paths remain authoritative";

export function classifyPlanNotificationDeliveryFailure(
  error: string,
): PlanNotificationDeliveryFailure {
  const normalized = error.trim();
  if (/session attachments are restricted to bundled plugins/i.test(normalized)) {
    return {
      code: OPENCLAW_2026_6_1_ACTIVE_SESSION_ATTACHMENT_BLOCK,
      releaseGate: true,
      fallback: PLAN_NOTIFICATION_FALLBACK,
      message:
        "OpenClaw stock host rejected active-session attachment delivery for a workspace plugin.",
    };
  }
  return {
    code: "delivery-unavailable",
    releaseGate: false,
    fallback: PLAN_NOTIFICATION_FALLBACK,
    message: `Plan notification delivery was unavailable: ${normalized || "unknown error"}`,
  };
}

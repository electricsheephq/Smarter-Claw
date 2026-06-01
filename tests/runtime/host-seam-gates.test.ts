import { describe, expect, it } from "vitest";
import {
  classifyPlanNotificationDeliveryFailure,
  OPENCLAW_2026_6_1_ACTIVE_SESSION_ATTACHMENT_BLOCK,
} from "../../src/runtime/host-seam-gates.js";

describe("OpenClaw host seam release gates", () => {
  it("classifies the stock v2026.6.1 active-session attachment block", () => {
    expect(
      classifyPlanNotificationDeliveryFailure(
        "session attachments are restricted to bundled plugins",
      ),
    ).toEqual({
      code: OPENCLAW_2026_6_1_ACTIVE_SESSION_ATTACHMENT_BLOCK,
      releaseGate: true,
      fallback: "/plan commands and persisted Markdown plan paths remain authoritative",
      message:
        "OpenClaw stock host rejected active-session attachment delivery for a workspace plugin.",
    });
  });

  it("keeps unknown delivery failures non-release-gated", () => {
    expect(classifyPlanNotificationDeliveryFailure("session has no active delivery route")).toEqual({
      code: "delivery-unavailable",
      releaseGate: false,
      fallback: "/plan commands and persisted Markdown plan paths remain authoritative",
      message: "Plan notification delivery was unavailable: session has no active delivery route",
    });
  });
});

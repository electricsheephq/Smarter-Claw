/**
 * Ported from openclaw-1: src/agents/plan-mode/plan-archetype-bridge.test.ts
 *
 * Adapted for Smarter-Claw API:
 *   - The Smarter-Claw bridge does NOT mock `plugin-sdk/telegram.js` /
 *     `config/sessions/store-read.js` etc. — channel delivery is plumbed
 *     through an `input.sendAttachment` callback the installer wires.
 *     Tests pass a vi.fn() callback directly.
 *   - The "telegram-specific" cases become "sendAttachment delivers /
 *     declines / throws" cases since channel routing is now the
 *     installer's job.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPlanAttachmentCaption,
  dispatchPlanArchetypeAttachment,
} from "../src/archetype-bridge.js";

const FIXED_DATE = new Date("2026-04-18T12:00:00Z");

describe("buildPlanAttachmentCaption", () => {
  it("includes title + universal /plan resolution commands", () => {
    const caption = buildPlanAttachmentCaption("Refactor X", "Short summary");
    expect(caption).toContain("Refactor X");
    expect(caption).toContain("Short summary");
    expect(caption).toContain("/plan accept");
    expect(caption).toContain("/plan accept edits");
    expect(caption).toContain("/plan revise");
  });

  it("falls back to 'Plan' when title is undefined or empty", () => {
    expect(buildPlanAttachmentCaption(undefined, undefined)).toContain("<b>Plan</b>");
    expect(buildPlanAttachmentCaption("", undefined)).toContain("<b>Plan</b>");
  });

  it("HTML-escapes title + summary so injection in HTML parse_mode is neutralized", () => {
    const caption = buildPlanAttachmentCaption("<script>", "<img onerror=...>");
    expect(caption).toContain("&lt;script&gt;");
    expect(caption).toContain("&lt;img onerror=");
    expect(caption).not.toContain("<script>");
  });
});

describe("dispatchPlanArchetypeAttachment", () => {
  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "smarter-claw-bridge-"));
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  function makeDetails() {
    return {
      title: "Refactor websocket reconnect",
      summary: "Address the close-race condition",
      analysis: "Current state: races on close",
      plan: [
        { step: "Audit close handlers", status: "pending" as const },
        { step: "Add idempotency guard", status: "pending" as const },
      ],
      assumptions: ["Tests pass first run"],
      risks: [{ risk: "Reconnect storm", mitigation: "Backoff" }],
      verification: ["pnpm test src/ws"],
      references: ["src/ws/reconnect.ts:42"],
    };
  }

  it("persists markdown AND invokes sendAttachment callback when wired", async () => {
    const sendAttachment = vi.fn(async () => ({
      delivered: true,
      channel: "telegram",
      messageId: "100",
    }));
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:telegram:acct1:dm:peer1",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
      sendAttachment,
    });

    const planDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^plan-2026-04-18-refactor-websocket-reconnect\.md$/);
    const absPath = path.join(planDir, files[0] ?? "");

    expect(sendAttachment).toHaveBeenCalledTimes(1);
    const callArgs = sendAttachment.mock.calls[0]?.[0];
    expect(callArgs?.sessionKey).toBe("agent:main:telegram:acct1:dm:peer1");
    expect(callArgs?.absPath).toBe(absPath);
    expect(callArgs?.filename).toMatch(/refactor-websocket-reconnect\.md$/);
    expect(callArgs?.caption).toContain("Refactor websocket reconnect");
    expect(callArgs?.caption).toContain("/plan accept");

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("plan-bridge: attachment sent"),
    );
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("channel=telegram"));
  });

  it("persists markdown but skips channel delivery when no sendAttachment callback wired", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:main",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
    });

    // Markdown still persisted (audit artifact for non-channel sessions).
    const planDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(1);
    // Debug log notes the skip.
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("no sendAttachment callback"),
    );
  });

  it("sendAttachment returns {delivered:false}: persists markdown and logs a debug skip", async () => {
    const sendAttachment = vi.fn(async () => ({ delivered: false, channel: "web" }));
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:web:s1",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
      sendAttachment,
    });

    const planDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(1);
    expect(sendAttachment).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("sendAttachment declined"),
    );
  });

  it("sendAttachment returns null: degrades to disk-only", async () => {
    const sendAttachment = vi.fn(async () => null);
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:telegram:acct1:dm:peer1",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
      sendAttachment,
    });
    expect(sendAttachment).toHaveBeenCalledTimes(1);
    // Markdown still on disk.
    const planDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(1);
  });

  it("sendAttachment throws: caller does not throw, warn logged, markdown still persisted", async () => {
    const sendAttachment = vi.fn(async () => {
      throw new Error("network down");
    });
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    // Must not throw.
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:telegram:acct1:dm:peer1",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
      sendAttachment,
    });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("network down"));
    // Markdown still persisted before the failed send.
    const planDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(1);
  });

  it("multi-cycle: second exit_plan_mode same day produces -2.md suffix and fires both sends", async () => {
    const sendAttachment = vi.fn(async () => ({
      delivered: true,
      channel: "telegram",
      messageId: "100",
    }));
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:telegram:acct1:dm:peer1",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
      sendAttachment,
    });
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:telegram:acct1:dm:peer1",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
      sendAttachment,
    });
    const planDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(2);
    expect(files).toContain("plan-2026-04-18-refactor-websocket-reconnect.md");
    expect(files).toContain("plan-2026-04-18-refactor-websocket-reconnect-2.md");
    expect(sendAttachment).toHaveBeenCalledTimes(2);
  });
});

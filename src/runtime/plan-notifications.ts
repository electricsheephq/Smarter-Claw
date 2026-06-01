import { randomBytes } from "node:crypto";
import type {
  OpenClawPluginApi,
  PluginSessionActionContext,
  PluginSessionActionResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PersistPlanArchetypeMarkdownResult } from "../plan-mode/plan-archetype-persist.js";
import type { PlanModeStore } from "../state/store.js";
import type { PlanStep } from "../types.js";
import { classifyPlanNotificationDeliveryFailure } from "./host-seam-gates.js";

export const TELEGRAM_PLAN_INTERACTIVE_NAMESPACE = "smarter-claw-plan";

type PresentationButtonStyle = "primary" | "secondary" | "success" | "danger";

type MessagePresentation = {
  title?: string;
  tone?: "info" | "success" | "warning" | "danger" | "neutral";
  blocks: Array<
    | { type: "text"; text: string }
    | { type: "context"; text: string }
    | { type: "divider" }
    | {
        type: "buttons";
        buttons: Array<{
          label: string;
          value: string;
          style?: PresentationButtonStyle;
          priority?: number;
        }>;
      }
  >;
};

type SessionAttachmentParams = {
  sessionKey: string;
  files?: Array<{ path: string }>;
  text?: string;
  presentation?: MessagePresentation;
  forceDocument?: boolean;
  captionFormat?: "plain" | "html" | "markdown";
  channelHints?: {
    telegram?: {
      disableNotification?: boolean;
    };
  };
};

type TelegramInteractiveContext = {
  channel: "telegram";
  auth?: { isAuthorizedSender?: boolean };
  callback: {
    payload: string;
  };
  respond: {
    reply?: (params: { text: string }) => Promise<void> | void;
    clearButtons?: () => Promise<void> | void;
  };
};

type RegisterInteractiveHandler = (registration: {
  channel: "telegram";
  namespace: string;
  handler: (ctx: TelegramInteractiveContext) => Promise<{ handled: true }>;
}) => void;

type OpenClawPluginApiWithRuntimeNotifications = OpenClawPluginApi & {
  registerInteractiveHandler?: RegisterInteractiveHandler;
  session?: OpenClawPluginApi["session"] & {
    workflow?: OpenClawPluginApi["session"]["workflow"] & {
      sendSessionAttachment?: (params: unknown) => Promise<{ ok: true } | { ok: false; error: string }>;
    };
  };
};

export type SessionActionHandler = (
  ctx: PluginSessionActionContext,
) => PluginSessionActionResult | void | Promise<PluginSessionActionResult | void>;

type ApprovalTokenEntry = {
  kind: "approval";
  sessionKey: string;
  approvalId: string;
  action: "accept" | "revise" | "reject" | "cancel";
  expiresAt: number;
};

type QuestionTokenEntry = {
  kind: "question";
  sessionKey: string;
  questionId: string;
  questionPrompt: string;
  selectedOption: string;
  expiresAt: number;
};

type TokenEntry = ApprovalTokenEntry | QuestionTokenEntry;
type NewTokenEntry =
  | Omit<ApprovalTokenEntry, "expiresAt">
  | Omit<QuestionTokenEntry, "expiresAt">;
type JsonPayload = Record<string, string | number | boolean | null>;

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const tokens = new Map<string, TokenEntry>();

export function __resetPlanNotificationTokensForTest(): void {
  tokens.clear();
}

export function __getPlanNotificationTokenCountForTest(): number {
  return tokens.size;
}

function createToken(entry: NewTokenEntry): string {
  const now = Date.now();
  for (const [token, existing] of tokens) {
    if (existing.expiresAt <= now) {
      tokens.delete(token);
    }
  }
  const token = randomBytes(9).toString("base64url");
  tokens.set(token, {
    ...entry,
    expiresAt: now + TOKEN_TTL_MS,
  } as TokenEntry);
  return token;
}

function consumeToken(token: string): TokenEntry | undefined {
  const entry = tokens.get(token);
  if (!entry) return undefined;
  tokens.delete(token);
  if (entry.expiresAt <= Date.now()) {
    return undefined;
  }
  return entry;
}

function discardTokens(values: string[]): void {
  for (const token of values) {
    tokens.delete(token);
  }
}

function callbackValue(action: string, token: string): string {
  return `${TELEGRAM_PLAN_INTERACTIVE_NAMESPACE}:${action}:${token}`;
}

function renderPlanText(input: {
  title: string;
  summary?: string;
  persistedPlan?: PersistPlanArchetypeMarkdownResult;
}): string {
  const lines = [`Plan approval requested: ${input.title}`];
  if (input.summary) {
    lines.push("", input.summary);
  }
  if (input.persistedPlan) {
    lines.push("", `Markdown plan: ${input.persistedPlan.absPath}`);
  }
  lines.push(
    "",
    "Fallback commands: /plan approve, /plan revise <feedback>, /plan reject <feedback>, /plan cancel.",
  );
  return lines.join("\n");
}

function renderPlanPresentation(input: {
  sessionKey: string;
  approvalId: string;
  title: string;
  summary?: string;
  plan: PlanStep[];
  persistedPlan?: PersistPlanArchetypeMarkdownResult;
}): { presentation: MessagePresentation; tokens: string[] } {
  const accept = createToken({
    kind: "approval",
    sessionKey: input.sessionKey,
    approvalId: input.approvalId,
    action: "accept",
  });
  const revise = createToken({
    kind: "approval",
    sessionKey: input.sessionKey,
    approvalId: input.approvalId,
    action: "revise",
  });
  const reject = createToken({
    kind: "approval",
    sessionKey: input.sessionKey,
    approvalId: input.approvalId,
    action: "reject",
  });
  const cancel = createToken({
    kind: "approval",
    sessionKey: input.sessionKey,
    approvalId: input.approvalId,
    action: "cancel",
  });
  const firstSteps = input.plan
    .slice(0, 4)
    .map((step, index) => `${index + 1}. ${step.step}`)
    .join("\n");
  return {
    tokens: [accept, revise, reject, cancel],
    presentation: {
      title: input.title,
      tone: "warning",
      blocks: [
        ...(input.summary ? [{ type: "text" as const, text: input.summary }] : []),
        ...(firstSteps ? [{ type: "context" as const, text: firstSteps }] : []),
        ...(input.persistedPlan
          ? [
              {
                type: "context" as const,
                text: `Markdown artifact: ${input.persistedPlan.filename}`,
              },
            ]
          : []),
        {
          type: "buttons",
          buttons: [
            {
              label: "Approve",
              value: callbackValue("a", accept),
              style: "success",
              priority: 100,
            },
            {
              label: "Revise",
              value: callbackValue("v", revise),
              style: "primary",
              priority: 90,
            },
            {
              label: "Reject",
              value: callbackValue("r", reject),
              style: "danger",
              priority: 80,
            },
            {
              label: "Cancel",
              value: callbackValue("c", cancel),
              style: "secondary",
              priority: 70,
            },
          ],
        },
      ],
    },
  };
}

function renderQuestionPresentation(input: {
  sessionKey: string;
  questionId: string;
  questionPrompt: string;
  options: string[];
}): { presentation: MessagePresentation; tokens: string[] } {
  const mintedTokens: string[] = [];
  return {
    tokens: mintedTokens,
    presentation: {
      title: "Question",
      tone: "info",
      blocks: [
        { type: "text", text: input.questionPrompt },
        {
          type: "buttons",
          buttons: input.options.map((option, index) => {
            const token = createToken({
              kind: "question",
              sessionKey: input.sessionKey,
              questionId: input.questionId,
              questionPrompt: input.questionPrompt,
              selectedOption: option,
            });
            mintedTokens.push(token);
            return {
              label: option,
              value: callbackValue("q", token),
              style: index === 0 ? "primary" : "secondary",
              priority: 100 - index,
            };
          }),
        },
      ],
    },
  };
}

async function sendPresentation(
  api: OpenClawPluginApiWithRuntimeNotifications,
  params: SessionAttachmentParams,
): Promise<boolean> {
  const sendSessionAttachment = api.session?.workflow?.sendSessionAttachment;
  if (!sendSessionAttachment) {
    api.logger.warn(
      "[smarter-claw] plan notification skipped: host has no session.workflow.sendSessionAttachment runtime seam",
    );
    return false;
  }
  const result = await sendSessionAttachment(params as unknown);
  if (!result.ok) {
    const gate = classifyPlanNotificationDeliveryFailure(result.error);
    api.logger.warn(
      `[smarter-claw] plan notification delivery skipped (${gate.code}${
        gate.releaseGate ? "; release-gated host seam" : ""
      }): ${gate.message} Fallback: ${gate.fallback}.`,
    );
    return false;
  }
  return true;
}

async function reply(ctx: TelegramInteractiveContext, text: string): Promise<void> {
  await ctx.respond.reply?.({ text });
}

async function clearButtons(ctx: TelegramInteractiveContext): Promise<void> {
  await ctx.respond.clearButtons?.();
}

function isAuthorized(ctx: TelegramInteractiveContext): boolean {
  return ctx.auth?.isAuthorizedSender === true;
}

async function dispatchSessionAction(
  actions: Map<string, SessionActionHandler>,
  actionId: string,
  sessionKey: string,
  payload: JsonPayload,
): Promise<PluginSessionActionResult | void> {
  const handler = actions.get(actionId);
  if (!handler) {
    return {
      ok: false,
      error: `session action not registered: ${actionId}`,
      code: "ACTION_NOT_REGISTERED",
    };
  }
  return await handler({
    pluginId: "smarter-claw",
    actionId,
    sessionKey,
    payload,
  });
}

function isActionOk(result: PluginSessionActionResult | void): boolean {
  return Boolean(result && result.ok !== false);
}

function actionError(result: PluginSessionActionResult | void): string {
  if (!result || result.ok !== false) {
    return "unknown action failure";
  }
  return `${result.code ?? "ERROR"} - ${result.error}`;
}

async function handleApprovalCallback(input: {
  ctx: TelegramInteractiveContext;
  entry: ApprovalTokenEntry;
  actions: Map<string, SessionActionHandler>;
  store: PlanModeStore;
}): Promise<void> {
  const snap = await input.store.readSnapshot(input.entry.sessionKey);
  if (
    !snap ||
    snap.approvalId !== input.entry.approvalId ||
    (snap.approval !== "pending" && snap.approval !== "rejected")
  ) {
    await clearButtons(input.ctx);
    await reply(input.ctx, "That plan button is stale. Use /plan status for the current state.");
    return;
  }

  const actionId =
    input.entry.action === "accept"
      ? "plan.accept"
      : input.entry.action === "cancel"
        ? "plan.cancel"
        : "plan.reject";
  const payload: JsonPayload =
    input.entry.action === "accept"
      ? { approvalId: input.entry.approvalId }
      : input.entry.action === "revise"
        ? {
            approvalId: input.entry.approvalId,
            feedback: "Please revise the plan.",
          }
        : input.entry.action === "reject"
          ? {
              approvalId: input.entry.approvalId,
              feedback: "Rejected from Telegram.",
            }
          : { approvalId: input.entry.approvalId };
  const result = await dispatchSessionAction(
    input.actions,
    actionId,
    input.entry.sessionKey,
    payload,
  );
  if (!isActionOk(result)) {
    await clearButtons(input.ctx);
    await reply(input.ctx, `Plan action failed: ${actionError(result)}`);
    return;
  }
  await clearButtons(input.ctx);
  const message =
    input.entry.action === "accept"
      ? "Plan approved. The agent will resume."
      : input.entry.action === "cancel"
        ? "Plan mode cancelled."
        : "Plan sent back for revision.";
  await reply(input.ctx, message);
}

async function handleQuestionCallback(input: {
  ctx: TelegramInteractiveContext;
  entry: QuestionTokenEntry;
  actions: Map<string, SessionActionHandler>;
  store: PlanModeStore;
}): Promise<void> {
  const snap = await input.store.readSnapshot(input.entry.sessionKey);
  const pending = snap?.pendingQuestion;
  if (!pending || pending.questionId !== input.entry.questionId) {
    await clearButtons(input.ctx);
    await reply(input.ctx, "That question button is stale. Use /plan status for the current state.");
    return;
  }
  if (!pending.allowFreetext && !pending.options.includes(input.entry.selectedOption)) {
    await clearButtons(input.ctx);
    await reply(input.ctx, "That question option is stale. The agent has asked a newer question.");
    return;
  }

  const result = await dispatchSessionAction(
    input.actions,
    "plan.answer",
    input.entry.sessionKey,
    {
      questionId: input.entry.questionId,
      questionPrompt: input.entry.questionPrompt,
      selectedOption: input.entry.selectedOption,
    },
  );
  if (!isActionOk(result)) {
    await reply(input.ctx, `Answer failed: ${actionError(result)}`);
    return;
  }
  const clear = await input.store.clearPendingQuestion({
    sessionKey: input.entry.sessionKey,
    expectedQuestionId: input.entry.questionId,
  });
  if (clear.kind === "failed") {
    await input.ctx.respond.reply?.({
      text:
        "Answer recorded, but I could not clear the pending question marker. " +
        "A repeated click will be ignored by the injection idempotency key.",
    });
  }
  await clearButtons(input.ctx);
  await reply(input.ctx, "Answer recorded. The agent will resume.");
}

export interface PlanApprovalNotificationInput {
  sessionKey: string;
  approvalId: string;
  title: string;
  summary?: string;
  plan: PlanStep[];
  persistedPlan?: PersistPlanArchetypeMarkdownResult;
}

export interface QuestionNotificationInput {
  sessionKey: string;
  questionId: string;
  questionPrompt: string;
  options: string[];
}

export interface PlanModeNotificationSink {
  notifyPlanApproval(input: PlanApprovalNotificationInput): Promise<void>;
  notifyQuestion(input: QuestionNotificationInput): Promise<void>;
}

export function createPlanModeNotifications(input: {
  api: OpenClawPluginApi;
  store: PlanModeStore;
  actions: Map<string, SessionActionHandler>;
}): PlanModeNotificationSink {
  const api = input.api as OpenClawPluginApiWithRuntimeNotifications;
  const registerInteractiveHandler = (
    api as { registerInteractiveHandler?: RegisterInteractiveHandler }
  ).registerInteractiveHandler;
  registerInteractiveHandler?.({
    channel: "telegram",
    namespace: TELEGRAM_PLAN_INTERACTIVE_NAMESPACE,
    handler: async (ctx: TelegramInteractiveContext) => {
      if (!isAuthorized(ctx)) {
        await reply(ctx, "You are not authorized to use this plan action.");
        return { handled: true };
      }
      const [action, token] = ctx.callback.payload.split(":", 2);
      if (!action || !token) {
        await reply(ctx, "Invalid plan action payload.");
        return { handled: true };
      }
      const entry = consumeToken(token);
      if (!entry) {
        await clearButtons(ctx);
        await reply(ctx, "That plan action has expired. Use /plan status for the current state.");
        return { handled: true };
      }
      if (entry.kind === "approval") {
        await handleApprovalCallback({
          ctx,
          entry,
          actions: input.actions,
          store: input.store,
        });
        return { handled: true };
      }
      if (entry.kind === "question") {
        await handleQuestionCallback({
          ctx,
          entry,
          actions: input.actions,
          store: input.store,
        });
        return { handled: true };
      }
      return { handled: true };
    },
  });

  return {
    async notifyPlanApproval(params) {
      const rendered = renderPlanPresentation(params);
      try {
        const delivered = await sendPresentation(api, {
          sessionKey: params.sessionKey,
          files: params.persistedPlan ? [{ path: params.persistedPlan.absPath }] : [],
          text: renderPlanText(params),
          presentation: rendered.presentation,
          forceDocument: params.persistedPlan ? true : undefined,
          captionFormat: "plain",
          channelHints: {
            telegram: {
              disableNotification: false,
            },
          },
        });
        if (!delivered) {
          discardTokens(rendered.tokens);
        }
      } catch (error) {
        discardTokens(rendered.tokens);
        throw error;
      }
    },
    async notifyQuestion(params) {
      const rendered = renderQuestionPresentation(params);
      try {
        const delivered = await sendPresentation(api, {
          sessionKey: params.sessionKey,
          files: [],
          text: `Question: ${params.questionPrompt}`,
          presentation: rendered.presentation,
          captionFormat: "plain",
        });
        if (!delivered) {
          discardTokens(rendered.tokens);
        }
      } catch (error) {
        discardTokens(rendered.tokens);
        throw error;
      }
    },
  };
}

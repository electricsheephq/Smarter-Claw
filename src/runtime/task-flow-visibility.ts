import type { PlanModeSessionState } from "../types.js";

export const PLAN_MODE_TASK_FLOW_CONTROLLER_ID = "smarter-claw.plan-mode";

type Logger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

type JsonRecord = Record<string, unknown>;

type ManagedTaskFlowRecordLike = {
  flowId?: unknown;
  revision?: unknown;
  controllerId?: unknown;
  status?: unknown;
  stateJson?: unknown;
};

type ManagedTaskFlowMutationResultLike = {
  applied?: boolean;
  code?: unknown;
};

type BoundTaskFlowRuntimeLike = {
  createManaged?: (params: JsonRecord) => ManagedTaskFlowRecordLike | null | undefined;
  list?: () => ManagedTaskFlowRecordLike[];
  setWaiting?: (params: JsonRecord) => ManagedTaskFlowMutationResultLike;
  finish?: (params: JsonRecord) => ManagedTaskFlowMutationResultLike;
};

type PluginRuntimeTaskFlowLike = {
  bindSession?: (params: { sessionKey: string }) => BoundTaskFlowRuntimeLike;
};

export type PlanModeTaskFlowTransition = {
  sessionKey: string;
  prev: PlanModeSessionState | undefined;
  next: PlanModeSessionState;
  source: string;
};

export type PlanModeTaskFlowVisibility = {
  recordTransition(event: PlanModeTaskFlowTransition): Promise<void>;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRuntimeTaskFlow(api: unknown): PluginRuntimeTaskFlowLike | undefined {
  const runtime = isRecord(api) ? api.runtime : undefined;
  if (!isRecord(runtime)) return undefined;
  const tasks = isRecord(runtime.tasks) ? runtime.tasks : undefined;
  const managedFlows = isRecord(tasks?.managedFlows) ? tasks?.managedFlows : undefined;
  const legacyTaskFlow = isRecord(runtime.taskFlow) ? runtime.taskFlow : undefined;
  const candidate = managedFlows ?? legacyTaskFlow;
  return typeof candidate?.bindSession === "function"
    ? (candidate as PluginRuntimeTaskFlowLike)
    : undefined;
}

function getApprovalIdFromFlow(flow: ManagedTaskFlowRecordLike): string | undefined {
  if (!isRecord(flow.stateJson)) return undefined;
  const kind = flow.stateJson.kind;
  const approvalId = flow.stateJson.approvalId;
  if (kind !== "smarter-claw.plan-mode" || typeof approvalId !== "string") {
    return undefined;
  }
  return approvalId;
}

function getSessionKeyFromFlow(flow: ManagedTaskFlowRecordLike): string | undefined {
  if (!isRecord(flow.stateJson)) return undefined;
  const kind = flow.stateJson.kind;
  const sessionKey = flow.stateJson.sessionKey;
  if (kind !== "smarter-claw.plan-mode" || typeof sessionKey !== "string") {
    return undefined;
  }
  return sessionKey;
}

function getRevision(flow: ManagedTaskFlowRecordLike): number | undefined {
  return typeof flow.revision === "number" && Number.isFinite(flow.revision)
    ? flow.revision
    : undefined;
}

function getFlowId(flow: ManagedTaskFlowRecordLike): string | undefined {
  return typeof flow.flowId === "string" && flow.flowId.trim().length > 0
    ? flow.flowId
    : undefined;
}

function findFlowForApprovalId(
  bound: BoundTaskFlowRuntimeLike,
  approvalId: string,
): ManagedTaskFlowRecordLike | undefined {
  const flows = typeof bound.list === "function" ? bound.list() : [];
  return flows.find(
    (flow) =>
      flow.controllerId === PLAN_MODE_TASK_FLOW_CONTROLLER_ID &&
      getApprovalIdFromFlow(flow) === approvalId,
  );
}

function findActiveFlowForSession(
  bound: BoundTaskFlowRuntimeLike,
  sessionKey: string,
): ManagedTaskFlowRecordLike | undefined {
  const flows = typeof bound.list === "function" ? bound.list() : [];
  return flows.find(
    (flow) =>
      flow.controllerId === PLAN_MODE_TASK_FLOW_CONTROLLER_ID &&
      flow.status !== "finished" &&
      getSessionKeyFromFlow(flow) === sessionKey,
  );
}

function buildStateJson(event: PlanModeTaskFlowTransition): JsonRecord {
  return {
    kind: "smarter-claw.plan-mode",
    sessionKey: event.sessionKey,
    source: event.source,
    mode: event.next.mode,
    approval: event.next.approval,
    ...(event.next.approvalId ? { approvalId: event.next.approvalId } : {}),
    ...(event.next.title ? { title: event.next.title } : {}),
    ...(event.next.lastPlanSteps ? { steps: event.next.lastPlanSteps } : {}),
    rejectionCount: event.next.rejectionCount,
    updatedAt: Date.now(),
  };
}

function warnMutationFailure(
  logger: Logger,
  action: string,
  result: ManagedTaskFlowMutationResultLike | undefined,
): void {
  if (!result || result.applied !== false) return;
  logger.warn?.(
    `[smarter-claw] task-flow visibility ${action} skipped: ${String(result.code ?? "unknown")}`,
  );
}

export function createPlanModeTaskFlowVisibility(input: {
  api: unknown;
  logger?: Logger;
}): PlanModeTaskFlowVisibility {
  const taskFlow = getRuntimeTaskFlow(input.api);
  const logger = input.logger ?? {};

  return {
    async recordTransition(event) {
      if (!taskFlow?.bindSession) {
        logger.debug?.(
          "[smarter-claw] task-flow visibility skipped: host runtime has no managed TaskFlow API",
        );
        return;
      }
      const bound = taskFlow.bindSession({ sessionKey: event.sessionKey });
      try {
        if (event.next.approval === "pending" && event.next.approvalId) {
          if (findFlowForApprovalId(bound, event.next.approvalId)) {
            return;
          }
          const existingSessionFlow = findActiveFlowForSession(bound, event.sessionKey);
          const existingFlowId = existingSessionFlow
            ? getFlowId(existingSessionFlow)
            : undefined;
          const expectedRevision = existingSessionFlow
            ? getRevision(existingSessionFlow)
            : undefined;
          if (existingFlowId && expectedRevision !== undefined && bound.setWaiting) {
            const result = bound.setWaiting({
              flowId: existingFlowId,
              expectedRevision,
              currentStep: "Awaiting operator approval",
              stateJson: buildStateJson(event),
              waitJson: {
                kind: "plan_approval",
                approvalId: event.next.approvalId,
                sessionKey: event.sessionKey,
              },
            });
            warnMutationFailure(logger, "setWaiting", result);
            if (!result || result.applied !== false) {
              return;
            }
          }
          bound.createManaged?.({
            controllerId: PLAN_MODE_TASK_FLOW_CONTROLLER_ID,
            goal: `Plan approval: ${event.next.title ?? event.next.approvalId}`,
            status: "waiting",
            currentStep: "Awaiting operator approval",
            stateJson: buildStateJson(event),
            waitJson: {
              kind: "plan_approval",
              approvalId: event.next.approvalId,
              sessionKey: event.sessionKey,
            },
          });
          return;
        }

        const approvalId = event.next.approvalId ?? event.prev?.approvalId;
        if (!approvalId) return;
        const flow = findFlowForApprovalId(bound, approvalId);
        if (!flow) return;
        const flowId = getFlowId(flow);
        const expectedRevision = getRevision(flow);
        if (!flowId || expectedRevision === undefined) return;

        if (event.next.approval === "rejected") {
          warnMutationFailure(
            logger,
            "setWaiting",
            bound.setWaiting?.({
              flowId,
              expectedRevision,
              currentStep: "Plan rejected; waiting for revised plan",
              stateJson: buildStateJson(event),
              waitJson: {
                kind: "plan_revision",
                approvalId,
                feedback: event.next.feedback ?? null,
                sessionKey: event.sessionKey,
              },
            }),
          );
          return;
        }

        if (
          event.next.approval === "approved" ||
          event.next.approval === "edited" ||
          event.next.approval === "none"
        ) {
          warnMutationFailure(
            logger,
            "finish",
            bound.finish?.({
              flowId,
              expectedRevision,
              stateJson: buildStateJson(event),
            }),
          );
        }
      } catch (error) {
        logger.warn?.(
          `[smarter-claw] task-flow visibility bridge failed: ${(error as Error).message}`,
        );
      }
    },
  };
}

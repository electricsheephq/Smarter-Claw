# Sprint 2 — Host-mutation queue design (companion to SPRINT-2-PLAN.md)

**Status**: ready for implementation (Plan agent verdict 2026-04-25)
**Scope**: closes Sprint 2 PR-a Blocker #1 (host patch as continuing slot writer)

## Summary

Per-session JSONL queue file at `~/.openclaw/state/smarter-claw/<sessionKeyHash>.mutations.jsonl`. Host patch atomically appends mutation records (POSIX `O_APPEND` write ≤ 3584 B); plugin drains via rename-and-process inside `withPluginState` under file lock. Idempotent via bounded LRU of `appliedMutationIds` (256 entries / session).

## Record schema (v1)

```ts
type HostMutationRecord = {
  v: 1;
  mutationId: string;       // UUIDv4
  sessionKey: string;
  submittedAt: number;      // unix-ms
  submittedBy: "host-patch" | "slash-command-host" | "test-fixture";
  kind: "approve" | "reject" | "edit" | "answer" | "auto-toggle" | "mode-set";
  payload: /* discriminated by kind, see full spec */;
  agentId?: string;
  uiSurface?: string;
};
```

## Append protocol (host patch)

```ts
function enqueueHostMutation(rec, paths) {
  const line = JSON.stringify(rec) + "\n";
  if (Buffer.byteLength(line) > 3584) {
    log.warn("smarter-claw.host-mutation.oversize", { id: rec.mutationId });
    return; // drop loudly
  }
  fs.appendFileSync(pathFor(paths, rec.sessionKey), line, { flag: "a", mode: 0o600 });
}
```

POSIX guarantees atomic single-`write(2)` for `O_APPEND` to regular files at any size, regardless of `PIPE_BUF`. 3584 B cap is conservative safety margin.

## Drain protocol (plugin, inside withPluginState)

Rename-and-process pattern — atomic queue rotation:

```
1. Recover staging file if exists (crash recovery)
2. fs.renameSync(queue, staging)        // atomic; new appends create fresh queue
3. parse staging JSONL, skip malformed/version-mismatch
4. for each record: skip if appliedMutationIds[id]; else apply + record
5. caller's update(state) runs against drained state
6. write file (atomic rename of tmp)
7. unlink staging
```

Crash safety:
- Crash 1-7: staging persists; next drain detects + recovers via `appliedMutationIds`.
- Crash 6-7: staging records already in `appliedMutationIds`; safe to unlink.

## Idempotency

`appliedMutationIds: Record<mutationId, submittedAt>` bounded to 256 entries (LRU by submittedAt). Drain order is FIFO via `O_APPEND` semantics — older mutationIds dropping out cannot re-enter.

## Schema versioning

Top-level `v` field. Plugin drops `v ≠ 1` records with `queue.rejected-version` log. Host patch carries plugin-version-built-against in `patch-plan.json` `expectedHostVersion`.

## Cleanup

- Per-session: unlink queue + staging + state files together via `on:session_deleted` SDK hook
- Weekly GC (out of PR-a scope): delete `*.mutations.jsonl` whose mtime > 30d AND state file missing
- Drain-time: WARN `queue.staging-stale` if staging file > 5 min old

## Required test scenarios (8)

1. Happy path: append → drain → state reflects → files cleaned
2. Concurrent append + drain (race on rename moment)
3. Crash mid-drain (post-rename, mid-apply) → recovery deduplicates
4. Crash post-state-write, pre-staging-unlink → idempotent recovery
5. Oversize record → reject + log, no state change
6. Malformed JSONL line → skip + log, process rest
7. Version mismatch → reject-unknown + log, process rest
8. Multi-process append (forward-looking; documents single-process drain assumption)

## Cross-process safety

Single-process today (Sprint 2 Risk 1). Append is multi-process-safe via `O_APPEND`; drain is NOT (would need `flock(2)` on queue file). Multi-process drain support is future work pending upstream RFC openclaw/openclaw#71260.

## Implementation files

- NEW `src/host-mutation-queue.ts` — append helper for host patch reuse + drain helper for plugin
- NEW `src/plugin-state-store.ts` — `withPluginState` integrates drain at top of update closure
- AMEND `installer/patches/core/sessions-patch-handler-plan-mode.diff` — replace direct slot writes with `enqueueHostMutation` calls
- AMEND `runtime-api.ts` — `persistSmarterClawState` consumes drained state via `withPluginState`

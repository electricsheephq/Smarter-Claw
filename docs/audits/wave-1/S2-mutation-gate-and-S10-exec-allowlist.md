# Wave-1 audit A2 — Slices S2 + S10

**Subject**: `src/gates/mutation-gate.ts` (plan-mode `before_tool_call` fail-CLOSED gate) and the exec/bash read-only allowlist + dangerous-flag blocklist embedded within it.

**Method**: read-only first-principles security analysis. Cross-checked plugin port against in-host source at `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/mutation-gate.ts` (the parity-contract anchor). No code executed; no commits made.

**Posture being audited**: fail-CLOSED. Default-deny for unknown tools when `mode === "plan"`.

---

## 1. Slice summary

S2 is the security boundary that enforces "plan mode = read-only" by intercepting every `before_tool_call` event and blocking any tool not on an explicit allowlist (or matching a read-only suffix). S10 is the same file's exec/bash subsystem: when the agent calls exec/bash in plan mode, the command string is checked against a hardcoded read-only-prefix allowlist plus a hardcoded dangerous-flag blocklist.

The two slices are tightly coupled — they live in one function (`checkMutationGate`) and share a single fail-CLOSED contract. Slip in either and the entire plan-mode "agent cannot mutate the workspace" promise fails.

Hook wiring point: `/Users/lume/repos/Smarter-Claw/src/index.ts:332-383` (the `before_tool_call` handler).

---

## 2. Documented contracts

### 2.1 `PLAN_MODE_ALLOWED_TOOLS` (17 entries)

| # | Tool | Rationale |
|---|------|-----------|
| 1 | `read` | Core read tool |
| 2 | `web_search` | Read-only research |
| 3 | `web_fetch` | Read-only research |
| 4 | `memory_search` | Read memory |
| 5 | `memory_get` | Read memory |
| 6 | `update_plan` | State transition only |
| 7 | `exit_plan_mode` | Plan-mode lifecycle |
| 8 | `session_status` | Read session metadata |
| 9 | `ask_user_question` | Non-mutating clarification |
| 10 | `enter_plan_mode` | Idempotent state transition |
| 11 | `sessions_spawn` | Research-subagent spawn |
| 12 | `plan_mode_status` | Read-only introspection |
| 13 | `sessions_list` | Read sessions |
| 14 | `sessions_history` | Read sessions |
| 15 | `sessions_yield` | Suspend turn (read-only signal) |
| 16 | `lcm_grep` | LCM read-only substring |
| 17 | `lcm_expand_query` | LCM read-only query expansion |

### 2.2 `MUTATION_TOOL_BLOCKLIST` (11 entries)

`apply_patch`, `bash`, `edit`, `exec`, `gateway`, `message`, `nodes`, `process`, `sessions_send`, `subagents`, `write`.

NB: `sessions_spawn` deliberately NOT here.

### 2.3 Mutation suffix patterns (3)

`.write`, `.edit`, `.delete`.

### 2.4 Read-only suffix patterns (5)

`.read`, `.search`, `.list`, `.get`, `.view`.

### 2.5 `READ_ONLY_EXEC_PREFIXES` (22 entries)

`ls`, `cat`, `pwd`, `git status`, `git log`, `git diff`, `git show`, `which`, `find`, `grep`, `rg`, `head`, `tail`, `wc`, `file`, `stat`, `du`, `df`, `echo`, `printenv`, `whoami`, `hostname`, `uname`.

Matching rule: `cmd === prefix || cmd.startsWith(prefix + " ")` (anchored prefix, space-terminated).

### 2.6 `DANGEROUS_FLAGS` (10 entries)

`-delete`, `-exec`, `-execdir`, `--delete`, `-rf`, `--output`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`.

Matching rule: regex `(?:^|[\s])<flag>(?:[\s=]|$)` (word-boundary, case-insensitive).

### 2.7 Shell-operator blocklist (regex)

`/[;|&` + backtick + `\n\r]|\$\(|>>?|<\(|>\(/` — that is: `;`, `|`, `&`, backtick, LF, CR, `$(...)`, `>`, `>>`, `<(...)`, `>(...)`.

### 2.8 Fail-modes (declared)

| Condition | Behavior |
|---|---|
| `mode !== "plan"` | allow all (gate dormant) |
| Tool in allowlist | allow |
| Tool is exec/bash + command has shell operator | block |
| Tool is exec/bash + command has dangerous flag | block |
| Tool is exec/bash + command has read-only prefix | allow |
| Tool in blocklist | block |
| Tool ends with mutation suffix | block |
| Tool ends with read-only suffix | allow |
| Anything else | block (default-deny) |

---

## 3. Test coverage matrix

Plugin tests: `/Users/lume/repos/Smarter-Claw/tests/gates/mutation-gate.test.ts` (260 lines, 59 `it`/`describe` calls).

| Contract | Plugin test file:line | In-host test file:line |
|---|---|---|
| Normal mode allows mutation tools | mutation-gate.test.ts:28-46 | mutation-gate.test.ts:5-12 |
| Plan mode blocks every entry in MUTATION_TOOL_BLOCKLIST | mutation-gate.test.ts:48-59 (table-driven via `_testing`) | mutation-gate.test.ts:14-44 |
| Plan mode allows every entry in PLAN_MODE_ALLOWED_TOOLS | mutation-gate.test.ts:61-73 | mutation-gate.test.ts:47-70 |
| `.write` / `.edit` / `.delete` suffix blocked | mutation-gate.test.ts:75-86 | mutation-gate.test.ts:72-83 |
| `.read` / `.search` / `.list` / `.get` / `.view` suffix allowed | mutation-gate.test.ts:89-102 | mutation-gate.test.ts:85-88 |
| Read-only exec prefix allowed (per-prefix table) | mutation-gate.test.ts:110-122 (table via `_testing`) | mutation-gate.test.ts:91-117 (manual list) |
| bash with read-only command allowed | mutation-gate.test.ts:123-126 | mutation-gate.test.ts:149-152 |
| Non-allowlisted exec blocked | mutation-gate.test.ts:128-131 | mutation-gate.test.ts:119-132 |
| bash without command blocked | mutation-gate.test.ts:134-138 | mutation-gate.test.ts:155-161 |
| Semicolon chaining blocked | mutation-gate.test.ts:141-145 | mutation-gate.test.ts:172-174 |
| Pipe blocked | mutation-gate.test.ts:147-149 | mutation-gate.test.ts:168-170 |
| Background `&` blocked | mutation-gate.test.ts:151-153 | **GAP in in-host; covered in plugin** |
| Backtick subshell blocked | mutation-gate.test.ts:155-157 | **GAP in in-host; covered in plugin** |
| `$()` subshell blocked | mutation-gate.test.ts:159-161 | **GAP in in-host; covered in plugin** |
| `>` and `>>` redirects blocked | mutation-gate.test.ts:163-166 | mutation-gate.test.ts:164-166 |
| `<(...)` / `>(...)` process substitution blocked | mutation-gate.test.ts:168-171 | **GAP in in-host; covered in plugin** |
| LF in command blocked | mutation-gate.test.ts:175-177 | mutation-gate.test.ts:139-142 |
| CR in command blocked | mutation-gate.test.ts:179-181 | mutation-gate.test.ts:141-142 |
| Every entry in DANGEROUS_FLAGS table-tested | mutation-gate.test.ts:185-191 | **GAP in in-host (only -delete + -exec tested)** |
| `-fprint` flag blocked | mutation-gate.test.ts:199-203 | mutation-gate.test.ts:185-190 (via DANGEROUS_FLAGS loop) |
| `-executable` does NOT match `-exec` | mutation-gate.test.ts:212-216 | mutation-gate.test.ts:194-196 |
| `-deletefoo` does NOT match `-delete` | mutation-gate.test.ts:218-223 | **GAP in in-host** |
| Default-deny on unknown tool | mutation-gate.test.ts:238-241 | **GAP — in-host has no explicit default-deny test** |
| Case-insensitive matching of tool names | mutation-gate.test.ts:69-72 + 104-107 | mutation-gate.test.ts:42-43 |
| Reason text mentions `exit_plan_mode` | mutation-gate.test.ts:250-258 | **GAP in in-host** |

### Coverage gaps that EXIST in BOTH files

These are gaps relative to the threat model, regardless of which file we look at. The plugin port has more tests than the in-host but inherits the in-host's missing-coverage areas. See Section 4 below for the full P0/P1/P2 list.

---

## 4. Testing gaps

Severity rubric (per instructions):

- **P0** = bypass possible (security regression — fail-CLOSED is breached).
- **P1** = over-blocks legitimate use.
- **P2** = unclear or fragile assertion.

### P0 — security regression risks

1. **P0 — Unicode/non-ASCII whitespace bypass on read-only prefix matching.** The matching rule is `cmd === prefix || cmd.startsWith(prefix + " ")` where the separator is ASCII U+0020 only. An agent that submits `ls -la` (non-breaking space) or `ls　-la` (CJK full-width space) does NOT match the prefix and hits the blocklist — but does the regex `/[;|&\`\n\r]|\$\(|>>?|<\(|>\(/` see U+00A0 as not-a-shell-operator and let it through? On Linux/macOS, `ls -la` is sent to `bash`, which would interpret U+00A0 differently. Behavior unspecified — no test. **Note: this gap reduces to a P2 in practice because the path it enables hits the default-deny (the prefix doesn't match → falls through to blocklist → exec/bash is in blocklist → block). But the test corpus does not pin this, so a future refactor that moves the prefix check could open the hole.**

2. **P0 — Tab as command-side separator inside prefix match.** Same as above for `\t`. The DANGEROUS_FLAGS regex `(?:^|[\s])<flag>(?:[\s=]|$)` includes `\s` (tab counts). But the prefix matcher uses literal `" "` only. So `find\t.\t-delete` (tabs instead of spaces) — does the prefix check fail, falling to blocklist? Or does the dangerous-flag check fire first? Walking the code: the shell-operator check runs first (no tab in its char class), then dangerous-flag check (tab counts as `\s`, would match `-delete`) → blocked. Likely safe but UNTESTED. The test corpus uses only ASCII space.

3. **P0 — `find . -fprintf /tmp/out '%p'` requires TWO arguments.** The dangerous-flag check matches `-fprintf` by word-boundary regex, so `find . -fprintf /tmp/out '%p'` is caught. But what about `find . -fprintf=/tmp/out %p`? The regex trailing class is `(?:[\s=]|$)` — `=` IS accepted. **Edge case verification: the equals-sign trailing path probably triggers but is not tested.** No test covers `flag=value` form for any DANGEROUS_FLAGS entry.

4. **P0 — `xargs` wrapping bypass.** `find . -type f | xargs rm -f` is blocked by the `|` shell-operator check. But `find . -type f -print0` would be allowed (no dangerous flag). What if the agent calls `bash` with `find . -name '*.tmp' -print` and then a SEPARATE `bash` call with `xargs rm`? Each individual call passes the gate but the combined effect is destruction. The gate cannot defend against this serialized attack — it operates per-call. **Documented gap; not a code bug but an unstated limitation.**

5. **P0 — Wildcard / glob expansion in `cat`/`ls` args.** `cat /etc/shadow /etc/passwd > out.txt` is blocked (redirect). But `cat /root/.ssh/id_rsa` is allowed by the read-only prefix matcher. The gate trusts `cat` to be benign, but `cat` against sensitive files is a data-exfil vector. No exfil filter exists; no test asserts whether one is expected. The contract states "blocks mutation tools" — exfiltration via `cat` is not mutation. **Not a code bug, but the test corpus does NOT pin the negative: there is no test asserting that arbitrary file reads via `cat` are intentionally allowed.** A future reviewer might add a path-block that breaks the (probably intentional) silent allow.

6. **P0 — `grep -r --include='*' --files-with-matches PATTERN /` is allowed.** `grep` is a prefix; no dangerous flag check fires. The agent could enumerate every file containing a secret. Same exfil class as #5; intentionally allowed in plan-mode but UNTESTED contract.

7. **P0 — `find . -newer /tmp/marker -print -name '*-token*'` allowed.** Same class — read enumeration permitted by design but no negative-disclosure test.

8. **P0 — Empty-string `toolName`.** `checkMutationGate("", "plan")` → `normalized = ""`, not in allowlist, not exec/bash, not in blocklist, no suffix match, **falls through to default-deny → block.** Behavior correct but UNTESTED. If a future refactor short-circuits the empty case (e.g. `if (!normalized) return { blocked: false }`), the gate is silently broken.

9. **P0 — Whitespace-only `toolName`.** `checkMutationGate("   ", "plan")` → `normalized = ""` after `trim()`. Same as #8. UNTESTED.

10. **P0 — `toolName` with embedded LF.** `checkMutationGate("write\nfoo", "plan")` → `normalized = "write\nfoo"`. Does NOT match "write" in blocklist. Does NOT end with ".write" suffix (ends with "foo"). Default-deny → block. Correct behavior but UNTESTED. If the host happens to normalize tool names elsewhere (strip newlines before passing to the gate), an attacker who manages to inject a newline could match `"write"` after sanitization but miss the blocklist before. **Untested invariant.**

11. **P0 — `toolName` with leading/trailing whitespace.** `checkMutationGate(" write ", "plan")` → `normalized = "write"` after `trim()`. Blocked correctly. UNTESTED but works because of `trim()`.

12. **P0 — `toolName` with CRLF.** `checkMutationGate("write\r\n", "plan")` → `.trim()` removes the `\r\n` (V8 trim treats CR+LF as whitespace). UNTESTED.

13. **P0 — Suffix-match false-positive for `_write` (no dot).** `checkMutationGate("auto_write", "plan")` → does NOT end with `.write` (ends with `_write`). Falls to default-deny → block. Correct, but UNTESTED. If suffix is loosened to substring-match in a future refactor, this changes.

14. **P0 — Suffix-match TRUE-positive for `read.read`.** `checkMutationGate("read.read", "plan")` → "read" is in allowlist; allow check happens first. Returns allow. But what if the tool is genuinely `tool.read` and a mutator tool was named that way? Test corpus has `repo.read` but no adversarial `mutator.read`. Tests verify only the suffix routing, not the contract that "anything ending in .read is genuinely read-only" (which is the SDK plugin author's contract, not the gate's).

15. **P0 — `bash` with `command` param missing but `cmd` param present.** Hook wiring at `src/index.ts:362-368` extracts `params.command` OR `params.cmd`. Plugin tests verify the gate function but NOT the hook wiring. If `cmd` extraction is broken in a refactor, the gate gets `execCommand === undefined`, and the exec/bash branch's `if (... && execCommand)` short-circuits FALSE → falls to blocklist → block. Fail-closed by accident. UNTESTED integration.

16. **P0 — `bash` with `script` or `code` param (alternate plugin convention).** If an MCP-defined bash tool uses `params.script` instead of `params.command`/`params.cmd`, the gate sees `execCommand === undefined` → blocklist → block. Fail-closed by default-deny, but blocks LEGITIMATE use too. UNTESTED both ways.

17. **P0 — `event.toolName` empty string in hook.** `src/index.ts:374` passes `event.toolName` raw. If `event.toolName === ""`, gate returns default-deny (block). Correct, untested.

18. **P0 — `event.toolName` literally `"undefined"` or `"null"` (string).** Falls to default-deny. Correct, untested.

19. **P0 — Mode-flag tampering via host projection.** `src/index.ts:347-358` reads mode from `ctx.getSessionExtension("plan-mode")` FIRST, then falls back to the plugin's own store. If the host projection returns a malformed object (e.g. `{ mode: "PLAN" }` uppercase, `{ mode: "plan " }` with trailing space), the check `if (currentMode !== "plan")` at gate line 184 fails strict-equality and the gate goes DORMANT (mode becomes "normal"). **No test pins case-sensitive / whitespace-strict mode handling at the integration point.** Both layers — gate and hook wiring — assume the projection cache is well-formed. A future host-side bug that wraps `mode` in display formatting silently breaks the gate.

20. **P0 — Mode-flag tampering via store.** Same risk via `store.readSnapshot()` returning `{ mode: "Plan" }` or whitespace-padded. UNTESTED.

21. **P0 — `mode === "plan"` is the ONLY gate trigger.** Approval state `pending`/`approved`/`rejected` does NOT activate the mutation gate. Only the literal string `"plan"`. If a future PR adds a sub-mode (e.g. `"plan-deep"` or `"plan-strict"`), the gate goes dormant for that sub-mode. **UNTESTED forward-compat assertion.**

22. **P0 — `find . -okdir <cmd>` not in DANGEROUS_FLAGS.** `find` supports `-ok <cmd> ;` (prompts then exec) and `-okdir <cmd> ;` (same in directory). Both EXECUTE commands. `-exec`/`-execdir` are blocked; `-ok`/`-okdir` are NOT. This is a real bypass: `find . -ok rm {} ;` in an automated context where stdin is closed actually skips. But on a fresh shell it could execute. **Genuine gap — not tested, not in DANGEROUS_FLAGS.**

23. **P0 — `find -printf "%H%p\n" > /tmp/leak` form blocked by redirect, but `find -fprintf` (caught) and `-printf` (NOT caught).** `-printf` does NOT write a file (it writes to stdout). But `-printf` combined with `>` would, and `>` is in the shell-operator regex. The shell-operator check fires first, so `-printf` alone is allowed → reading. Bypass risk: `-printf` does no harm itself. **OK in practice but worth pinning.**

24. **P0 — `cat <file` redirect on the LEFT side.** The shell-operator regex matches `<(`/`>(`/`>`/`>>` but NOT a bare `<` (stdin redirect). `cat <file` would fail compile, actually — `cat <file` shells parse but the regex captures only `<(`. **Bare `<` not captured.** Is `cat <file` a hazard? It reads file via stdin redirect — no mutation. But it indicates the regex character class is intentionally narrower than full shell metachar coverage. UNTESTED.

25. **P0 — Heredoc `<<EOF ... rm -rf / EOF` NOT blocked.** The shell-operator regex catches `<(`, `>(`, `>`, `>>` — but `<<` (heredoc) is checked via `>>?` which only matches `>` followed by optional `>`, NOT `<<`. Heredoc body is opaque to the gate. `bash -c 'cat <<EOF\nrm -rf /\nEOF'` — but `-c` quoted args are passed to gate as a single string... actually the LF inside the heredoc IS caught by `\n` in the operator regex. So newlines save us. But `bash <<<"rm -rf /"` (herestring) — `<<<` is not in the regex. UNTESTED.

26. **P0 — `xargs` not in DANGEROUS_FLAGS or shell-operator regex.** `find . | xargs rm` is blocked by `|`. `find . -print0 -delete` is blocked by `-delete`. But `xargs -I {} rm {}` issued AS A NEW exec call (without pipe) is allowed by the prefix check failing → blocklist → block. So we're safe by default-deny but it's worth verifying no `xargs` prefix gets added later.

27. **P0 — `awk` not in READ_ONLY_EXEC_PREFIXES. Safe by default-deny.** But `awk` can be used as a payload runner: `find . -name '*.tmp' -exec awk '...' {} \;` — caught by `-exec`. `awk -i inplace` mutates files — but `awk` is not a prefix, so awk would be blocked by default. SAFE. Just pin the negative.

28. **P0 — `sed -i` not in DANGEROUS_FLAGS.** `sed` is NOT a read-only prefix, so `sed -i ...` falls through to blocklist (not in blocklist for bash/exec — wait, exec/bash ARE in blocklist, and if the prefix check doesn't match, the function exits the exec/bash branch and hits the blocklist). So `sed -i` via exec is blocked because the exec/bash branch couldn't allow it (no prefix match), the function continues past the exec/bash branch (no early return for blocked!), and the blocklist hit at line 229 catches `exec`. CONFUSING control flow worth documenting; the gate logic has only ONE early-allow in the exec branch, never an early-block from prefix mismatch. SAFE but UNTESTED.

29. **P0 — `tar -xf` / `tar --extract` / `zip` / `unzip` / `gunzip` not in READ_ONLY_EXEC_PREFIXES.** Safe by default-deny (block as non-prefix exec → blocklist → blocked because `exec` is blocklisted). But these are commonly-needed operations and the test corpus does NOT assert "these are intentionally blocked in plan mode" — a future reviewer adding `tar` to the read-only prefixes (which it ISN'T) would silently break the contract. **Untested negative.**

30. **P0 — `dd` not in any list.** Same as `tar`; safe by default-deny but UNTESTED.

31. **P0 — `cp` / `mv` / `ln` / `rename` not in any list.** Same. UNTESTED negatives.

32. **P0 — `chmod` / `chown` / `chgrp` / `setfacl` / `xattr` not in any list.** Permissions changes; safe by default-deny but UNTESTED.

33. **P0 — `mount` / `umount` not in any list.** UNTESTED.

34. **P0 — `mkfifo` / `mknod` not in any list.** UNTESTED.

35. **P0 — `curl` / `wget` / `nc` / `ncat` / `socat` / `ssh` / `scp` / `rsync` not in any list.** Network exfil. Safe by default-deny but UNTESTED. Documentation does not state "the gate intentionally allows exfil-via-cat-while-blocking-exfil-via-curl" — a future addition of `curl` to the read-only prefixes (because "curl is just a GET") would open a major hole.

36. **P0 — `python` / `node` / `ruby` / `perl` / `lua` / `osascript` / `python3 -c "..."` not in any list.** Default-denied. Same untested-negative class.

37. **P0 — `npm` / `pnpm` / `yarn` / `pip` / `gem` not in any list.** Default-denied. UNTESTED.

38. **P0 — `docker` / `podman` / `kubectl` / `helm` not in any list.** UNTESTED.

### P1 — over-block (legitimate uses blocked)

39. **P1 — `git diff --stat`, `git diff main...HEAD`** allowed because `git diff` prefix matches. **But `git diff > out.diff` (legitimate "save a diff for review") is blocked by `>` redirect.** Documented behavior; UX trade-off intentional. Pin the negative.

40. **P1 — `find . -name '*.ts' -printf '%p\n'` — `-printf` is NOT in DANGEROUS_FLAGS.** Legitimate read use; allowed. Untested allow.

41. **P1 — `find . -maxdepth 2 -type d` allowed; UNTESTED with multi-arg form.**

42. **P1 — `grep -r --include='*.ts' --exclude-dir=node_modules pattern .` — long argv. Allowed by prefix `grep`. UNTESTED with `--include`/`--exclude-dir` flags.**

43. **P1 — `du -sh /Users/lume/repos/openclaw-pr70071-rebase` allowed because `du` is a prefix.** But `du -sh ~/.openclaw` is also allowed — exposes existence + size of protected paths. UNTESTED negative-allow.

44. **P1 — `git show HEAD~5:src/secret.ts` allowed (read-only by design).** Reads HISTORICAL versions of files. Untested allow.

45. **P1 — Suffix `.read`/`.search` match on a multi-tier name like `mcp.repo.write.read` (dot-after-`.write`).** `normalized` = `mcp.repo.write.read`. Ends with `.read` → ALLOWED. **But the suffix-pattern order is: mutation-suffix check first (line 240-249), THEN read-only suffix (line 253-257). `endsWith(".write")` is FALSE here (it ends `.read`). So mutation check fails, read check passes, ALLOW.** Likely correct, but a dot-rich tool name like `repo.delete.read` is allowed — odd compositional name might confuse a future maintainer. UNTESTED.

46. **P1 — `web_fetch` allowed in plan mode** but `web_fetch` can side-effect over HTTP (POST to webhook). Allowlist is named "read-only" but `web_fetch` is not necessarily idempotent. **Documented limitation; UNTESTED contract.**

47. **P1 — `sessions_spawn` allowed in plan mode** spawns subagents which themselves run under their own plan-mode gate. The plugin assumes the subagent's runtime applies its OWN gate. **No test asserts that the subagent inherits plan-mode.** If subagent does NOT inherit plan-mode (host bug), `sessions_spawn` becomes a mutation-bypass.

### P2 — fragile assertion or unclear contract

48. **P2 — DANGEROUS_FLAGS defined inside function body in-host (line 194) vs. module const in plugin (line 150).** Same data, different scope. The plugin's `_testing` export at line 280 includes `DANGEROUS_FLAGS` which would NOT have been exportable from the in-host version. The plugin's tests rely on this exported value to drive the per-flag loop (mutation-gate.test.ts:185-191), so the plugin actually has BETTER coverage than the in-host by virtue of this refactor. But the parity-contract comment ("byte-identical algorithm port") is slightly violated by the scope change. Cosmetic.

49. **P2 — `MUTATION_TOOL_BLOCKLIST` contains `gateway`, `message`, `nodes`, `process`, `sessions_send`, `subagents`** — these are plugin/MCP tool names without clear documentation of what each does. If any of these names is reused for a different (read-only) purpose in a future MCP server, the gate over-blocks. Test corpus only verifies "blocked" without explaining what these tools are.

50. **P2 — `read-only suffix` order matters.** Mutation suffix is checked BEFORE read-only suffix. So `foo.delete.read` is checked first against `.write`/`.edit`/`.delete` — does `endsWith(".delete")` match `foo.delete.read`? NO (it ends `.read`). So this passes the mutation check, then matches `.read`. Allow. **OK behavior but very subtle ordering; only one test would catch a swap (the implicit `repo.read` test). No test pins "mutation suffix takes precedence over read suffix for ambiguous names."**

51. **P2 — `.read` suffix is allowed for ANY tool, including a hypothetical destructive `file.read` that interprets the tool name as "delete and re-create".** Suffix is a heuristic, not a contract. Documented but UNTESTED that a future MCP author cannot weaponize the suffix.

52. **P2 — `_testing` export at line 274.** Includes mutable Arrays returned from `Array.from(...)` — a test that mutates the arrays could corrupt internal state via... actually no, `Array.from(Set)` returns a NEW array. SAFE but worth pinning.

53. **P2 — No test for `MUTATION_SUFFIX_PATTERNS` ordering vs `MUTATION_TOOL_BLOCKLIST` priority.** A tool named `exec.write` is in NEITHER an exact blocklist match nor an exact allowlist match. `normalized = "exec.write"`. Allowlist miss. Exec/bash branch: `normalized === "exec"` is FALSE (string equality with `"exec"`), so the exec branch SKIPS. Falls to blocklist check (line 229) — `"exec.write"` not in `{apply_patch, bash, exec, ...}` → miss. Suffix check — ends with `.write` → BLOCK. Correct behavior. UNTESTED that the gate handles `<allowlist-prefix>.<mutation-suffix>` names correctly.

54. **P2 — `find . -execdir cmd ; ` — UPPERCASE form `-EXECDIR`.** Dangerous-flag regex has `"i"` flag (case-insensitive), so `-EXECDIR` matches. But the `cmd.toLowerCase()` call at line 198 normalizes the command anyway. **Double-protection; UNTESTED uppercase form.**

55. **P2 — `read-only prefix` doesn't normalize Unicode lookalikes.** `ls` could be Cyrillic `ӏs` (small letter palochka + s). Falls to default-deny. SAFE but UNTESTED.

56. **P2 — Reason string for default-deny says "Call exit_plan_mode to proceed".** For benign read-only tools that aren't in allowlist or suffix list (e.g. a brand-new MCP read tool), this is bad UX — telling the user to exit plan mode to perform a read. UX issue, not security.

57. **P2 — `cmd` variable is `lowercased` at line 198, but `execCommand` (original) is NOT used for the dangerous-flag regex** — the regex uses `cmd` (lowercased). Good. But `DESTRUCTIVE_ESCAPE_PATTERNS` in `accept-edits-gate.ts:165-188` runs against the original `execCommand` (NOT lowercased). The two gates have inconsistent normalization. Cosmetic divergence; UNTESTED interaction.

58. **P2 — `mode === "plan"` is checked at the START of `checkMutationGate`. But the hook handler at `src/index.ts:373` already gates with `if (mode === "plan")`.** Defense-in-depth (gate function is internally complete) but the duplicate check is invisible to anyone reading the hook handler. If someone removes the inner check (assuming the outer gates), it's actually fine; if someone removes the outer check (assuming the inner gates), the function is called for every tool call in normal mode but returns early. Minor perf concern. UNTESTED.

---

## 5. Adversarial questions the test corpus does not address

The following attack vectors are not exercised. Some land in the safe-by-coincidence bucket; some are real gaps:

- **Q1.** What happens with `checkMutationGate("EXEC", "plan", "RM -RF /")`? The tool name normalizes to `"exec"` (allowed branch), but `cmd = "rm -rf /"` (lowercased). `-rf` is in DANGEROUS_FLAGS → block. SAFE. No test.

- **Q2.** What happens with `checkMutationGate("exec", "plan", "ls ; rm -rf /")`? `;` matches shell-operator regex → block immediately. SAFE. Tested at line 142.

- **Q3.** What happens with `checkMutationGate("exec", "plan", "ls\t-la")` (tab not space)? `ls\t-la` — prefix check requires `ls ` (with literal space). Falls through. Blocklist hits `exec` → block. SAFE by accident. **Untested.** Refactor risk: if someone changes the prefix match to use `\s` instead of literal space, this BECOMES allowed... still safe because tab is in `\s` for dangerous-flag regex... but the legitimate case `ls -la` would still pass. UX-wise probably benign.

- **Q4.** What happens with `checkMutationGate("exec", "plan", " ls -la")` (leading space)? `cmd = execCommand.trim().toLowerCase()` → trimmed to `"ls -la"`. SAFE. Untested.

- **Q5.** What happens with `checkMutationGate("exec", "plan", "ls\t\t\t-la")` (multiple tabs)? Same as Q3 — falls through, blocked. **Refactor risk: if someone "normalizes" whitespace to single space, this would become allowed (legitimate); the gate currently doesn't.**

- **Q6.** What happens with `checkMutationGate("exec", "plan", "ls​-la")` (zero-width space)? Likely passes the shell-operator regex (ZWSP not in char class), fails prefix match (no ASCII space), falls to blocklist → block. SAFE. Untested.

- **Q7.** What if a tool name is `"write​"` (zero-width space trailing)? `trim()` does NOT remove ZWSP. `normalized = "write​"`. Not in blocklist (`"write"` is). Not ending in `.write` (ends in `​`). Falls to default-deny. SAFE. Untested.

- **Q8.** `bash -c "<base64>" | base64 -d | sh` — sequence of pipes blocked by `|`. SAFE.

- **Q9.** `bash -c $'\\x72\\x6d -rf /'` — `$'...'` is bash's ANSI-C quoting; expands `\x72\x6d` to `rm`. The `$'` opens with `$` which doesn't match `$(`. Shell-operator regex doesn't catch `$'`. The hex-escape pattern `/\\x[0-9a-f]{2}/i` from `accept-edits-gate.ts:185` WOULD catch this, but **`mutation-gate.ts` does NOT have that pattern.** Plan mode under exec/bash: `bash -c $'\\x72\\x6d -rf /'` — prefix check fails (`bash -c` not in prefix list), exec/bash branch exits, blocklist hits `bash` → block. SAFE BY DEFAULT-DENY. But if someone adds `bash` or `sh -c` to the read-only prefix list, this becomes a high-severity bypass. **Untested negative; risk lives in the test suite's silence about hex/octal escapes.**

- **Q10.** `git diff --no-pager -- 'rm -rf /'` — prefix match succeeds (`git diff`), no shell operators, no dangerous flags. ALLOWED. The path argument `'rm -rf /'` is a file path; `git diff` against a non-existent path is a no-op. SAFE. Untested.

- **Q11.** `git log -p --all --format=%H' '%s | rm` — pipe blocked. SAFE.

- **Q12.** `git diff --output=/tmp/leak` — `--output` is in DANGEROUS_FLAGS! Blocked. SAFE. The dangerous-flag regex `(?:^|[\s])--output(?:[\s=]|$)` would also catch `--output=/tmp/leak` because of the `=` trailing. Tested via the per-flag loop in plugin tests at line 185-191.

- **Q13.** `find . -name foo.ts -prune -o -delete` — `-delete` caught. SAFE.

- **Q14.** `find . -name foo.ts -ok rm {} \;` — `-ok` NOT in DANGEROUS_FLAGS! `-exec rm` is, but `-ok rm` is not. The argument to `-ok` is the command — but the gate doesn't analyze it; just looks for literal `-exec`/`-execdir`. **This is gap #22 above; it's a real bypass via `find -ok`.** Untested, not in DANGEROUS_FLAGS.

- **Q15.** `find . -newerXY 'now' -delete` — `-delete` caught. SAFE.

- **Q16.** `find . -newer /tmp/some/file -fls /tmp/out` — `-fls` caught. SAFE.

- **Q17.** `find . -fprint0 /tmp/out` — caught. SAFE.

- **Q18.** What about `bash -c "ls && rm -rf"` (parameter is a quoted string with `&&`)? The exec/bash branch gets `cmd = "ls && rm -rf"`. Shell-operator regex catches `&` (single `&` is in the char class — but `&&` is two consecutive `&`, the regex `[;|&...]` matches the first `&`). Blocked. SAFE.

- **Q19.** What about `bash -c "ls; ls"` quoted? Same — `;` in cmd → blocked. SAFE.

- **Q20.** `eval 'rm -rf /'` — `eval` is not in any list. Falls to default-deny → block. SAFE.

- **Q21.** What about exec/bash with `command` being a number or object instead of string? Hook wiring at `src/index.ts:364-368` checks `typeof params.command === "string"`. Non-string falls to `undefined`. Gate sees `execCommand === undefined`. Exec/bash branch condition `(... && execCommand)` is FALSE → branch SKIPS. Falls to blocklist → block. SAFE.

- **Q22.** **`<C-d>` / `<C-c>` Ctrl-char injection.** What if `cmd` contains `\x03` or `\x04`? Not in shell-operator regex. Fails prefix match. Falls to blocklist → block. SAFE.

- **Q23.** **`ls; rm -rf` where shell strips `;` as a glob char.** Wouldn't happen in bash; `;` is unambiguous. Theoretical concern only.

- **Q24.** **`ls -la` (line separator)?** Not in shell-operator regex. Bash treats U+2028 as a normal char in most contexts. Fails prefix match → block. SAFE.

- **Q25.** **What if `currentMode` is `undefined` or `null`?** Function signature is `currentMode: PlanMode` (`"plan" | "normal"`). TypeScript prevents this at compile-time, but at runtime nothing enforces it. `undefined !== "plan"` → return allow. Same for `null`. **If host projection ever returns `mode: null`, the gate goes dormant.** UNTESTED.

- **Q26.** **What if `currentMode` is the literal string `"Plan"` (uppercase P)?** `"Plan" !== "plan"` → gate dormant. **Real risk via host-side bug — see gap #19.**

- **Q27.** **What if `currentMode` is `"plan "` with trailing space?** Same as Q26 — gate dormant. **Real risk.**

- **Q28.** **What if `currentMode` is `"PLAN"` from `process.env`?** Some operators set mode via env var. Strict-equality breaks. Gate dormant. Real risk; UNTESTED at integration.

- **Q29.** **`bash` called with `argv` style: `params = { argv: ["bash", "-c", "rm -rf /"] }`.** Hook extracts neither `params.command` nor `params.cmd`. Gate sees `execCommand === undefined`. Exec/bash branch skips. Blocklist hits `bash` → block. SAFE BY DEFAULT-DENY. Untested.

- **Q30.** **Tool name with explicit dot like `bash.exec`.** Not in allowlist, not in blocklist (`"bash"` is, not `"bash.exec"`). Not ending in mutation/read suffix. Default-deny → block. SAFE. Untested.

---

## 6. Allowlist/blocklist drift check

### 6.1 PLAN_MODE_ALLOWED_TOOLS — byte-identical

In-host (mutation-gate.ts:49-107) — 17 entries: `read`, `web_search`, `web_fetch`, `memory_search`, `memory_get`, `update_plan`, `exit_plan_mode`, `session_status`, `ask_user_question`, `enter_plan_mode`, `sessions_spawn`, `plan_mode_status`, `sessions_list`, `sessions_history`, `sessions_yield`, `lcm_grep`, `lcm_expand_query`.

Plugin (`src/gates/mutation-gate.ts:93-111`) — same 17 entries in same order.

**Verdict: PARITY.**

### 6.2 MUTATION_TOOL_BLOCKLIST — byte-identical

Both files: `apply_patch`, `bash`, `edit`, `exec`, `gateway`, `message`, `nodes`, `process`, `sessions_send`, `subagents`, `write`. Both deliberately omit `sessions_spawn`.

**Verdict: PARITY.**

### 6.3 Mutation suffix patterns — byte-identical

Both: `.write`, `.edit`, `.delete`.

**Verdict: PARITY.**

### 6.4 Read-only suffix patterns — byte-identical

Both: `.read`, `.search`, `.list`, `.get`, `.view`.

**Verdict: PARITY.**

### 6.5 READ_ONLY_EXEC_PREFIXES — byte-identical

Both files: 22 entries in same order — `ls`, `cat`, `pwd`, `git status`, `git log`, `git diff`, `git show`, `which`, `find`, `grep`, `rg`, `head`, `tail`, `wc`, `file`, `stat`, `du`, `df`, `echo`, `printenv`, `whoami`, `hostname`, `uname`.

**Verdict: PARITY.**

### 6.6 DANGEROUS_FLAGS — byte-identical CONTENT, scope-divergent

In-host (mutation-gate.ts:194-205) — inside function body, 10 entries.

Plugin (`src/gates/mutation-gate.ts:150-161`) — module-level const, 10 entries.

**Same list, same order, same case.** Scope divergence is cosmetic and actually makes the plugin's testing better (the per-flag loop at `mutation-gate.test.ts:185` drives off `_testing.DANGEROUS_FLAGS` which would not have been exposable in the in-host version).

**Verdict: PARITY (semantically); divergent on scope (plugin is module-level + `_testing`-exported).**

### 6.7 Shell-operator regex — byte-identical

Both: `/[;|&` + backtick + `\n\r]|\$\(|>>?|<\(|>\(/`.

**Verdict: PARITY.**

### 6.8 Control-flow — byte-identical

Both files have the same eight-step decision tree (mode check, allowlist, exec/bash special case, shell-op, dangerous-flag, prefix allow, blocklist, suffix check, default-deny).

**Verdict: PARITY.**

### 6.9 Function signature — byte-identical

Both: `checkMutationGate(toolName: string, currentMode: PlanMode, execCommand?: string): MutationGateResult`.

### 6.10 Result interface — byte-identical

Both: `interface MutationGateResult { blocked: boolean; reason?: string }`.

### 6.11 Reason text strings — semantically-equivalent (minor whitespace + punctuation drift)

Plugin uses em-dashes (`—`) in JSDoc comments where in-host uses ASCII (`-`). Both produce identical reason strings for `blocked` cases. **PARITY in user-visible output.**

### Summary

**All algorithmic data is byte-identical. The only structural divergence is DANGEROUS_FLAGS being hoisted to module scope in the plugin, which enables better test-driven coverage (per-flag table-driven assertions) — a net improvement, not a regression.**

---

## 7. Confidence score

P(security regression slips through the test gate, given the current test corpus + parity contract holds) = **~0.18** (medium-low risk).

Breakdown:

- **Drivers reducing risk:**
  - Algorithmic parity with in-host is solid (verified byte-by-byte for all 6 data lists + control flow).
  - Default-deny is the fall-through for every unmatched case; getting past it requires a positive allowlist or prefix-allow hit, both of which are explicit and small.
  - The plugin's test corpus (59 tests) is GREATER than the in-host's (37 tests). Plugin tests catch the in-host's gaps for `&`, backtick, `$()`, `<(`/`>(`, per-flag DANGEROUS_FLAGS, default-deny, reason-text contents.
  - Shell-operator + dangerous-flag regexes are anchored (word-boundary) and case-insensitive where appropriate.

- **Drivers raising risk:**
  - **Integration risk (highest)**: the gate function itself is well-tested, but the hook-wiring layer at `src/index.ts:332-383` is NOT covered by `mutation-gate.test.ts`. The wiring's parameter extraction (`params.command || params.cmd`) and mode-resolution path (`ctx.getSessionExtension || store.readSnapshot`) are the actual security boundary in production. A bug there silently disables the gate. **Recommend a separate hook-integration test that injects a fake `before_tool_call` event and verifies block-on-mode.**
  - **Mode-string strict-equality (gap #19, Q26-Q28)**: `currentMode !== "plan"` does a strict-string compare. Any whitespace/case/null variance from the host projection silently disables the gate. UNTESTED.
  - **`find -ok` / `find -okdir` bypass (gap #22, Q14)**: real bypass not in DANGEROUS_FLAGS. The gate trusts `find` as a read prefix; `-ok cmd ;` executes the command (subject to interactive-prompt behavior under tty closed). Recommend adding `-ok`/`-okdir` to DANGEROUS_FLAGS.
  - **`bash -c` quoted-arg analysis not done**: the gate inspects the COMMAND string but if `bash -c "...rm..."` is allowed (it isn't, because `bash -c` doesn't match a read-only prefix), the quoted arg is opaque. SAFE TODAY by default-deny; risk is future-additive (someone adds `bash -c` or `sh -c` to the prefix list).
  - **Heredoc `<<<` herestring (Q9, gap #25)**: not in the shell-operator regex. SAFE by default-deny today; risky if any prefix gets added that legitimately allows herestrings.

- **Adversarial-question gap density:** of 30 questions in Section 5, ~6 land in default-deny-saves-us territory (Q3, Q6, Q9, Q21, Q22, Q29). The default-deny is doing a lot of load-bearing work. If a future refactor reorders the checks (e.g. someone moves prefix-match before shell-op-check, or someone adds `bash` to read-only prefixes), the default-deny safety net breaks for half the adversarial test cases.

**Bottom-line recommendation**: the gate FUNCTION is in good shape; the hook-wiring integration is the weak link. Add: (a) hook-integration test, (b) `-ok`/`-okdir` to DANGEROUS_FLAGS, (c) mode-string strict-equality tests for the integration layer, (d) at least one negative-disclosure test per excluded-by-design tool family (curl/wget/python/sed/tar/dd/cp/mv/etc.) so a future "let's allow X" change is caught by a failing test.

---

## Appendix — referenced files (absolute paths)

- `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/mutation-gate.ts` — in-host source (263 lines)
- `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/mutation-gate.test.ts` — in-host tests (203 lines, 37 cases)
- `/Users/lume/repos/Smarter-Claw/src/gates/mutation-gate.ts` — plugin port (282 lines)
- `/Users/lume/repos/Smarter-Claw/tests/gates/mutation-gate.test.ts` — plugin tests (260 lines, 59 cases)
- `/Users/lume/repos/Smarter-Claw/src/index.ts:332-428` — `before_tool_call` hook wiring (mutation gate + accept-edits gate)
- `/Users/lume/repos/Smarter-Claw/src/gates/accept-edits-gate.ts` — layer-2 fail-OPEN gate (referenced for S12 adversarial cross-check)

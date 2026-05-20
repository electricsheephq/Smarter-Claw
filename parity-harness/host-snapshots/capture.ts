/**
 * Snapshot-capture script.
 *
 * Pulls byte fixtures from the in-host source-of-truth at
 * `/Volumes/LEXAR/repos/openclaw-pr70071-rebase` commit `ea04ea52c7`
 * via `git show`, and writes them as plain-text snapshots next to this
 * file. Layer-1 parity check `parity-harness/checks/prompts.ts` reads
 * the snapshots and diffs against the plugin's runtime output.
 *
 * Re-run via:
 *   pnpm tsx parity-harness/host-snapshots/capture.ts
 *
 * The output of this script is committed to git. Do NOT skip the
 * commit — the harness check reads from disk, not from a fresh capture.
 *
 * # Why git show + manual extraction, not eval/transpile
 *
 * Each artifact is either a string literal we can extract verbatim
 * (PLAN_ARCHETYPE_PROMPT — template literal) or an array of string
 * literals we can `JSON.parse` line-by-line and join (PLAN_MODE_REFERENCE_CARD,
 * the attempt.ts inline arrays). No TS evaluation needed — that would
 * require pulling in transitive in-host imports and defeating the
 * purpose of an isolated parity snapshot.
 *
 * # Source-of-truth pin
 *
 * commit = ea04ea52c7
 * branch = rebase/pr70071-onto-main-2026-04-25
 * repo   = /Volumes/LEXAR/repos/openclaw-pr70071-rebase
 *
 * Wave-0 Decision A pins us here. Don't rebase.
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HOST_REPO = "/Volumes/LEXAR/repos/openclaw-pr70071-rebase";
const HOST_COMMIT = "ea04ea52c7";

function showFile(path: string): string {
  return execSync(`git -C ${HOST_REPO} show ${HOST_COMMIT}:${path}`, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function writeSnapshot(name: string, bytes: string): void {
  const out = join(__dirname, name);
  writeFileSync(out, bytes);
  console.log(`wrote ${out} (${bytes.length} bytes)`);
}

// ---------------------------------------------------------------------------
// 1. PLAN_ARCHETYPE_PROMPT — template literal in plan-archetype-prompt.ts
// ---------------------------------------------------------------------------

function captureArchetypePrompt(): string {
  const src = showFile("src/agents/plan-mode/plan-archetype-prompt.ts");
  const marker = "export const PLAN_ARCHETYPE_PROMPT = `";
  const startIdx = src.indexOf(marker);
  if (startIdx < 0) {
    throw new Error("could not find PLAN_ARCHETYPE_PROMPT template-literal opener");
  }
  const bodyStart = startIdx + marker.length;
  // Walk forward to find the closing unescaped backtick. The template
  // literal does NOT use `${...}` interpolation (we verify that — if it
  // did we'd need to evaluate); only the inline backtick escapes
  // (`\``), which JS unescapes to literal backticks at runtime.
  let closeIdx = -1;
  for (let i = bodyStart; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++; // skip next char (any escape sequence)
      continue;
    }
    if (c === "`") {
      closeIdx = i;
      break;
    }
    if (c === "$" && src[i + 1] === "{") {
      throw new Error(
        "PLAN_ARCHETYPE_PROMPT template literal contains ${...} interpolation — capture would need full TS evaluation. Refactor in-host source or extend the script.",
      );
    }
  }
  if (closeIdx < 0) {
    throw new Error("could not find PLAN_ARCHETYPE_PROMPT closing backtick");
  }
  return decodeTemplateLiteralBody(src.slice(bodyStart, closeIdx));
}

/**
 * Decode the body of a JS template literal — interpret the standard
 * backslash escapes (`\\`, `` \` ``, `\n`, `\t`, `\r`, `\0`, `\xNN`,
 * `\uNNNN`, `\u{HHHHH}`) and pass other characters through. This is
 * the subset the in-host template literals actually use. Anything we
 * don't recognize throws so the script fails loudly on a new escape.
 */
function decodeTemplateLiteralBody(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      throw new Error("trailing backslash in template literal body");
    }
    switch (next) {
      case "\\":
        out += "\\";
        i++;
        break;
      case "`":
        out += "`";
        i++;
        break;
      case "n":
        out += "\n";
        i++;
        break;
      case "t":
        out += "\t";
        i++;
        break;
      case "r":
        out += "\r";
        i++;
        break;
      case "0":
        out += "\0";
        i++;
        break;
      case "$":
        out += "$";
        i++;
        break;
      case '"':
        out += '"';
        i++;
        break;
      case "'":
        out += "'";
        i++;
        break;
      case "x": {
        const hex = body.slice(i + 2, i + 4);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          throw new Error(`malformed \\x escape at ${i}`);
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 3;
        break;
      }
      case "u": {
        if (body[i + 2] === "{") {
          const closeBrace = body.indexOf("}", i + 3);
          if (closeBrace < 0) {
            throw new Error(`unclosed \\u{...} escape at ${i}`);
          }
          const hex = body.slice(i + 3, closeBrace);
          out += String.fromCodePoint(parseInt(hex, 16));
          i = closeBrace;
        } else {
          const hex = body.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new Error(`malformed \\u escape at ${i}`);
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        }
        break;
      }
      default:
        throw new Error(
          `unknown escape sequence \\${next} at position ${i}; extend decoder if this is legitimate`,
        );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. PLAN_MODE_REFERENCE_CARD — `[lines...].join("\n")` in reference-card.ts
// ---------------------------------------------------------------------------

function captureReferenceCard(): string {
  const src = showFile("src/agents/plan-mode/reference-card.ts");
  return extractJoinNewlineArray(src, "PLAN_MODE_REFERENCE_CARD");
}

// ---------------------------------------------------------------------------
// 3. + 4. plan-mode-{active,available}-system-context — inline arrays at
//          attempt.ts:692-732 (active) and 735-748 (available).
//
// The active block includes `PLAN_ARCHETYPE_PROMPT` + `PLAN_MODE_REFERENCE_CARD`
// as identifiers — we substitute the captured values for those slots.
// ---------------------------------------------------------------------------

function captureActiveContext(
  archetypePrompt: string,
  referenceCard: string,
): string {
  const src = showFile("src/agents/pi-embedded-runner/run/attempt.ts");
  // The active block is the only `planMode === "plan"` arm inside the
  // `planModeAppendPrompt` ternary. Find the literal "═══ PLAN MODE ACTIVE ═══"
  // first; that's the unique anchor for the start of the active array.
  const activeAnchor = '"═══ PLAN MODE ACTIVE ═══"';
  const anchorIdx = src.indexOf(activeAnchor);
  if (anchorIdx < 0) {
    throw new Error("could not find PLAN MODE ACTIVE anchor in attempt.ts");
  }
  // The opening "[" of the array literal is the previous "[" before anchorIdx.
  const arrayStart = src.lastIndexOf("[", anchorIdx);
  // The closing "]" + ".join(\"\\n\")" is the next ".join(\"\\n\")" after.
  const joinMarker = '.join("\\n")';
  const joinIdx = src.indexOf(joinMarker, anchorIdx);
  if (arrayStart < 0 || joinIdx < 0) {
    throw new Error("could not bound the active-context array");
  }
  const arrayEnd = src.lastIndexOf("]", joinIdx);
  const arrayBody = src.slice(arrayStart + 1, arrayEnd);
  return joinArrayBodyWithSubstitutions(arrayBody, {
    PLAN_ARCHETYPE_PROMPT: archetypePrompt,
    PLAN_MODE_REFERENCE_CARD: referenceCard,
  });
}

function captureAvailableContext(): string {
  const src = showFile("src/agents/pi-embedded-runner/run/attempt.ts");
  const availableAnchor = '"═══ PLAN MODE AVAILABLE ═══"';
  const anchorIdx = src.indexOf(availableAnchor);
  if (anchorIdx < 0) {
    throw new Error("could not find PLAN MODE AVAILABLE anchor in attempt.ts");
  }
  const arrayStart = src.lastIndexOf("[", anchorIdx);
  const joinMarker = '.join("\\n")';
  const joinIdx = src.indexOf(joinMarker, anchorIdx);
  if (arrayStart < 0 || joinIdx < 0) {
    throw new Error("could not bound the available-context array");
  }
  const arrayEnd = src.lastIndexOf("]", joinIdx);
  const arrayBody = src.slice(arrayStart + 1, arrayEnd);
  return joinArrayBodyWithSubstitutions(arrayBody, {});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a `const NAME = [\n  "line1",\n  "line2",\n  ...\n].join("\n")`
 * pattern's joined string value. Walks the array body line-by-line and
 * pulls each string literal via JSON.parse (handles \n, \", \uXXXX,
 * tab, etc. correctly).
 *
 * Skips bare-line comments (// ...) but preserves end-of-line comments
 * after a closed string. Throws if a non-comment, non-string-literal,
 * non-empty line appears (the in-host arrays do not use any other shape;
 * if they grow to we'd need to extend this).
 */
function extractJoinNewlineArray(src: string, name: string): string {
  const opener = new RegExp(`export const ${name}\\s*=\\s*\\[`);
  const m = opener.exec(src);
  if (!m) {
    throw new Error(`could not find array opener for ${name}`);
  }
  const arrayStart = m.index + m[0].length - 1; // points at the "[" char
  const joinMarker = '.join("\\n")';
  const joinIdx = src.indexOf(joinMarker, arrayStart);
  if (joinIdx < 0) {
    throw new Error(`could not find .join("\\n") for ${name}`);
  }
  const arrayEnd = src.lastIndexOf("]", joinIdx);
  return joinArrayBodyWithSubstitutions(src.slice(arrayStart + 1, arrayEnd), {});
}

function joinArrayBodyWithSubstitutions(
  body: string,
  substitutions: Record<string, string>,
): string {
  const lines: string[] = [];
  const rawLines = body.split("\n");
  for (const raw of rawLines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) {
      continue;
    }
    // Strip a trailing comma (array element separator).
    let stripped = line.endsWith(",") ? line.slice(0, -1).trim() : line;
    // Strip a trailing line comment (after the literal closer).
    // Conservative: only strip "//..." that appears AFTER a closing
    // quote or closing identifier — we don't need to be clever, the
    // in-host arrays don't use end-of-line // comments inside element
    // expressions.
    if (stripped.startsWith('"') || stripped.startsWith("'")) {
      // String literal — JSON.parse it. JS supports both single and
      // double quoted; JSON only allows double. For single-quoted JS
      // literals (the in-host reference-card.ts has one line like
      // `'[PLAN_DECISION]: edited ... feedback: "<text>"'` that uses
      // single quotes because the body contains a double quote), we
      // rewrap: strip the single quotes, escape any literal `"` to `\"`,
      // and unescape any `\'` to `'`. This is exact for the subset of JS
      // string syntax the in-host arrays actually use (no fancy escapes
      // beyond \n \\ \" inside double-quoted, \' inside single-quoted).
      let toParse = stripped;
      if (stripped.startsWith("'")) {
        if (!stripped.endsWith("'")) {
          throw new Error(`malformed single-quoted literal: ${stripped}`);
        }
        const inner = stripped.slice(1, -1);
        // Order matters: unescape \' first (back to '), THEN escape any
        // raw " to \" — the unescape and escape never collide because
        // single-quoted JS can't contain a bare \" escape (\" isn't an
        // escape in single-quoted; the lexer keeps it literal as \").
        // For safety against the unusual case, also normalize the
        // remaining \" back to " then re-escape uniformly.
        const normalized = inner.replace(/\\'/g, "'").replace(/\\"/g, '"');
        toParse = `"${normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      }
      lines.push(JSON.parse(toParse) as string);
      continue;
    }
    // Identifier substitution (e.g. PLAN_ARCHETYPE_PROMPT). The in-host's
    // active block references both PLAN_ARCHETYPE_PROMPT and
    // PLAN_MODE_REFERENCE_CARD by identifier; we substitute their
    // captured values.
    if (substitutions[stripped] !== undefined) {
      lines.push(substitutions[stripped]!);
      continue;
    }
    throw new Error(
      `unexpected non-string, non-substituted array element: ${JSON.stringify(stripped)}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const archetypePrompt = captureArchetypePrompt();
const referenceCard = captureReferenceCard();
const activeContext = captureActiveContext(archetypePrompt, referenceCard);
const availableContext = captureAvailableContext();

writeSnapshot("PLAN_ARCHETYPE_PROMPT.txt", archetypePrompt);
writeSnapshot("PLAN_MODE_REFERENCE_CARD.txt", referenceCard);
writeSnapshot("plan-mode-active-system-context.txt", activeContext);
writeSnapshot("plan-mode-available-system-context.txt", availableContext);

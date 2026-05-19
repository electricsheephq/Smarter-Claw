/**
 * Plan-mode filename helpers.
 *
 * **Parity contract**: byte-faithful port of the in-host helpers
 * `buildPlanFilenameSlug` + `buildPlanFilename` at
 * `src/agents/plan-mode/plan-archetype-prompt.ts:138-174` (commit
 * `ea04ea52c7`).
 *
 * The in-host co-locates these helpers with `PLAN_ARCHETYPE_PROMPT`
 * because the prompt-string text REFERS to the filename format
 * (`plan-YYYY-MM-DD-<slug>.md`). The plugin's `src/prompt/archetype-prompt.ts`
 * is byte-locked under the parity-cache contract (any byte drift
 * busts the prompt-cache key), so we split the helpers into this
 * standalone module rather than touching the prompt file.
 *
 * Copilot review #68939 (2026-04-19) on the in-host: the fallback
 * slug is the literal `"untitled"`, NOT `"plan"`. Empty/blank/
 * unrenderable titles all collapse to `plan-YYYY-MM-DD-untitled.md`.
 *
 * host_ref: src/agents/plan-mode/plan-archetype-prompt.ts:138-174
 *           (`buildPlanFilenameSlug`, `buildPlanFilename`)
 */

/**
 * Build a kebab-case filename slug from a plan title. Used for
 * persisting plans to disk as `plan-YYYY-MM-DD-<slug>.md`. Falls back
 * to a generic `"untitled"` slug when the title is empty after
 * sanitization.
 *
 * host_ref: src/agents/plan-mode/plan-archetype-prompt.ts:148-161
 */
export function buildPlanFilenameSlug(
  title: string | undefined,
  maxLen = 50,
): string {
  if (!title || !title.trim()) {
    return "untitled";
  }
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, ""); // trim trailing hyphen after slice
  return slug || "untitled";
}

/**
 * Build the canonical plan filename. ISO date prefix ensures filenames
 * sort chronologically; slug keeps the file recognizable.
 *
 * Format: `plan-YYYY-MM-DD-<slug>.md`
 * Example: `plan-2026-04-18-fix-websocket-reconnect-race.md`
 *
 * host_ref: src/agents/plan-mode/plan-archetype-prompt.ts:167-174
 */
export function buildPlanFilename(
  title: string | undefined,
  date: Date = new Date(),
): string {
  const iso = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = buildPlanFilenameSlug(title);
  return `plan-${iso}-${slug}.md`;
}

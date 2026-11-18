import "server-only";

/**
 * The job input limits: jobInputSchema in src/lib/server/schemas.ts (string length, in UTF-16
 * units) and the jobs table's CHECKs (char_length, in code points, never more than the UTF-16
 * length). Every field the parser returns is cut to these, so whatever a page or a paste holds,
 * the add-job dialog can save the result. tests/unit/parse/limits.test.ts checks them against
 * the schema.
 */
export const MAX_FIELD = 200;
export const MAX_DESCRIPTION = 50_000;

/** Cuts to `max` UTF-16 units without leaving half of a surrogate pair. */
export function clamp(s: string, max: number) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/**
 * A field as the parser returns it: without NUL characters (PostgreSQL text cannot hold them,
 * so saving would fail), well-formed (a lone surrogate, such as a JSON "\ud83d", becomes U+FFFD
 * here, as it would on its way into the database, so the dialog shows what is saved), trimmed,
 * and cut to `max`.
 */
export function fit(value: string | undefined, max: number) {
  return clamp((value ?? "").replace(/\u0000/g, "").toWellFormed().trim(), max);
}

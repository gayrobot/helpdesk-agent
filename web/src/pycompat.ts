/**
 * Python behaviour the governance code depends on, reproduced exactly.
 *
 * The Unicode facts come from `generated/unicode-py312.json`, which
 * `scripts/parity_fixtures.py` writes from Python's own `unicodedata` and `str` methods.
 * JavaScript's built-ins answer some of these questions differently (`toLowerCase` is not
 * `casefold`, `\s` is not `str.isspace`, and there are no character names), so the port
 * reads Python's answers instead of approximating them.
 */
import tables from "./generated/unicode-py312.json" with { type: "json" };

type Range = [number, number];

interface Tables {
  python: string;
  unicode: string;
  casefold: Record<string, string>;
  format: Range[];
  other: Range[];
  unassigned: Range[];
  whitespace: Range[];
  printable: Range[];
  letters: [number, number, string][];
}

const T = tables as unknown as Tables;

export const PYTHON_UNICODE_VERSION = T.unicode;

function findRange<R extends [number, number, ...unknown[]]>(ranges: R[], cp: number): R | null {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid] as R;
    if (cp < range[0]) hi = mid - 1;
    else if (cp > range[1]) lo = mid + 1;
    else return range;
  }
  return null;
}

const cpOf = (ch: string): number => ch.codePointAt(0) ?? 0;

/** Python `unicodedata.category(ch) == "Cf"`. */
export const isFormat = (ch: string): boolean => findRange(T.format, cpOf(ch)) !== null;
/** Python `unicodedata.category(ch)[0] == "C"`. */
export const isOther = (ch: string): boolean => findRange(T.other, cpOf(ch)) !== null;
/** Python `unicodedata.category(ch) == "Cn"`: a code point Python 3.12 doesn't know. */
export const isUnassigned = (ch: string): boolean => findRange(T.unassigned, cpOf(ch)) !== null;

/**
 * Python 3.12's `unicodedata.normalize("NFKC", text)`. JavaScript's NFKC follows a newer
 * Unicode, so it also folds characters Python doesn't know (e.g. U+1CCD6, an outlined
 * "A", becomes "A"). Python leaves those alone, so runs of them are kept as they are and
 * only the rest is normalized.
 */
export function pyNfkc(text: string): string {
  let out = "";
  let known = "";
  for (const ch of text) {
    if (isUnassigned(ch)) {
      out += known.normalize("NFKC") + ch;
      known = "";
    } else {
      known += ch;
    }
  }
  return out + known.normalize("NFKC");
}

/** Python `ch.isspace()`. */
export const isSpace = (ch: string): boolean => findRange(T.whitespace, cpOf(ch)) !== null;
/** Python `ch.isprintable()`. */
export const isPrintable = (ch: string): boolean => findRange(T.printable, cpOf(ch)) !== null;

/**
 * The first word of a letter's Unicode name (LATIN, CYRILLIC, ...), or null if Python
 * doesn't consider it a letter. A character JavaScript calls a letter but Python 3.12
 * doesn't know (newer Unicode) is "UNKNOWN", so it can only make a check stricter.
 */
export function letterLabel(ch: string): string | null {
  const hit = findRange(T.letters, cpOf(ch));
  if (hit) return hit[2];
  return /\p{L}/u.test(ch) ? "UNKNOWN" : null;
}

/** Python `str.casefold()`: full case folding, one code point at a time. */
export function casefold(text: string): string {
  let out = "";
  for (const ch of text) out += T.casefold[String(cpOf(ch))] ?? ch;
  return out;
}

/** Python `str.split()` with no argument: split on runs of whitespace, drop empties. */
export function pySplit(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const ch of text) {
    if (isSpace(ch)) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Python `str.strip()` with no argument. */
export function pyStrip(text: string): string {
  const chars = [...text];
  let start = 0;
  let end = chars.length;
  while (start < end && isSpace(chars[start] as string)) start++;
  while (end > start && isSpace(chars[end - 1] as string)) end--;
  return chars.slice(start, end).join("");
}

/** Python `len(str)`: code points, not UTF-16 units. */
export const pyLen = (text: string): number => [...text].length;

/** Python `sorted()` order for strings: by code point. */
export function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = cpOf(x[i] as string) - cpOf(y[i] as string);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function hex(cp: number, width: number): string {
  return cp.toString(16).padStart(width, "0");
}

/** Python `repr(str)`. */
export function reprStr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const cp = cpOf(ch);
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${hex(cp, 2)}`;
    else if (cp < 0x7f || isPrintable(ch)) out += ch;
    else if (cp <= 0xff) out += `\\x${hex(cp, 2)}`;
    else if (cp <= 0xffff) out += `\\u${hex(cp, 4)}`;
    else out += `\\U${hex(cp, 8)}`;
  }
  return out + quote;
}

/** Python `repr()` for a value parsed from JSON (str, int, bool, None, list, dict). */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return reprStr(value);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : pyFloat(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const items = Object.entries(value).map(([k, v]) => `${reprStr(k)}: ${pyRepr(v)}`);
    return `{${items.join(", ")}}`;
  }
  return String(value);
}

function pyFloat(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const s = String(value);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/**
 * Python `json.dumps(value, ensure_ascii=False)`: ", " and ": " separators, keys in
 * insertion order. The bytes matter: they are what the model sees and what
 * `result_sha256` in the audit log fingerprints.
 */
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number in a tool result");
    return Number.isInteger(value) ? String(value) : pyFloat(value);
  }
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(", ")}]`;
  if (typeof value === "object") {
    const items = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`);
    return `{${items.join(", ")}}`;
  }
  throw new TypeError(`can't serialise ${typeof value}`);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Python `datetime.now(UTC).isoformat(timespec="seconds")`, e.g. 2026-11-25T16:01:43+00:00. */
export function isoSeconds(d: Date): string {
  return `${isoDate(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`;
}

/** Python `date.isoformat()` in UTC. */
export function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Python `f"{now:%Y%m%d-%H%M%S%f}"`. JavaScript dates stop at milliseconds, so the last
 * three of the six fraction digits hold `seq` (0-999) instead of microseconds. The
 * caller passes a counter, so two ids made in the same millisecond still differ.
 */
export function compactStamp(d: Date, seq = 0): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    `${pad(d.getUTCMilliseconds(), 3)}${pad(seq % 1000, 3)}`
  );
}

/**
 * Python `f"{x:.{digits}f}"`. JavaScript's `toFixed` rounds an exact tie up (0.25 -> "0.3");
 * Python rounds it to even ("0.2"). Ties are found from the exact decimal expansion,
 * which `toFixed` gives for up to 100 digits.
 */
export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const exact = Math.abs(x).toFixed(Math.min(100, digits + 60));
  const cut = exact.indexOf(".") + digits + (digits > 0 ? 1 : 0);
  const rest = exact.slice(digits > 0 ? cut : exact.indexOf(".") + 1);
  if (/^50*$/.test(rest)) {
    // Exact tie: keep the even neighbour.
    const kept = digits > 0 ? exact.slice(0, cut) : exact.slice(0, exact.indexOf("."));
    const lastDigit = Number(kept.replace(".", "").slice(-1));
    const scale = 10 ** digits;
    const down = Number(kept);
    const value = lastDigit % 2 === 0 ? down : down + 1 / scale;
    const out = value.toFixed(digits);
    return x < 0 ? `-${out}` : out; // Python keeps the sign: f"{-0.25:.1f}" is "-0.2"
  }
  return x.toFixed(digits);
}

/** Python `f"{x:.0%}"`: multiply by 100 (as a float), then format with no decimals. */
export const pyPercent0 = (x: number): string => `${pyFixed(x * 100, 0)}%`;

/** Python `==` on JSON values: dicts compare without regard to key order. */
export function pyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => pyEqual(x, b[i]))
    );
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every(
        (k) =>
          Object.hasOwn(b, k) &&
          pyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}

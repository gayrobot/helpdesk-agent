/**
 * The fake company directory: users, groups, devices and apps. Port of
 * `helpdesk_agent/directory.py`.
 *
 * Writes (MFA resets, group adds) change only this in-memory copy. Each ticket gets a
 * fresh copy, as in Python.
 */
import { loadDirectoryData, type RawDirectory, type RawGroup, type RawUser } from "./data.ts";
import { casefold, isFormat, letterLabel, pySplit } from "./pycompat.ts";

export const PRIVILEGED_NAME_MARKERS = [
  "admin",
  "root",
  "privileged",
  "super",
  "approver",
  "owner",
] as const;

/**
 * Canonical form for lookups: NFKC, invisible format characters removed, whitespace
 * trimmed and collapsed, casefolded. Lookups are exact matches on this form, so a
 * look-alike or padded name resolves to the real record or to nothing.
 */
export function normalize(value: string): string {
  let text = value.normalize("NFKC");
  text = [...text].filter((ch) => !isFormat(ch)).join("");
  return casefold(pySplit(text).join(" "));
}

/**
 * The writing systems of the letters in `value` after NFKC (so fullwidth Latin counts as
 * Latin). Digits, punctuation and spaces don't count. Same rule as Python: the first
 * word of each letter's Unicode name, read from Python's tables.
 */
export function letterScripts(value: string): Set<string> {
  const scripts = new Set<string>();
  for (const ch of value.normalize("NFKC")) {
    const label = letterLabel(ch);
    if (label !== null) scripts.add(label);
  }
  return scripts;
}

export function isMixedScript(value: string): boolean {
  return letterScripts(value).size > 1;
}

export type User = RawUser;
export type Group = RawGroup;
export type Device = Record<string, unknown> & { id: string; owner: string };

export class Directory {
  readonly company: string;
  readonly users: Map<string, User>;
  readonly groups: Map<string, Group>;
  readonly devices: Device[];
  readonly apps: Record<string, unknown>[];

  constructor(data: RawDirectory) {
    this.company = data.company;
    this.users = new Map(data.users.map((u) => [normalize(u.email), u]));
    this.groups = new Map(data.groups.map((g) => [normalize(g.name), g]));
    this.devices = data.devices as Device[];
    this.apps = data.apps ?? [];
  }

  /** A fresh, independent copy of the packaged synthetic directory. */
  static load(): Directory {
    return new Directory(loadDirectoryData());
  }

  findUser(email: string): User | null {
    return this.users.get(normalize(email)) ?? null;
  }

  findGroup(name: string): Group | null {
    return this.groups.get(normalize(name)) ?? null;
  }

  devicesFor(email: string): Device[] {
    const key = normalize(email);
    return this.devices.filter((d) => normalize(d.owner) === key);
  }

  /**
   * True if the group is flagged privileged or its name looks privileged. The name check
   * is a second layer, so a mislabelled group still fails closed.
   */
  isPrivilegedGroup(name: string): boolean {
    const group = this.findGroup(name);
    if (group?.privileged) return true;
    const key = normalize(name);
    return PRIVILEGED_NAME_MARKERS.some((marker) => key.includes(marker));
  }

  privilegedMemberships(user: User): string[] {
    return user.groups.filter((g) => this.isPrivilegedGroup(g));
  }
}

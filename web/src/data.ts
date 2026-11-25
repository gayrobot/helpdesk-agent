/**
 * The synthetic data, read from the Python package so there is one copy.
 * Nothing here is real: every user, device and runbook is invented, at example.test.
 */
import directoryJson from "../../src/helpdesk_agent/data/directory.json" with { type: "json" };

export interface RawUser {
  email: string;
  name: string;
  department: string;
  title: string;
  manager: string | null;
  status: string;
  employment: string;
  mfa: { enrolled: boolean; method: string | null; last_reset: string | null };
  groups: string[];
}

export interface RawGroup {
  name: string;
  description: string;
  privileged?: boolean;
}

export interface RawDirectory {
  company: string;
  users: RawUser[];
  groups: RawGroup[];
  devices: Record<string, unknown>[];
  apps?: Record<string, unknown>[];
}

/** A deep copy, so callers can change it freely (writes are per ticket, as in Python). */
export function loadDirectoryData(): RawDirectory {
  return structuredClone(directoryJson as RawDirectory);
}

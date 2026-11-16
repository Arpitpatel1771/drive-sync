// Small helpers shared by the engine modules: hashing, name sanitising, error classification, backoff.

import { DriveError } from "../drive/api";
import { AuthRequiredError } from "../drive/auth";

const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

/** 2 s, 4 s, 8 s ... capped at 5 min. `failures` starts at 1. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with sorted keys and no `undefined` values, so equal content always hashes the same. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function sanitizeName(title: string): string {
  // eslint-disable-next-line no-control-regex
  const s = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  return s || "Untitled";
}

export type ErrorClass = "auth" | "offline" | "retry" | "full" | "notFound" | "other";

export function classify(e: unknown): ErrorClass {
  if (e instanceof AuthRequiredError) return "auth";
  if (e instanceof DriveError) {
    if (e.status === 401) return "auth";
    if (e.status === 0) return "offline";
    if (e.status === 404) return "notFound";
    if (e.status === 429 || e.status >= 500) return "retry";
    if (e.status === 403) {
      if (/storageQuotaExceeded/i.test(e.reason)) return "full";
      if (/rateLimitExceeded|dailyLimitExceeded/i.test(e.reason)) return "retry";
    }
  }
  return "other";
}

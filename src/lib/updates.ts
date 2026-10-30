export const APP_VERSION = "1.0.0";

export const UPDATE_MANIFEST =
  "https://raw.githubusercontent.com/us-crypto/cutline-updates/main/version.json";

export type RemoteUpdate = {
  version: string;
  notes: string;
  released: string;
};

export function isNewer(remote: string, local: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const next = parse(remote);
  const current = parse(local);
  const length = Math.max(next.length, current.length);
  for (let index = 0; index < length; index++) {
    const delta = (next[index] ?? 0) - (current[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

export async function fetchUpdate(): Promise<RemoteUpdate | null> {
  const response = await fetch(`${UPDATE_MANIFEST}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) return null;
  const data = (await response.json()) as { version?: unknown; notes?: unknown; released?: unknown };
  if (typeof data.version !== "string" || !data.version.trim()) return null;
  return {
    version: data.version.trim(),
    notes: typeof data.notes === "string" ? data.notes.trim() : "",
    released: typeof data.released === "string" ? data.released.trim() : "",
  };
}

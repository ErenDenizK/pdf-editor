/**
 * localStorage access that never throws. Storage can be unavailable (private windows,
 * blocked site data, sandboxed iframes, quota exceeded); UI preferences are a convenience,
 * so every failure degrades to "not persisted".
 */
export function readJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw == null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisted; the in-memory state is still correct.
  }
}

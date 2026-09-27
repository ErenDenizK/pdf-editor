/**
 * Reads the Content Security Policy delivered in `index.html`'s `<meta http-equiv>` (the
 * only way on GitHub Pages, ADR-0004), for the privacy popover and its unit test.
 */

/** Directive name → source list, e.g. `connect-src` → [`'self'`]. */
export type CspDirectives = ReadonlyMap<string, readonly string[]>;

export function parseCsp(policy: string): CspDirectives {
  const directives = new Map<string, readonly string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    const key = name.toLowerCase();
    // The first occurrence wins (CSP3 §2.2.1).
    if (!directives.has(key)) directives.set(key, sources);
  }
  return directives;
}

/** Source expressions that allow a network origin (hosts, schemes that reach the network,
 *  or wildcards). Keywords (`'self'`, `'none'`, …) and local schemes (`blob:`, `data:`) do
 *  not. */
export function externalSources(directives: CspDirectives): string[] {
  const external: string[] = [];
  for (const sources of directives.values()) {
    for (const source of sources) {
      if (source.startsWith("'")) continue;
      if (source === 'blob:' || source === 'data:') continue;
      external.push(source);
    }
  }
  return external;
}

/** The policy text from a `<meta http-equiv="Content-Security-Policy">` in `doc`. */
export function documentCsp(doc: Document = document): string | undefined {
  const meta = doc.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]');
  return meta?.content;
}

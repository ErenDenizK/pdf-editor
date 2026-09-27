import { describe, expect, it } from 'vitest';

import indexHtml from '../../index.html?raw';
import { documentCsp, externalSources, parseCsp } from './csp';

function shippedPolicy(): string {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  const policy = documentCsp(doc);
  if (policy === undefined) throw new Error('index.html has no CSP meta tag');
  return policy;
}

describe('index.html Content Security Policy', () => {
  it('allows no external origins in any directive', () => {
    expect(externalSources(parseCsp(shippedPolicy()))).toEqual([]);
  });

  it("limits connect-src to 'self'", () => {
    expect(parseCsp(shippedPolicy()).get('connect-src')).toEqual(["'self'"]);
  });

  it('has a restrictive default and blocks plugins', () => {
    const csp = parseCsp(shippedPolicy());
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
  });
});

describe('parseCsp / externalSources', () => {
  it('flags hosts, network schemes and wildcards', () => {
    const csp = parseCsp(
      "default-src 'self'; img-src 'self' blob: data: https://cdn.example.com; connect-src *; font-src https:",
    );
    expect(externalSources(csp)).toEqual(['https://cdn.example.com', '*', 'https:']);
  });

  it('keeps the first occurrence of a repeated directive', () => {
    expect(parseCsp("connect-src 'self'; connect-src *").get('connect-src')).toEqual(["'self'"]);
  });
});

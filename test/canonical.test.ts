import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalJson } from '../src/contracts/canonical.js';

describe('canonical JSON and hashing', () => {
  it('sorts nested object keys without changing array order', () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: ['b', 'a'] } })).toBe('{"a":{"x":["b","a"],"y":true},"z":1}');
    expect(canonicalHash({ b: 2, a: 1 })).toBe('sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it('rejects values that JSON.stringify would silently alter', () => {
    expect(() => canonicalJson({ value: undefined })).toThrow(/not in the JSON data model/u);
    expect(() => canonicalJson([, 1])).toThrow(/sparse arrays/u);
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/u);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/u);
  });
});

import { createHash } from 'node:crypto';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

function isPlainObject(value: object): value is { readonly [key: string]: JsonValue } {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Serialize the JSON data model deterministically.
 *
 * Object keys use JavaScript's UTF-16 lexical ordering, matching RFC 8785/JCS.
 * Values outside the JSON data model are rejected rather than silently omitted.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();

  const encode = (current: unknown, path: string): string => {
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      return JSON.stringify(current);
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError(`${path}: non-finite numbers are not JSON`);
      return JSON.stringify(current);
    }
    if (typeof current !== 'object') {
      throw new TypeError(`${path}: ${typeof current} is not in the JSON data model`);
    }
    if (ancestors.has(current)) throw new TypeError(`${path}: cyclic values are not JSON`);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const items: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) {
            throw new TypeError(`${path}[${index}]: sparse arrays are not canonical JSON`);
          }
          items.push(encode(current[index], `${path}[${index}]`));
        }
        return `[${items.join(',')}]`;
      }
      if (!isPlainObject(current)) throw new TypeError(`${path}: expected a plain JSON object`);
      const entries = Object.keys(current).sort().map((key) =>
        `${JSON.stringify(key)}:${encode(current[key], `${path}.${key}`)}`,
      );
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return encode(value, '$');
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalHash(value: unknown): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/**
 * Compare acyclic parser/FHIR data directly. Object property order is not
 * meaning; omitted optional fields equal explicit undefined. Array order and
 * primitive types remain significant. No sorting or normalized copy is needed.
 * @param left First structured value.
 * @param right Second structured value.
 */
export function equalStructuredValues(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!equalStructuredValues(left[index], right[index])) return false;
    }
    return true;
  }
  const before = left as Record<string, unknown>;
  const after = right as Record<string, unknown>;
  for (const key of Object.keys(before)) {
    if (before[key] === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(after, key) ||
        !equalStructuredValues(before[key], after[key])) return false;
  }
  for (const key of Object.keys(after)) {
    if (after[key] !== undefined && (!Object.prototype.hasOwnProperty.call(before, key) ||
        before[key] === undefined)) return false;
  }
  return true;
}

/**
 * Copy acyclic plain data while preserving optional properties and primitive
 * types. Each call owns its nested objects, including unfamiliar FHIR fields.
 * This is not a serializer and never invokes an object's toJSON hook.
 * @param value Plain parser/FHIR data to detach from an editable source.
 */
export function cloneStructuredValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(part => cloneStructuredValue(part)) as T;
  if (value === null || typeof value !== "object") return value;
  const copy = { ...value };
  for (const key of Object.keys(copy) as (keyof T)[]) {
    copy[key] = cloneStructuredValue(value[key]);
  }
  return copy;
}

/** Mix a primitive token without allocating an encoded object/string tree.
 * @param text A property name or primitive textual value.
 * @param seed Type-specific hash seed.
 */
function hashText(text: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Order-independent object / order-sensitive array hash for candidate buckets.
 * A hash is NOT semantic equality: every consumer must compare bucket members
 * with equalStructuredValues before packing or dropping a candidate. Optional
 * undefined fields are omitted consistently with that comparator.
 * @param value Acyclic structured value whose candidate bucket is needed.
 */
export function hashStructuredValue(value: unknown): number {
  if (value === null) return 0x42108421;
  switch (typeof value) {
    case "undefined": return 0x12345678;
    case "boolean": return value ? 0x2468ace1 : 0x2468ace0;
    case "number": return hashText(String(value), 0x811c9dc5);
    case "string": return hashText(value, 0x9e3779b9);
    case "object": {
      if (Array.isArray(value)) {
        let hash = 0x517cc1b7;
        for (const part of value) hash = Math.imul(hash ^ hashStructuredValue(part), 0x01000193);
        return Math.imul(hash ^ value.length, 0x01000193) >>> 0;
      }
      let hash = 0x6a09e667;
      let count = 0;
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const part = record[key];
        if (part === undefined) continue;
        hash = (hash + Math.imul(hashText(key, 0x85ebca6b) ^ hashStructuredValue(part), 0x01000193)) >>> 0;
        count++;
      }
      return Math.imul(hash ^ count, 0x01000193) >>> 0;
    }
    // Non-data values are unequal unless they share identity; the mandatory
    // bucket comparison handles them without inventing a serialized meaning.
    default: return 0x7f4a7c15;
  }
}

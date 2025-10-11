export type ObjectEntries<T extends Record<string, unknown>> = Array<
  [keyof T, T[keyof T]]
>;

export function objectEntries<T extends Record<string, unknown>>(value: T): ObjectEntries<T> {
  const entries: Array<[keyof T, T[keyof T]]> = [];
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const typedKey = key as keyof T;
      entries.push([typedKey, value[typedKey]]);
    }
  }
  return entries;
}

export function objectValues<T extends Record<string, unknown>>(value: T): Array<T[keyof T]> {
  const values: Array<T[keyof T]> = [];
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      values.push(value[key as keyof T]);
    }
  }
  return values;
}

export function objectFromEntries<K extends string, V>(entries: Array<[K, V]>): Record<K, V> {
  const result: Record<K, V> = {} as Record<K, V>;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const key = entry[0];
    const value = entry[1];
    result[key] = value;
  }
  return result;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) result[key] = stableValue(item);
    }
    return result;
  }
  return value;
}

export function stableStructureKey(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

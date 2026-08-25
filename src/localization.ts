export type I18nRecord = Record<string, string>;

export function normalizeLocaleTag(locale: string | undefined): string | undefined {
  const normalized = locale?.trim().toLowerCase().replace(/_/gu, "-");
  return normalized || undefined;
}

export function baseLanguageTag(locale: string | undefined): string | undefined {
  return normalizeLocaleTag(locale)?.split("-", 1)[0];
}

export function localeFallbackChain(locale: string | undefined): string[] {
  const exact = normalizeLocaleTag(locale);
  if (!exact) return [];
  const base = baseLanguageTag(exact);
  return base && base !== exact ? [exact, base] : [exact];
}

export function localizedValue(
  i18n: Record<string, string | undefined> | undefined,
  locale: string | undefined
): string | undefined {
  if (!i18n) return undefined;
  for (const candidate of localeFallbackChain(locale)) {
    const direct = i18n[candidate]?.trim();
    if (direct) return direct;
  }
  const target = normalizeLocaleTag(locale);
  if (!target) return undefined;
  for (const key of Object.keys(i18n)) {
    const normalizedKey = normalizeLocaleTag(key);
    if (!normalizedKey) continue;
    if (target.startsWith(`${normalizedKey}-`) || normalizedKey.startsWith(`${target}-`)) {
      const value = i18n[key]?.trim();
      if (value) return value;
    }
  }
  return undefined;
}

export function localizedConfig<T>(
  configs: Record<string, T> | undefined,
  locale: string | undefined,
  fallbackLocale?: string
): T | undefined {
  if (!configs) return undefined;
  for (const candidate of localeFallbackChain(locale)) {
    if (configs[candidate] !== undefined) return configs[candidate];
  }
  for (const candidate of localeFallbackChain(fallbackLocale)) {
    if (configs[candidate] !== undefined) return configs[candidate];
  }
  return undefined;
}

export function localeKeys(
  ...records: Array<Record<string, unknown> | undefined>
): string[] {
  const keys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record ?? {})) {
      const normalized = normalizeLocaleTag(key);
      if (normalized) keys.add(normalized);
    }
  }
  return Array.from(keys).sort();
}

export function composeLocalizedRecords(
  records: Array<I18nRecord | undefined>,
  compose: (values: string[], locale: string) => string | undefined
): I18nRecord | undefined {
  const output: I18nRecord = {};
  for (const locale of localeKeys(...records)) {
    const values = records.map((record) => localizedValue(record, locale));
    if (values.some((value) => value === undefined)) continue;
    const composed = compose(values as string[], locale)?.trim();
    if (composed) output[locale] = composed;
  }
  return Object.keys(output).length ? output : undefined;
}

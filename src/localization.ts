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

function normalizedRecordExact<T>(
  record: Record<string, T> | undefined,
  locale: string
): T | undefined {
  if (!record) return undefined;
  for (const key of Object.keys(record)) {
    if (normalizeLocaleTag(key) === locale) return record[key];
  }
  return undefined;
}

function normalizedRecordCompatible<T>(
  record: Record<string, T> | undefined,
  locale: string
): T | undefined {
  if (!record) return undefined;
  for (const key of Object.keys(record)) {
    const normalizedKey = normalizeLocaleTag(key);
    if (!normalizedKey || normalizedKey === locale) continue;
    if (locale.startsWith(`${normalizedKey}-`) || normalizedKey.startsWith(`${locale}-`)) {
      return record[key];
    }
  }
  return undefined;
}

function localizedRecordEntry<T>(
  record: Record<string, T> | undefined,
  locale: string | undefined
): T | undefined {
  const chain = localeFallbackChain(locale);
  for (const candidate of chain) {
    const exact = normalizedRecordExact(record, candidate);
    if (exact !== undefined) return exact;
  }
  const target = normalizeLocaleTag(locale);
  return target ? normalizedRecordCompatible(record, target) : undefined;
}

export function localizedValue(
  i18n: Record<string, string | undefined> | undefined,
  locale: string | undefined
): string | undefined {
  if (!i18n) return undefined;
  for (const candidate of localeFallbackChain(locale)) {
    for (const key of Object.keys(i18n)) {
      if (normalizeLocaleTag(key) !== candidate) continue;
      const value = i18n[key]?.trim();
      if (value) return value;
    }
  }
  const target = normalizeLocaleTag(locale);
  if (!target) return undefined;
  for (const key of Object.keys(i18n)) {
    const normalizedKey = normalizeLocaleTag(key);
    if (!normalizedKey || normalizedKey === target) continue;
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
  const primary = localizedRecordEntry(configs, locale);
  if (primary !== undefined) return primary;
  return localizedRecordEntry(configs, fallbackLocale);
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

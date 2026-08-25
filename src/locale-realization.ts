import source from "./locale-realization.json";
import { localizedConfig, localizedValue, normalizeLocaleTag } from "./localization";

export interface LocaleRealizationProfile {
  tokenSeparator: string;
  quantitySeparator: string;
  durationPrefix: string;
  resultFormationPrefix: string;
  materialPrefix: string;
  amountMaterialDestinationTemplate: string;
}

const DEFAULT_PROFILE: LocaleRealizationProfile = {
  tokenSeparator: source.default?.tokenSeparator ?? " ",
  quantitySeparator: source.default?.quantitySeparator ?? " ",
  durationPrefix: source.default?.durationPrefix ?? "for",
  resultFormationPrefix: source.default?.resultFormationPrefix ?? "to form",
  materialPrefix: source.default?.materialPrefix ?? "of",
  amountMaterialDestinationTemplate: source.default?.amountMaterialDestinationTemplate ??
    "{label} {amount} {material}{destination}"
};

const PROFILES = source.locales as Record<string, Partial<LocaleRealizationProfile>>;
const TIME_ARGUMENTS = source.timeArguments as Record<string, Record<string, string>>;

export function localeRealizationProfile(locale: string | undefined): LocaleRealizationProfile {
  const configured = localizedConfig(PROFILES, locale);
  return { ...DEFAULT_PROFILE, ...(configured ?? {}) };
}

export function joinLocalizedTokens(locale: string | undefined, parts: Array<string | undefined>): string {
  const separator = localeRealizationProfile(locale).tokenSeparator;
  return parts.filter((part): part is string => Boolean(part?.length)).join(separator);
}

export function localizedTimeArgument(value: string, locale: string | undefined): string | undefined {
  return localizedValue(TIME_ARGUMENTS[value], locale) ?? localizedValue(TIME_ARGUMENTS[value], "en");
}

export function localizedRecordValue(
  record: Record<string, string> | undefined,
  locale: string | undefined
): string | undefined {
  const key = normalizeLocaleTag(locale);
  if (!key || !record) return undefined;
  return record[key] ?? record[key.split("-")[0]];
}

export function renderLocaleTemplate(
  template: string,
  values: Record<string, string | undefined>
): string {
  let rendered = template;
  for (const key of Object.keys(values)) {
    rendered = rendered.split(`{${key}}`).join(values[key] ?? "");
  }
  return rendered.replace(/\s+/gu, " ").replace(/\s+([,.;:])/gu, "$1").trim();
}

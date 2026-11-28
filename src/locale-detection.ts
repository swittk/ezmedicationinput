import { baseLanguageTag } from "./localization";

export interface MedicationLocaleDetector {
  locale: string;
  test(text: string): boolean;
  priority?: number;
  joinsAdjacentSourceTokens?: boolean;
}

const DETECTORS: MedicationLocaleDetector[] = [];
const DETECTOR_INDEX = new Map<string, { position: number; priority: number }>();

export function registerMedicationLocaleDetector(detector: MedicationLocaleDetector): void {
  const locale = baseLanguageTag(detector.locale) ?? detector.locale.toLowerCase();
  const normalized: MedicationLocaleDetector = Object.assign({}, detector);
  normalized.locale = locale;
  const previous = DETECTOR_INDEX.get(locale),
    priority = normalized.priority ?? 0;
  if (previous) {
    DETECTORS[previous.position] = normalized;
    // Keep the registered ordering value when a fresh descriptor replaces
    // this locale's provider.
    // Equal priority preserves stable tie order without another full sort.
    if (previous.priority === priority) return;
  } else DETECTORS.push(normalized);
  DETECTORS.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  for (let i = 0; i < DETECTORS.length; i++) {
    const value = DETECTORS[i],
      entry = DETECTOR_INDEX.get(value.locale);
    if (entry) {
      entry.position = i;
      entry.priority = value.priority ?? 0;
    } else DETECTOR_INDEX.set(value.locale, { position: i, priority: value.priority ?? 0 });
  }
}

export function shouldJoinAdjacentSourceTokens(left: string, right: string): boolean {
  return DETECTORS.some(
    (detector) => detector.joinsAdjacentSourceTokens === true && detector.test(left) && detector.test(right)
  );
}

export function inferMedicationLocale(text: string, fallback = "en"): string {
  for (const detector of DETECTORS) {
    if (detector.test(text)) return detector.locale;
  }
  return baseLanguageTag(fallback) ?? fallback.toLowerCase();
}

/** Registered source languages keep their authored wording; English uses the
 * lexical definition's wording rather than overriding it with a surface form. */
export function withMedicationSourceI18n(
  sourceText: string, i18n: Record<string, string> | undefined
): Record<string, string> | undefined {
  const sourceLocale = inferMedicationLocale(sourceText, "en");
  return sourceLocale === "en" ? i18n : { ...(i18n ?? {}), [sourceLocale]: sourceText };
}

// Built-in Thai detector preserves historical auto-detection. Other languages can
// register detectors without changing parser/HPSG core.
registerMedicationLocaleDetector({
  locale: "th",
  priority: 100,
  joinsAdjacentSourceTokens: true,
  test: (text) => /[\u0E00-\u0E7F]/u.test(text),
});

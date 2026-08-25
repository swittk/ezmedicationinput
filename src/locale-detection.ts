import { baseLanguageTag } from "./localization";

export interface MedicationLocaleDetector {
  locale: string;
  test(text: string): boolean;
  priority?: number;
  joinsAdjacentSourceTokens?: boolean;
}

const DETECTORS: MedicationLocaleDetector[] = [];

export function registerMedicationLocaleDetector(detector: MedicationLocaleDetector): void {
  const locale = baseLanguageTag(detector.locale) ?? detector.locale.toLowerCase();
  const existing = DETECTORS.findIndex((candidate) =>
    (baseLanguageTag(candidate.locale) ?? candidate.locale.toLowerCase()) === locale
  );
  const normalized = { ...detector, locale };
  if (existing >= 0) DETECTORS.splice(existing, 1, normalized);
  else DETECTORS.push(normalized);
  DETECTORS.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
}

export function shouldJoinAdjacentSourceTokens(left: string, right: string): boolean {
  return DETECTORS.some((detector) =>
    detector.joinsAdjacentSourceTokens === true && detector.test(left) && detector.test(right)
  );
}

export function inferMedicationLocale(text: string, fallback = "en"): string {
  for (const detector of DETECTORS) {
    if (detector.test(text)) return detector.locale;
  }
  return baseLanguageTag(fallback) ?? fallback.toLowerCase();
}

// Built-in Thai detector preserves historical auto-detection. Other languages can
// register detectors without changing parser/HPSG core.
registerMedicationLocaleDetector({
  locale: "th",
  priority: 100,
  joinsAdjacentSourceTokens: true,
  test: (text) => /[\u0E00-\u0E7F]/u.test(text)
});

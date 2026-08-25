import { baseLanguageTag, localizedConfig } from "../localization";
import { inferMedicationLocale } from "../locale-detection";
import { listMedicationInstructionActions } from "../instruction-action-terminology";
import { listMedicationInstructionConcepts } from "../instruction-concept-terminology";
import { getRelationLocaleSuggestionLexemes } from "../relation-terminology";
import { LexToken } from "./token-types";
import {
  applyThaiLocaleLexicon,
  listThaiMedicationLocaleLexemes
} from "./locales/th";

export interface MedicationLocaleLexeme {
  surface: string;
  canonical: string;
}

export interface MedicationLexerLocalePack {
  locale: string;
  apply(tokens: readonly LexToken[], input: string): LexToken[];
  listLexemes?(): MedicationLocaleLexeme[];
}

const LOCALE_PACKS = new Map<string, MedicationLexerLocalePack>();

export function registerMedicationLexerLocalePack(pack: MedicationLexerLocalePack): void {
  const locale = baseLanguageTag(pack.locale) ?? pack.locale.toLowerCase();
  LOCALE_PACKS.set(locale, { ...pack, locale });
}

export function getMedicationLexerLocalePack(locale: string): MedicationLexerLocalePack | undefined {
  return LOCALE_PACKS.get(baseLanguageTag(locale) ?? locale.toLowerCase());
}

function cloneAndReindex(tokens: readonly LexToken[]): LexToken[] {
  return tokens.map((token, index) => ({ ...token, index }));
}

export function applyLocaleLexicon(
  tokens: readonly LexToken[],
  input: string,
  locale?: string
): LexToken[] {
  const resolvedLocale = baseLanguageTag(locale) ?? inferMedicationLocale(input, "en");
  const pack = getMedicationLexerLocalePack(resolvedLocale);
  return pack ? pack.apply(tokens, input) : cloneAndReindex(tokens);
}

/** Parser-owned locale lexemes for bounded autocomplete/discovery surfaces. */
export function listMedicationLocaleLexemes(locale: string): MedicationLocaleLexeme[] {
  const result: MedicationLocaleLexeme[] = [];
  const seen = new Set<string>();
  const add = (surface: string | undefined, canonical: string | undefined) => {
    const clean = surface?.trim();
    if (!clean || !canonical) return;
    const key = `${clean}\u0000${canonical}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ surface: clean, canonical });
  };

  for (const lexeme of getRelationLocaleSuggestionLexemes(locale)) {
    if (!/\s/u.test(lexeme.surface)) add(lexeme.surface, lexeme.canonical);
  }
  for (const definition of listMedicationInstructionActions()) {
    for (const surface of localizedConfig(definition.localeAliases, locale) ?? []) add(surface, definition.code);
  }
  for (const definition of listMedicationInstructionConcepts()) {
    for (const surface of localizedConfig(definition.localeAliases, locale) ?? []) add(surface, definition.code);
  }
  for (const lexeme of getMedicationLexerLocalePack(locale)?.listLexemes?.() ?? []) {
    add(lexeme.surface, lexeme.canonical);
  }
  return result;
}

registerMedicationLexerLocalePack({
  locale: "th",
  apply: applyThaiLocaleLexicon,
  listLexemes: () => listThaiMedicationLocaleLexemes("th")
});

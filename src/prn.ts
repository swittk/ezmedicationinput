import { CanonicalPrnReasonExpr } from "./types";
import { baseLanguageTag, localizedValue } from "./localization";
import { inferMedicationLocale } from "./locale-detection";
import { joinLocalizedTokens } from "./locale-realization";
import { ACTION_COORDINATION_CONNECTORS, ACTION_COORDINATION_CONNECTOR_I18N } from "./hpsg/lexical-classes";
import { lexInput } from "./lexer/lex";

export function getCanonicalPrnReasonText(reason: CanonicalPrnReasonExpr | undefined): string | undefined {
  return reason?.text ?? reason?.coding?.display;
}

export function joinCanonicalPrnReasonTexts(
  reasons: CanonicalPrnReasonExpr[] | undefined,
  conjunction = "or"
): string | undefined {
  if (!reasons?.length) {
    return undefined;
  }
  const texts: string[] = [];
  for (const reason of reasons) {
    const text = getCanonicalPrnReasonText(reason)?.trim();
    if (!text) {
      continue;
    }
    texts.push(text);
  }
  switch (texts.length) {
    case 0:
      return undefined;
    case 1:
      return texts[0];
    case 2:
      return `${texts[0]} ${conjunction} ${texts[1]}`;
    default: {
      let combined = "";
      for (let index = 0; index < texts.length; index += 1) {
        if (index === 0) {
          combined = texts[index];
          continue;
        }
        if (index === texts.length - 1) {
          combined += ` ${conjunction} ${texts[index]}`;
          continue;
        }
        combined += `, ${texts[index]}`;
      }
      return combined;
    }
  }
}

export function getPreferredCanonicalPrnReasonText(
  reason: CanonicalPrnReasonExpr | undefined,
  reasons: CanonicalPrnReasonExpr[] | undefined,
  conjunction = "or"
): string | undefined {
  const direct = getCanonicalPrnReasonText(reason)?.trim();
  if (!reasons?.length) {
    return direct;
  }
  if (!direct) {
    return joinCanonicalPrnReasonTexts(reasons, conjunction);
  }
  const coordinated = /[,/;]/.test(direct) || lexInput(direct).some((token) =>
    ACTION_COORDINATION_CONNECTORS.has(token.canonical ?? token.lower)
  );
  return coordinated ? joinCanonicalPrnReasonTexts(reasons, conjunction) : direct;
}

export function getLocalizedCanonicalPrnReasonText(
  reason: CanonicalPrnReasonExpr | undefined,
  reasons: CanonicalPrnReasonExpr[] | undefined,
  locale: string,
  conjunction?: string
): string | undefined {
  const targetLocale = baseLanguageTag(locale) ?? locale.toLowerCase();
  const localized = (item: CanonicalPrnReasonExpr | undefined): string | undefined => {
    if (!item) return undefined;
    const translated = localizedValue(item.i18n, locale) ?? localizedValue(item.coding?.i18n, locale);
    if (translated) return translated;
    const text = item.text?.trim();
    if (text && inferMedicationLocale(text, "en") === targetLocale) return text;
    const display = item.coding?.display?.trim();
    if (display) return targetLocale === "en"
      ? display.charAt(0).toLowerCase() + display.slice(1)
      : display;
    return text;
  };
  const list = reasons?.length ? reasons : reason ? [reason] : [];
  if (!list.length) return undefined;
  const texts = list.map(localized).filter((value): value is string => Boolean(value?.trim()));
  if (!texts.length) return undefined;
  if (texts.length === 1) return texts[0];
  const joiner = conjunction ?? localizedValue(ACTION_COORDINATION_CONNECTOR_I18N.or, locale) ?? "or";
  if (texts.length === 2) return joinLocalizedTokens(locale, [texts[0], joiner, texts[1]]);
  const head = texts.slice(0, -1).join(", ");
  return joinLocalizedTokens(locale, [head, joiner, texts[texts.length - 1]]);
}

import { CanonicalPrnReasonExpr } from "./types";

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
  return /[,/;]/.test(direct) || /\b(?:or|and|and\/or)\b/i.test(direct) || /\s(?:หรือ|และ)\s/.test(direct)
    ? joinCanonicalPrnReasonTexts(reasons, conjunction)
    : direct;
}

export function getLocalizedCanonicalPrnReasonText(
  reason: CanonicalPrnReasonExpr | undefined,
  reasons: CanonicalPrnReasonExpr[] | undefined,
  locale: string,
  conjunction?: string
): string | undefined {
  const thai = locale.toLowerCase().startsWith("th");
  const localized = (item: CanonicalPrnReasonExpr | undefined): string | undefined => {
    if (!item) return undefined;
    if (thai) {
      return item.i18n?.th ?? item.coding?.i18n?.th ?? item.text ?? item.coding?.display;
    }
    const text = item.text?.trim();
    if (text && !/[\u0E00-\u0E7F]/u.test(text)) return text;
    const display = item.coding?.display?.trim();
    return display ? display.charAt(0).toLowerCase() + display.slice(1) : text;
  };
  const list = reasons?.length ? reasons : reason ? [reason] : [];
  if (!list.length) return undefined;
  const texts = list.map(localized).filter((value): value is string => Boolean(value?.trim()));
  if (!texts.length) return undefined;
  if (texts.length === 1) return texts[0];
  const joiner = conjunction ?? (thai ? "หรือ" : "or");
  if (texts.length === 2) return `${texts[0]} ${joiner} ${texts[1]}`;
  return `${texts.slice(0, -1).join(", ")} ${joiner} ${texts[texts.length - 1]}`;
}

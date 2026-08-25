import source from "./body-site-context-terminology.json";
import { normalizeBodySiteKey } from "./maps";

export const AMBIGUOUS_DIGIT_SITE_KEYS = new Set(source.ambiguousDigitSiteKeys);
export const HAND_CONTEXT_KEYS = new Set(source.handContextKeys);
export const FOOT_CONTEXT_KEYS = new Set(source.footContextKeys);
export const BODY_SITE_SOURCE_LEAD_PREFIXES = [...source.sourceLeadPrefixes]
  .sort((left, right) => right.length - left.length);

export function stripBodySiteSourceLead(value: string): string {
  const trimmed = value.trim();
  const normalized = normalizeBodySiteKey(trimmed);
  for (const prefix of BODY_SITE_SOURCE_LEAD_PREFIXES) {
    const normalizedPrefix = normalizeBodySiteKey(prefix);
    if (normalized === normalizedPrefix) continue;
    if (normalized.startsWith(`${normalizedPrefix} `)) {
      return trimmed.slice(prefix.length).trim();
    }
    if (trimmed.startsWith(prefix) && !/[A-Za-z0-9]/u.test(prefix[prefix.length - 1] ?? "")) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return trimmed;
}

import { ParsedSigInternal } from "./parser";
import { EventTiming, FhirPeriodUnit, RouteCode } from "./types";

const ROUTE_SHORT: Partial<Record<RouteCode, string>> = {
  [RouteCode["Oral route"]]: "PO",
  [RouteCode["Sublingual route"]]: "SL",
  [RouteCode["Buccal route"]]: "BUC",
  [RouteCode["Respiratory tract route (qualifier value)"]]: "INH",
  [RouteCode["Nasal route"]]: "IN",
  [RouteCode["Topical route"]]: "TOP",
  [RouteCode["Transdermal route"]]: "TD",
  [RouteCode["Subcutaneous route"]]: "SC",
  [RouteCode["Intramuscular route"]]: "IM",
  [RouteCode["Intravenous route"]]: "IV",
  [RouteCode["Per rectum"]]: "PR",
  [RouteCode["Per vagina"]]: "PV",
  [RouteCode["Ophthalmic route"]]: "OPH",
  [RouteCode["Intravitreal route (qualifier value)"]]: "IVT"
};

const WHEN_TEXT: Partial<Record<EventTiming, string>> = {
  [EventTiming["Before Sleep"]]: "at bedtime",
  [EventTiming["Before Meal"]]: "before meals",
  [EventTiming["Before Breakfast"]]: "before breakfast",
  [EventTiming["Before Lunch"]]: "before lunch",
  [EventTiming["Before Dinner"]]: "before dinner",
  [EventTiming["After Meal"]]: "after meals",
  [EventTiming["After Breakfast"]]: "after breakfast",
  [EventTiming["After Lunch"]]: "after lunch",
  [EventTiming["After Dinner"]]: "after dinner",
  [EventTiming.Meal]: "with meals",
  [EventTiming.Breakfast]: "with breakfast",
  [EventTiming.Lunch]: "with lunch",
  [EventTiming.Dinner]: "with dinner",
  [EventTiming.Morning]: "in the morning",
  [EventTiming["Early Morning"]]: "in the early morning",
  [EventTiming["Late Morning"]]: "in the late morning",
  [EventTiming.Noon]: "at noon",
  [EventTiming.Afternoon]: "in the afternoon",
  [EventTiming["Early Afternoon"]]: "in the early afternoon",
  [EventTiming["Late Afternoon"]]: "in the late afternoon",
  [EventTiming.Evening]: "in the evening",
  [EventTiming["Early Evening"]]: "in the early evening",
  [EventTiming["Late Evening"]]: "in the late evening",
  [EventTiming.Night]: "at night",
  [EventTiming.Wake]: "after waking",
  [EventTiming["After Sleep"]]: "after sleep",
  [EventTiming.Immediate]: "immediately"
};

const DAY_NAMES: Record<string, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday"
};

interface RouteGrammar {
  verb: string;
  routePhrase?: string | ((context: { hasSite: boolean; internal: ParsedSigInternal }) => string | undefined);
  sitePreposition?: string;
}

const DEFAULT_ROUTE_GRAMMAR: RouteGrammar = { verb: "Use" };

const ROUTE_GRAMMAR: Partial<Record<RouteCode, RouteGrammar>> = {
  [RouteCode["Oral route"]]: { verb: "Take", routePhrase: "by mouth" },
  [RouteCode["Ophthalmic route"]]: {
    verb: "Instill",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "in the eye"),
    sitePreposition: "in"
  },
  [RouteCode["Intravitreal route (qualifier value)"]]: {
    verb: "Inject",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "into the eye"),
    sitePreposition: "into"
  },
  [RouteCode["Topical route"]]: {
    verb: "Apply",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "topically"),
    sitePreposition: "to"
  },
  [RouteCode["Transdermal route"]]: {
    verb: "Apply",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "transdermally"),
    sitePreposition: "to"
  },
  [RouteCode["Subcutaneous route"]]: {
    verb: "Inject",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "subcutaneously"),
    sitePreposition: "into"
  },
  [RouteCode["Intramuscular route"]]: {
    verb: "Inject",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "intramuscularly"),
    sitePreposition: "into"
  },
  [RouteCode["Intravenous route"]]: {
    verb: "Inject",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "intravenously"),
    sitePreposition: "into"
  },
  [RouteCode["Nasal route"]]: {
    verb: "Use",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "via nasal route"),
    sitePreposition: "into"
  },
  [RouteCode["Respiratory tract route (qualifier value)"]]: {
    verb: "Use",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "via inhalation"),
    sitePreposition: "into"
  }
};

function grammarFromRouteText(text: string | undefined): RouteGrammar | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("mouth") || normalized.includes("oral")) {
    return ROUTE_GRAMMAR[RouteCode["Oral route"]];
  }
  if (normalized.includes("ophthalm")) {
    return ROUTE_GRAMMAR[RouteCode["Ophthalmic route"]];
  }
  if (normalized.includes("intravitreal")) {
    return ROUTE_GRAMMAR[RouteCode["Intravitreal route (qualifier value)"]];
  }
  if (normalized.includes("topical")) {
    return ROUTE_GRAMMAR[RouteCode["Topical route"]];
  }
  if (normalized.includes("transdermal")) {
    return ROUTE_GRAMMAR[RouteCode["Transdermal route"]];
  }
  if (normalized.includes("subcutaneous") || normalized === "sc" || normalized === "sq") {
    return ROUTE_GRAMMAR[RouteCode["Subcutaneous route"]];
  }
  if (normalized.includes("intramuscular") || normalized === "im") {
    return ROUTE_GRAMMAR[RouteCode["Intramuscular route"]];
  }
  if (normalized.includes("intravenous") || normalized === "iv") {
    return ROUTE_GRAMMAR[RouteCode["Intravenous route"]];
  }
  if (normalized.includes("nasal")) {
    return ROUTE_GRAMMAR[RouteCode["Nasal route"]];
  }
  if (normalized.includes("inhal")) {
    return ROUTE_GRAMMAR[RouteCode["Respiratory tract route (qualifier value)"]];
  }
  return undefined;
}

function resolveRouteGrammar(internal: ParsedSigInternal): RouteGrammar {
  if (internal.routeCode && ROUTE_GRAMMAR[internal.routeCode]) {
    return ROUTE_GRAMMAR[internal.routeCode] ?? DEFAULT_ROUTE_GRAMMAR;
  }
  return grammarFromRouteText(internal.routeText) ?? DEFAULT_ROUTE_GRAMMAR;
}

function pluralize(unit: string, value: number): string {
  if (Math.abs(value) === 1) {
    if (unit === "tab") return "tablet";
    if (unit === "cap") return "capsule";
    return unit;
  }
  if (unit === "tab" || unit === "tablet") return "tablets";
  if (unit === "cap" || unit === "capsule") return "capsules";
  if (unit === "mL") return "mL";
  if (unit === "mg") return "mg";
  if (unit === "puff") return value === 1 ? "puff" : "puffs";
  if (unit === "patch") return value === 1 ? "patch" : "patches";
  if (unit === "drop") return value === 1 ? "drop" : "drops";
  if (unit === "suppository") return value === 1 ? "suppository" : "suppositories";
  return unit;
}

function describeFrequency(internal: ParsedSigInternal): string | undefined {
  const { frequency, frequencyMax, period, periodMax, periodUnit, timingCode } = internal;
  if (
    frequency !== undefined &&
    frequencyMax !== undefined &&
    periodUnit === FhirPeriodUnit.Day &&
    (!period || period === 1)
  ) {
    if (frequency === 1 && frequencyMax === 1) {
      return "once daily";
    }
    if (frequency === 1 && frequencyMax === 2) {
      return "one to two times daily";
    }
    return `${stripTrailingZero(frequency)} to ${stripTrailingZero(
      frequencyMax
    )} times daily`;
  }
  if (frequency && periodUnit === FhirPeriodUnit.Day && (!period || period === 1)) {
    if (frequency === 1) return "once daily";
    if (frequency === 2) return "twice daily";
    if (frequency === 3) return "three times daily";
    if (frequency === 4) return "four times daily";
    return `${stripTrailingZero(frequency)} times daily`;
  }
  if (periodUnit === FhirPeriodUnit.Hour && period) {
    if (periodMax && periodMax !== period) {
      return `every ${stripTrailingZero(period)} to ${stripTrailingZero(periodMax)} hours`;
    }
    return `every ${stripTrailingZero(period)} hour${period === 1 ? "" : "s"}`;
  }
  if (periodUnit === FhirPeriodUnit.Day && period && period !== 1) {
    if (period === 2 && (!periodMax || periodMax === 2)) {
      return "every other day";
    }
    if (periodMax && periodMax !== period) {
      return `every ${stripTrailingZero(period)} to ${stripTrailingZero(periodMax)} days`;
    }
    return `every ${stripTrailingZero(period)} days`;
  }
  if (periodUnit === FhirPeriodUnit.Week && period) {
    if (period === 1 && (!periodMax || periodMax === 1)) {
      return "once weekly";
    }
    if (periodMax && periodMax !== period) {
      return `every ${stripTrailingZero(period)} to ${stripTrailingZero(periodMax)} weeks`;
    }
    return `every ${stripTrailingZero(period)} weeks`;
  }
  if (periodUnit === FhirPeriodUnit.Month && period) {
    if (period === 1 && (!periodMax || periodMax === 1)) {
      return "once monthly";
    }
    if (periodMax && periodMax !== period) {
      return `every ${stripTrailingZero(period)} to ${stripTrailingZero(periodMax)} months`;
    }
    return `every ${stripTrailingZero(period)} months`;
  }
  if (timingCode) {
    if (timingCode === "WK") {
      return "once weekly";
    }
    if (timingCode === "MO") {
      return "once monthly";
    }
    const map: Record<string, string> = {
      BID: "twice daily",
      TID: "three times daily",
      QID: "four times daily",
      QD: "once daily",
      QOD: "every other day",
      Q6H: "every 6 hours",
      Q8H: "every 8 hours"
    };
    if (map[timingCode]) {
      return map[timingCode];
    }
  }
  if (frequency && periodUnit === undefined && period === undefined) {
    if (frequency === 1) return "once";
    return `${stripTrailingZero(frequency)} times`;
  }
  return undefined;
}

function formatDoseShort(internal: ParsedSigInternal): string | undefined {
  if (internal.doseRange) {
    const { low, high } = internal.doseRange;
    const base = `${stripTrailingZero(low)}-${stripTrailingZero(high)}`;
    if (internal.unit) {
      return `${base} ${internal.unit}`;
    }
    return base;
  }
  if (internal.dose !== undefined) {
    const dosePart = internal.unit
      ? `${stripTrailingZero(internal.dose)} ${internal.unit}`
      : `${stripTrailingZero(internal.dose)}`;
    return dosePart.trim();
  }
  return undefined;
}

function formatDoseLong(internal: ParsedSigInternal): string | undefined {
  if (internal.doseRange) {
    const { low, high } = internal.doseRange;
    if (internal.unit) {
      return `${stripTrailingZero(low)} to ${stripTrailingZero(high)} ${pluralize(
        internal.unit,
        high
      )}`;
    }
    return `${stripTrailingZero(low)} to ${stripTrailingZero(high)}`;
  }
  if (internal.dose !== undefined) {
    if (internal.unit) {
      return `${stripTrailingZero(internal.dose)} ${pluralize(internal.unit, internal.dose)}`;
    }
    return `${stripTrailingZero(internal.dose)}`;
  }
  return undefined;
}

function collectWhenPhrases(internal: ParsedSigInternal): string[] {
  if (!internal.when.length) {
    return [];
  }
  const unique: EventTiming[] = [];
  const seen = new Set<EventTiming>();
  for (const code of internal.when) {
    if (!seen.has(code)) {
      seen.add(code);
      unique.push(code);
    }
  }
  const hasSpecificAfter = unique.some((code) =>
    code === EventTiming["After Breakfast"] ||
    code === EventTiming["After Lunch"] ||
    code === EventTiming["After Dinner"]
  );
  const hasSpecificBefore = unique.some((code) =>
    code === EventTiming["Before Breakfast"] ||
    code === EventTiming["Before Lunch"] ||
    code === EventTiming["Before Dinner"]
  );
  const hasSpecificWith = unique.some((code) =>
    code === EventTiming.Breakfast ||
    code === EventTiming.Lunch ||
    code === EventTiming.Dinner
  );
  return unique
    .filter((code) => {
      if (code === EventTiming["After Meal"] && hasSpecificAfter) {
        return false;
      }
      if (code === EventTiming["Before Meal"] && hasSpecificBefore) {
        return false;
      }
      if (code === EventTiming.Meal && hasSpecificWith) {
        return false;
      }
      return true;
    })
    .map((code) => WHEN_TEXT[code] ?? code)
    .filter((text): text is string => Boolean(text));
}

function joinWithAnd(parts: string[]): string {
  if (!parts.length) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0];
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function combineFrequencyAndEvents(
  frequency: string | undefined,
  events: string[],
): { frequency?: string; event?: string } {
  if (!frequency) {
    if (!events.length) {
      return {};
    }
    return { event: joinWithAnd(events) };
  }
  if (!events.length) {
    return { frequency };
  }
  if (events.length === 1 && events[0] === "at bedtime") {
    const lowerFrequency = frequency.toLowerCase();
    if (lowerFrequency === "twice daily" || lowerFrequency === "three times daily" || lowerFrequency === "four times daily") {
      return { frequency: `${frequency} and ${events[0]}` };
    }
  }
  return { frequency, event: joinWithAnd(events) };
}

function buildRoutePhrase(
  internal: ParsedSigInternal,
  grammar: RouteGrammar,
  hasSite: boolean,
): string | undefined {
  if (typeof grammar.routePhrase === "function") {
    return grammar.routePhrase({ hasSite, internal });
  }
  if (typeof grammar.routePhrase === "string") {
    return grammar.routePhrase;
  }
  const text = internal.routeText?.trim();
  if (!text) {
    return undefined;
  }
  const normalized = text.toLowerCase();
  if (normalized.startsWith("by ") || normalized.startsWith("per ") || normalized.startsWith("via ")) {
    return text;
  }
  if (normalized === "oral") {
    return "by mouth";
  }
  if (normalized === "intravenous") {
    return "intravenously";
  }
  if (normalized === "intramuscular") {
    return "intramuscularly";
  }
  if (normalized === "subcutaneous") {
    return "subcutaneously";
  }
  if (normalized === "topical") {
    return "topically";
  }
  if (normalized === "transdermal") {
    return "transdermally";
  }
  if (normalized === "intranasal" || normalized === "nasal") {
    return "via nasal route";
  }
  if (normalized.includes("inhal")) {
    return "via inhalation";
  }
  return `via ${text}`;
}

function formatSite(internal: ParsedSigInternal, grammar: RouteGrammar): string | undefined {
  const text = internal.siteText?.trim();
  if (!text) {
    return undefined;
  }
  const lower = text.toLowerCase();
  let preposition = grammar.sitePreposition;
  if (!preposition) {
    if (lower.includes("eye")) {
      preposition = "in";
    } else if (lower.includes("nostril") || lower.includes("nose")) {
      preposition = "into";
    } else if (lower.includes("lung") || lower.includes("airway") || lower.includes("bronch")) {
      preposition = "into";
    } else if (lower.includes("ear")) {
      preposition = "in";
    } else if (
      /(skin|arm|leg|thigh|abdomen|shoulder|hand|foot|cheek|forearm|back|buttock|hip)/.test(lower)
    ) {
      preposition = "to";
    } else {
      preposition = "at";
    }
  }
  const noun = formatSiteNoun(text, preposition);
  return `${preposition} ${noun}`.trim();
}

function formatSiteNoun(site: string, preposition: string): string {
  const trimmed = site.trim();
  const lower = trimmed.toLowerCase();
  const skipArticlePrefixes = [
    "the ",
    "both ",
    "each ",
    "either ",
    "every ",
    "all ",
    "bilateral ",
  ];
  for (const prefix of skipArticlePrefixes) {
    if (lower.startsWith(prefix)) {
      return trimmed;
    }
  }
  const needsArticle = /^(left|right|upper|lower|inner|outer|mid|middle|posterior|anterior|proximal|distal|medial|lateral|dorsal|ventral)\b/.test(
    lower,
  );
  if (needsArticle || preposition === "at") {
    return `the ${trimmed}`;
  }
  if (
    /(eye|nostril|ear|arm|leg|thigh|abdomen|hand|foot|cheek|skin|back)/.test(lower)
  ) {
    return `the ${trimmed}`;
  }
  return `the ${trimmed}`;
}

function describeDayOfWeek(internal: ParsedSigInternal): string | undefined {
  if (!internal.dayOfWeek.length) {
    return undefined;
  }
  const days = internal.dayOfWeek.map((d) => DAY_NAMES[d] ?? d);
  if (!days.length) {
    return undefined;
  }
  return `on ${joinWithAnd(days)}`;
}

export function formatInternal(
  internal: ParsedSigInternal,
  style: "short" | "long"
): string {
  if (style === "short") {
    return formatShort(internal);
  }
  return formatLong(internal);
}

function formatShort(internal: ParsedSigInternal): string {
  const parts: string[] = [];
  const dosePart = formatDoseShort(internal);
  if (dosePart) {
    parts.push(dosePart);
  }
  if (internal.routeCode) {
    const short = ROUTE_SHORT[internal.routeCode];
    if (short) {
      parts.push(short);
    } else if (internal.routeText) {
      parts.push(internal.routeText);
    }
  } else if (internal.routeText) {
    parts.push(internal.routeText);
  }
  if (internal.timingCode) {
    parts.push(internal.timingCode);
  } else if (
    internal.frequency !== undefined &&
    internal.frequencyMax !== undefined &&
    internal.periodUnit === FhirPeriodUnit.Day &&
    (!internal.period || internal.period === 1)
  ) {
    parts.push(
      `${stripTrailingZero(internal.frequency)}-${stripTrailingZero(
        internal.frequencyMax
      )}x/d`
    );
  } else if (
    internal.frequency &&
    internal.periodUnit === FhirPeriodUnit.Day &&
    (!internal.period || internal.period === 1)
  ) {
    parts.push(`${stripTrailingZero(internal.frequency)}x/d`);
  } else if (internal.period && internal.periodUnit) {
    const base = stripTrailingZero(internal.period);
    const qualifier =
      internal.periodMax && internal.periodMax !== internal.period
        ? `${base}-${stripTrailingZero(internal.periodMax)}`
        : base;
    parts.push(`Q${qualifier}${internal.periodUnit.toUpperCase()}`);
  }
  if (internal.when.length) {
    parts.push(internal.when.join(" "));
  }
  if (internal.dayOfWeek.length) {
    parts.push(
      internal.dayOfWeek
        .map((d) => d.charAt(0).toUpperCase() + d.slice(1, 3))
        .join(",")
    );
  }
  if (internal.asNeeded) {
    if (internal.asNeededReason) {
      parts.push(`PRN ${internal.asNeededReason}`);
    } else {
      parts.push("PRN");
    }
  }
  return parts.filter(Boolean).join(" ");
}

function formatLong(internal: ParsedSigInternal): string {
  const grammar = resolveRouteGrammar(internal);
  const dosePart = formatDoseLong(internal) ?? "the medication";
  const sitePart = formatSite(internal, grammar);
  const routePart = buildRoutePhrase(internal, grammar, Boolean(sitePart));
  const frequencyPart = describeFrequency(internal);
  const eventParts = collectWhenPhrases(internal);
  const timing = combineFrequencyAndEvents(frequencyPart, eventParts);
  const dayPart = describeDayOfWeek(internal);
  const asNeededPart = internal.asNeeded
    ? internal.asNeededReason
      ? `as needed for ${internal.asNeededReason}`
      : "as needed"
    : undefined;

  const segments: string[] = [dosePart];
  if (routePart) {
    segments.push(routePart);
  }
  if (timing.frequency) {
    segments.push(timing.frequency);
  }
  if (timing.event) {
    segments.push(timing.event);
  }
  if (dayPart) {
    segments.push(dayPart);
  }
  if (asNeededPart) {
    segments.push(asNeededPart);
  }
  if (sitePart) {
    segments.push(sitePart);
  }
  const body = segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!body) {
    return `${grammar.verb}.`;
  }
  return `${grammar.verb} ${body}.`;
}

function stripTrailingZero(value: number): string {
  const text = value.toString();
  if (text.includes(".")) {
    return text.replace(/\.0+$/, "").replace(/0+$/, "");
  }
  return text;
}

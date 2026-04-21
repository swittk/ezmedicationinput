import { buildCanonicalSigClauses } from "./ir";
import { ParsedSigInternal } from "./internal-types";
import type { SigLocalization, SigLongContext, SigShortContext } from "./i18n";
import {
  CanonicalDoseExpr,
  CanonicalScheduleExpr,
  CanonicalSigClause,
  EventTiming,
  FhirPeriodUnit,
  RouteCode
} from "./types";
import {
  getMealTimingGroup,
  inferDailyOccurrenceCount,
  type MealTimingGroup,
  type TimingSummaryOptions
} from "./timing-summary";

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

const EN_TIMES_PER_DAY: Record<number, string> = {
  1: "once daily",
  2: "twice daily",
  3: "three times daily",
  4: "four times daily"
};

interface RouteGrammar {
  verb: string;
  routePhrase?: string | ((context: { hasSite: boolean; clause: CanonicalSigClause }) => string | undefined);
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
  [RouteCode["Per rectum"]]: {
    verb: "Use",
    routePhrase: ({ hasSite }) => (hasSite ? undefined : "rectally"),
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

function scheduleOf(clause: CanonicalSigClause): CanonicalScheduleExpr {
  return clause.schedule ?? {};
}

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
  if (normalized.includes("rectal") || normalized.includes("rectum")) {
    return ROUTE_GRAMMAR[RouteCode["Per rectum"]];
  }
  if (normalized.includes("nasal")) {
    return ROUTE_GRAMMAR[RouteCode["Nasal route"]];
  }
  if (normalized.includes("inhal")) {
    return ROUTE_GRAMMAR[RouteCode["Respiratory tract route (qualifier value)"]];
  }
  return undefined;
}

function resolveRouteGrammar(clause: CanonicalSigClause): RouteGrammar {
  const routeCode = clause.route?.code;
  if (routeCode && ROUTE_GRAMMAR[routeCode]) {
    return ROUTE_GRAMMAR[routeCode] ?? DEFAULT_ROUTE_GRAMMAR;
  }
  return grammarFromRouteText(clause.route?.text) ?? DEFAULT_ROUTE_GRAMMAR;
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

function describeFrequency(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const frequency = schedule?.frequency;
  const frequencyMax = schedule?.frequencyMax;
  const period = schedule?.period;
  const periodMax = schedule?.periodMax;
  const periodUnit = schedule?.periodUnit;
  const timingCode = schedule?.timingCode;

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
    return `${stripTrailingZero(frequency)} to ${stripTrailingZero(frequencyMax)} times daily`;
  }
  if (frequency && periodUnit === FhirPeriodUnit.Day && (!period || period === 1)) {
    const dailyText = EN_TIMES_PER_DAY[frequency];
    if (dailyText) {
      return dailyText;
    }
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
    if (frequency === 1) {
      return "once";
    }
    return `${stripTrailingZero(frequency)} times`;
  }
  return undefined;
}

function describeFrequencyCount(count: number | undefined): string | undefined {
  if (!count || count <= 0) {
    return undefined;
  }
  const dailyText = EN_TIMES_PER_DAY[count];
  if (dailyText) {
    return dailyText;
  }
  return `${stripTrailingZero(count)} times daily`;
}

function formatDoseShort(dose: CanonicalDoseExpr | undefined): string | undefined {
  if (!dose) {
    return undefined;
  }
  if (dose.range) {
    const base = `${stripTrailingZero(dose.range.low)}-${stripTrailingZero(dose.range.high)}`;
    if (dose.unit) {
      return `${base} ${dose.unit}`;
    }
    return base;
  }
  if (dose.value !== undefined) {
    if (dose.unit) {
      return `${stripTrailingZero(dose.value)} ${dose.unit}`;
    }
    return `${stripTrailingZero(dose.value)}`;
  }
  return undefined;
}

function formatDoseLong(dose: CanonicalDoseExpr | undefined): string | undefined {
  if (!dose) {
    return undefined;
  }
  if (dose.range) {
    if (dose.unit) {
      return `${stripTrailingZero(dose.range.low)} to ${stripTrailingZero(dose.range.high)} ${pluralize(
        dose.unit,
        dose.range.high
      )}`;
    }
    return `${stripTrailingZero(dose.range.low)} to ${stripTrailingZero(dose.range.high)}`;
  }
  if (dose.value !== undefined) {
    if (dose.unit) {
      return `${stripTrailingZero(dose.value)} ${pluralize(dose.unit, dose.value)}`;
    }
    return `${stripTrailingZero(dose.value)}`;
  }
  return undefined;
}

function summarizeMealTimingGroup(group: MealTimingGroup): string {
  let relationText = "with";
  if (group.relation === "before") {
    relationText = "before";
  } else if (group.relation === "after") {
    relationText = "after";
  }
  return `${relationText} ${joinWithAnd(group.meals)}`;
}

function collectWhenPhrases(
  schedule: CanonicalScheduleExpr | undefined,
  options?: TimingSummaryOptions
): string[] {
  const when = schedule?.when ?? [];
  if (!when.length) {
    return [];
  }
  const unique: EventTiming[] = [];
  const seen = new Set<EventTiming>();
  let hasSpecificAfter = false;
  let hasSpecificBefore = false;
  let hasSpecificWith = false;

  for (const code of when) {
    if (!seen.has(code)) {
      seen.add(code);
      unique.push(code);
      if (
        code === EventTiming["After Breakfast"] ||
        code === EventTiming["After Lunch"] ||
        code === EventTiming["After Dinner"]
      ) {
        hasSpecificAfter = true;
      }
      if (
        code === EventTiming["Before Breakfast"] ||
        code === EventTiming["Before Lunch"] ||
        code === EventTiming["Before Dinner"]
      ) {
        hasSpecificBefore = true;
      }
      if (code === EventTiming.Breakfast || code === EventTiming.Lunch || code === EventTiming.Dinner) {
        hasSpecificWith = true;
      }
    }
  }

  const filtered: EventTiming[] = [];
  for (const code of unique) {
    if (code === EventTiming["After Meal"] && hasSpecificAfter) {
      continue;
    }
    if (code === EventTiming["Before Meal"] && hasSpecificBefore) {
      continue;
    }
    if (code === EventTiming.Meal && hasSpecificWith) {
      continue;
    }
    filtered.push(code);
  }

  const mealGroup = getMealTimingGroup(filtered, options);
  if (!mealGroup) {
    const phrases: string[] = [];
    for (const code of filtered) {
      const text = WHEN_TEXT[code] ?? code;
      if (text) {
        phrases.push(text);
      }
    }
    return phrases;
  }

  const groupedCodes = new Set<EventTiming>(mealGroup.codes);
  const phrases: string[] = [];
  let insertedGroup = false;
  for (const code of filtered) {
    if (groupedCodes.has(code)) {
      if (!insertedGroup) {
        phrases.push(summarizeMealTimingGroup(mealGroup));
        insertedGroup = true;
      }
      continue;
    }
    const text = WHEN_TEXT[code] ?? code;
    if (text) {
      phrases.push(text);
    }
  }
  return phrases;
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
  events: string[]
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
    if (
      lowerFrequency === "twice daily" ||
      lowerFrequency === "three times daily" ||
      lowerFrequency === "four times daily"
    ) {
      return { frequency: `${frequency} and ${events[0]}` };
    }
  }
  return { frequency, event: joinWithAnd(events) };
}

function buildRoutePhrase(
  clause: CanonicalSigClause,
  grammar: RouteGrammar,
  hasSite: boolean
): string | undefined {
  if (typeof grammar.routePhrase === "function") {
    return grammar.routePhrase({ hasSite, clause });
  }
  if (typeof grammar.routePhrase === "string") {
    return grammar.routePhrase;
  }
  const text = clause.route?.text?.trim();
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

function formatSite(clause: CanonicalSigClause, grammar: RouteGrammar): string | undefined {
  const text = clause.site?.text?.trim();
  if (!text) {
    return undefined;
  }
  const lower = text.toLowerCase();
  if (clause.route?.code === RouteCode["Per rectum"] && (lower === "rectum" || lower === "rectal")) {
    return undefined;
  }
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
      /(skin|head|temple|arm|leg|thigh|abdomen|shoulder|elbow|wrist|ankle|knee|hand|foot|cheek|forearm|back|chest|breast|axilla|armpit|groin|lip|buttock|hip|face|hair|scalp|forehead|eyelid|chin|neck)/.test(
        lower
      )
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
  const skipArticlePrefixes = ["the ", "both ", "each ", "either ", "every ", "all ", "bilateral "];
  for (const prefix of skipArticlePrefixes) {
    if (lower.startsWith(prefix)) {
      return trimmed;
    }
  }
  const needsArticle =
    /^(left|right|upper|lower|inner|outer|mid|middle|posterior|anterior|proximal|distal|medial|lateral|dorsal|ventral)\b/.test(
      lower
    );
  if (needsArticle || preposition === "at") {
    return `the ${trimmed}`;
  }
  return `the ${trimmed}`;
}

function describeDayOfWeek(schedule: CanonicalScheduleExpr | undefined): string | undefined {
  const dayOfWeek = schedule?.dayOfWeek ?? [];
  if (!dayOfWeek.length) {
    return undefined;
  }
  const days: string[] = [];
  for (const day of dayOfWeek) {
    days.push(DAY_NAMES[day] ?? day);
  }
  return days.length ? `on ${joinWithAnd(days)}` : undefined;
}

function formatShort(clause: CanonicalSigClause): string {
  const schedule = scheduleOf(clause);
  const parts: string[] = [];
  const dosePart = formatDoseShort(clause.dose);
  if (dosePart) {
    parts.push(dosePart);
  }
  const routeCode = clause.route?.code;
  const routeText = clause.route?.text;
  if (routeCode) {
    const short = ROUTE_SHORT[routeCode];
    if (short) {
      parts.push(short);
    } else if (routeText) {
      parts.push(routeText);
    }
  } else if (routeText) {
    parts.push(routeText);
  }
  if (schedule.timingCode) {
    parts.push(schedule.timingCode);
  } else if (
    schedule.frequency !== undefined &&
    schedule.frequencyMax !== undefined &&
    schedule.periodUnit === FhirPeriodUnit.Day &&
    (!schedule.period || schedule.period === 1)
  ) {
    parts.push(`${stripTrailingZero(schedule.frequency)}-${stripTrailingZero(schedule.frequencyMax)}x/d`);
  } else if (
    schedule.frequency &&
    schedule.periodUnit === FhirPeriodUnit.Day &&
    (!schedule.period || schedule.period === 1)
  ) {
    parts.push(`${stripTrailingZero(schedule.frequency)}x/d`);
  } else if (schedule.period && schedule.periodUnit) {
    const base = stripTrailingZero(schedule.period);
    const qualifier =
      schedule.periodMax && schedule.periodMax !== schedule.period
        ? `${base}-${stripTrailingZero(schedule.periodMax)}`
        : base;
    parts.push(`Q${qualifier}${schedule.periodUnit.toUpperCase()}`);
  }
  if (schedule.when?.length) {
    parts.push(schedule.when.join(" "));
  }
  if (schedule.dayOfWeek?.length) {
    const days: string[] = [];
    for (const day of schedule.dayOfWeek) {
      days.push(day.charAt(0).toUpperCase() + day.slice(1, 3));
    }
    parts.push(days.join(","));
  }
  if (schedule.timeOfDay?.length) {
    const times: string[] = [];
    for (const time of schedule.timeOfDay) {
      times.push(time.slice(0, 5));
    }
    parts.push(times.join(","));
  }
  if (schedule.count !== undefined) {
    parts.push(`x${stripTrailingZero(schedule.count)}`);
  }
  if (clause.prn?.enabled) {
    const reason = clause.prn.reason?.text ?? clause.prn.reason?.coding?.display;
    if (reason) {
      parts.push(`PRN ${reason}`);
    } else {
      parts.push("PRN");
    }
  }
  return parts.filter(Boolean).join(" ");
}

function formatLong(clause: CanonicalSigClause, options?: TimingSummaryOptions): string {
  const schedule = scheduleOf(clause);
  const grammar = resolveRouteGrammar(clause);
  const dosePart = formatDoseLong(clause.dose) ?? "the medication";
  const sitePart = formatSite(clause, grammar);
  const routePart = buildRoutePhrase(clause, grammar, Boolean(sitePart));
  const frequencyPart =
    describeFrequency(schedule) ??
    describeFrequencyCount(inferDailyOccurrenceCount(schedule, options));
  const eventParts = collectWhenPhrases(schedule, options);
  if (schedule.timeOfDay?.length) {
    const timeStrings: string[] = [];
    for (const time of schedule.timeOfDay) {
      const parts = time.split(":");
      const hours = Number(parts[0]);
      const minutes = Number(parts[1]);
      if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
        continue;
      }
      const isAm = hours < 12;
      const displayHours = hours % 12 || 12;
      const displayMinutes = minutes < 10 ? `0${minutes}` : `${minutes}`;
      timeStrings.push(`${displayHours}:${displayMinutes}${isAm ? " am" : " pm"}`);
    }
    if (timeStrings.length) {
      eventParts.push(`at ${timeStrings.join(", ")}`);
    }
  }
  const timing = combineFrequencyAndEvents(frequencyPart, eventParts);
  const dayPart = describeDayOfWeek(schedule);
  const countPart =
    schedule.count !== undefined
      ? `for ${stripTrailingZero(schedule.count)} ${schedule.count === 1 ? "dose" : "doses"}`
      : undefined;
  const reason = clause.prn?.reason?.text ?? clause.prn?.reason?.coding?.display;
  const asNeededPart = clause.prn?.enabled ? (reason ? `as needed for ${reason}` : "as needed") : undefined;

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
  if (countPart) {
    segments.push(countPart);
  }
  if (asNeededPart) {
    segments.push(asNeededPart);
  }
  if (sitePart) {
    segments.push(sitePart);
  }
  const body = segments.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const instructionText = formatAdditionalInstructions(clause);
  if (!body) {
    if (!instructionText) {
      return `${grammar.verb}.`;
    }
    return `${grammar.verb}. ${instructionText}`.trim();
  }
  const baseSentence = `${grammar.verb} ${body}.`;
  return instructionText ? `${baseSentence} ${instructionText}` : baseSentence;
}

function formatAdditionalInstructions(clause: CanonicalSigClause): string | undefined {
  const instructions = clause.additionalInstructions ?? [];
  if (!instructions.length) {
    return undefined;
  }
  const phrases: string[] = [];
  for (const instruction of instructions) {
    const text = instruction.text ?? instruction.coding?.display;
    if (!text) {
      continue;
    }
    const trimmed = text.trim();
    if (trimmed) {
      phrases.push(trimmed);
    }
  }
  if (!phrases.length) {
    return undefined;
  }
  return phrases.map((phrase) => (/[.!?]$/.test(phrase) ? phrase : `${phrase}.`)).join(" ").trim();
}

function firstCanonicalClause(internal: ParsedSigInternal): CanonicalSigClause {
  const clauses = buildCanonicalSigClauses(internal);
  if (clauses.length > 0) {
    return clauses[0];
  }
  return {
    kind: "administration",
    rawText: internal.input,
    raw: { start: 0, end: internal.input.length, text: internal.input },
    leftovers: [],
    evidence: [],
    confidence: 0
  };
}

export function formatCanonicalClause(
  clause: CanonicalSigClause,
  style: "short" | "long",
  localization?: SigLocalization,
  options?: TimingSummaryOptions
): string {
  const defaults = {
    short: formatShort(clause),
    long: formatLong(clause, options)
  } as const;

  if (!localization) {
    return defaults[style];
  }

  const formatDefault = (target: "short" | "long") => defaults[target];

  if (style === "short" && localization.formatShort) {
    const context: SigShortContext = {
      style: "short",
      clause,
      defaultText: defaults.short,
      groupMealTimingsByRelation: Boolean(options?.groupMealTimingsByRelation),
      includeTimesPerDaySummary: Boolean(options?.includeTimesPerDaySummary),
      formatDefault
    };
    return localization.formatShort(context);
  }

  if (style === "long" && localization.formatLong) {
    const context: SigLongContext = {
      style: "long",
      clause,
      defaultText: defaults.long,
      groupMealTimingsByRelation: Boolean(options?.groupMealTimingsByRelation),
      includeTimesPerDaySummary: Boolean(options?.includeTimesPerDaySummary),
      formatDefault
    };
    return localization.formatLong(context);
  }

  return defaults[style];
}

export function formatInternal(
  internal: ParsedSigInternal,
  style: "short" | "long",
  localization?: SigLocalization,
  options?: TimingSummaryOptions
): string {
  return formatCanonicalClause(firstCanonicalClause(internal), style, localization, options);
}

function stripTrailingZero(value: number): string {
  const text = value.toString();
  if (text.includes(".")) {
    return text.replace(/\.0+$/, "").replace(/0+$/, "");
  }
  return text;
}

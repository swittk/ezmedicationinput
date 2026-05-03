import { CanonicalScheduleExpr, EventTiming, FhirPeriodUnit } from "./types";
import {
  getMealTimingGroup,
  inferDailyOccurrenceCount,
  type MealTimingGroup,
  type TimingSummaryOptions
} from "./timing-summary";

export type BedtimeJoinStyle = "adjacent" | "conjunction" | "separate";

export interface LocalizedTimingGrammar {
  readonly whenText: Partial<Record<EventTiming, string>>;
  joinList(parts: string[]): string;
  summarizeMealTimingGroup(group: MealTimingGroup): string;
  bedtimeJoinStyle?(dailyCount: number | undefined): BedtimeJoinStyle;
}

function uniqueWhenEvents(schedule: CanonicalScheduleExpr | undefined): EventTiming[] {
  const when = schedule?.when ?? [];
  if (!when.length) {
    return [];
  }
  const unique: EventTiming[] = [];
  const seen = new Set<EventTiming>();
  for (const code of when) {
    if (!seen.has(code)) {
      seen.add(code);
      unique.push(code);
    }
  }
  return unique;
}

export function filterLocalizedWhenEvents(
  schedule: CanonicalScheduleExpr | undefined
): EventTiming[] {
  const unique = uniqueWhenEvents(schedule);
  let hasSpecificAfter = false;
  let hasSpecificBefore = false;
  let hasSpecificWith = false;

  for (const code of unique) {
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
  return filtered;
}

export function collectLocalizedWhenPhrases(
  schedule: CanonicalScheduleExpr | undefined,
  grammar: LocalizedTimingGrammar,
  options?: TimingSummaryOptions
): string[] {
  const filtered = filterLocalizedWhenEvents(schedule);
  if (!filtered.length) {
    return [];
  }

  const mealGroup = getMealTimingGroup(filtered, options);
  if (!mealGroup) {
    const phrases: string[] = [];
    for (const code of filtered) {
      const text = grammar.whenText[code];
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
        phrases.push(grammar.summarizeMealTimingGroup(mealGroup));
        insertedGroup = true;
      }
      continue;
    }
    const text = grammar.whenText[code];
    if (text) {
      phrases.push(text);
    }
  }
  return phrases;
}

function inferExplicitDailyFrequency(schedule: CanonicalScheduleExpr | undefined): number | undefined {
  if (!schedule) {
    return undefined;
  }
  if (
    schedule.frequency !== undefined &&
    schedule.frequencyMax === undefined &&
    schedule.periodUnit === FhirPeriodUnit.Day &&
    (schedule.period === undefined || schedule.period === 1) &&
    schedule.periodMax === undefined
  ) {
    return schedule.frequency;
  }

  switch (schedule.timingCode?.toUpperCase()) {
    case "QD":
      return 1;
    case "BID":
      return 2;
    case "TID":
      return 3;
    case "QID":
      return 4;
    default:
      return undefined;
  }
}

function isBedtimeOnlyWhen(
  schedule: CanonicalScheduleExpr | undefined
): boolean {
  const filtered = filterLocalizedWhenEvents(schedule);
  return filtered.length === 1 && filtered[0] === EventTiming["Before Sleep"];
}

export function combineLocalizedFrequencyAndEvents(
  schedule: CanonicalScheduleExpr | undefined,
  frequency: string | undefined,
  events: string[],
  grammar: LocalizedTimingGrammar,
  options?: TimingSummaryOptions
): { frequency?: string; event?: string } {
  if (!frequency) {
    if (!events.length) {
      return {};
    }
    return { event: grammar.joinList(events) };
  }
  if (!events.length) {
    return { frequency };
  }

  if (events.length === 1 && isBedtimeOnlyWhen(schedule)) {
    const dailyCount =
      inferExplicitDailyFrequency(schedule) ??
      inferDailyOccurrenceCount(schedule ?? {}, options);
    const style = grammar.bedtimeJoinStyle?.(dailyCount) ?? "separate";
    if (style === "adjacent") {
      return { frequency: `${frequency} ${events[0]}` };
    }
    if (style === "conjunction") {
      return { frequency: grammar.joinList([frequency, events[0]]) };
    }
  }

  return { frequency, event: grammar.joinList(events) };
}

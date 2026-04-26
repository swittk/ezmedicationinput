import { EventTiming, FhirDayOfWeek, FhirPeriodUnit } from "./types";

export interface TimingSummaryOptions {
  groupMealTimingsByRelation?: boolean;
  includeTimesPerDaySummary?: boolean;
}

export type MealRelation = "before" | "after" | "with";
export type MealName = "breakfast" | "lunch" | "dinner";

export interface MealTimingGroup {
  relation: MealRelation;
  meals: MealName[];
  codes: EventTiming[];
}

export interface TimingSummaryInput {
  frequency?: number;
  frequencyMax?: number;
  period?: number;
  periodMax?: number;
  periodUnit?: FhirPeriodUnit;
  timingCode?: string;
  dayOfWeek?: FhirDayOfWeek[];
  when?: EventTiming[];
  timeOfDay?: string[];
}

const MEAL_TIMING_DETAILS: Partial<Record<EventTiming, { relation: MealRelation; meal: MealName }>> = {
  [EventTiming["Before Breakfast"]]: { relation: "before", meal: "breakfast" },
  [EventTiming["Before Lunch"]]: { relation: "before", meal: "lunch" },
  [EventTiming["Before Dinner"]]: { relation: "before", meal: "dinner" },
  [EventTiming["After Breakfast"]]: { relation: "after", meal: "breakfast" },
  [EventTiming["After Lunch"]]: { relation: "after", meal: "lunch" },
  [EventTiming["After Dinner"]]: { relation: "after", meal: "dinner" },
  [EventTiming.Breakfast]: { relation: "with", meal: "breakfast" },
  [EventTiming.Lunch]: { relation: "with", meal: "lunch" },
  [EventTiming.Dinner]: { relation: "with", meal: "dinner" }
};

const MEAL_ORDER: Record<MealName, number> = {
  breakfast: 0,
  lunch: 1,
  dinner: 2
};

const INFERABLE_DAILY_EVENT_TIMINGS = new Set<EventTiming>([
  EventTiming["Before Sleep"],
  EventTiming["Before Breakfast"],
  EventTiming["Before Lunch"],
  EventTiming["Before Dinner"],
  EventTiming["After Breakfast"],
  EventTiming["After Lunch"],
  EventTiming["After Dinner"],
  EventTiming.Breakfast,
  EventTiming.Lunch,
  EventTiming.Dinner,
  EventTiming.Morning,
  EventTiming["Early Morning"],
  EventTiming["Late Morning"],
  EventTiming.Noon,
  EventTiming.Afternoon,
  EventTiming["Early Afternoon"],
  EventTiming["Late Afternoon"],
  EventTiming.Evening,
  EventTiming["Early Evening"],
  EventTiming["Late Evening"],
  EventTiming.Night,
  EventTiming.Wake,
  EventTiming["After Sleep"]
]);

function uniqueValues<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function getMealTimingGroup(
  when: EventTiming[],
  options?: TimingSummaryOptions
): MealTimingGroup | undefined {
  if (!options?.groupMealTimingsByRelation) {
    return undefined;
  }

  const uniqueWhen = uniqueValues(when);
  if (uniqueWhen.length < 2) {
    return undefined;
  }

  let relation: MealRelation | undefined;
  const meals: MealName[] = [];
  const groupedCodes: EventTiming[] = [];
  let sawFirstMeal = false;
  for (let i = 0; i < uniqueWhen.length; i += 1) {
    const code = uniqueWhen[i];
    const detail = MEAL_TIMING_DETAILS[code];
    if (!detail) {
      if (sawFirstMeal) {
        break;
      }
      continue;
    }
    if (!sawFirstMeal) {
      sawFirstMeal = true;
    }
    if (!relation) {
      relation = detail.relation;
    } else if (relation !== detail.relation && detail.relation !== "with") {
      break;
    }
    meals.push(detail.meal);
    groupedCodes.push(code);
  }

  if (groupedCodes.length < 2) {
    return undefined;
  }

  for (let i = 1; i < meals.length; i += 1) {
    const current = meals[i];
    let j = i - 1;
    while (j >= 0 && MEAL_ORDER[meals[j]] > MEAL_ORDER[current]) {
      meals[j + 1] = meals[j];
      j -= 1;
    }
    meals[j + 1] = current;
  }

  if (!relation) {
    return undefined;
  }

  return {
    relation,
    meals,
    codes: groupedCodes
  };
}

export function inferDailyOccurrenceCount(
  input: TimingSummaryInput,
  options?: TimingSummaryOptions
): number | undefined {
  if (!options?.includeTimesPerDaySummary) {
    return undefined;
  }

  if (input.frequency !== undefined || input.frequencyMax !== undefined || input.timingCode) {
    return undefined;
  }
  if (input.period !== undefined || input.periodMax !== undefined || input.periodUnit !== undefined) {
    return undefined;
  }
  if ((input.dayOfWeek?.length ?? 0) > 0) {
    return undefined;
  }

  const uniqueWhen = uniqueValues(input.when ?? []);
  for (let i = 0; i < uniqueWhen.length; i += 1) {
    if (!INFERABLE_DAILY_EVENT_TIMINGS.has(uniqueWhen[i])) {
      return undefined;
    }
  }

  const uniqueTimes = uniqueValues(input.timeOfDay ?? []);
  const occurrences = uniqueWhen.length + uniqueTimes.length;
  if (occurrences === 0) {
    return undefined;
  }
  return occurrences;
}

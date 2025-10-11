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
  [EventTiming.Breakfast]: "with morning meal",
  [EventTiming.Lunch]: "with lunch",
  [EventTiming.Dinner]: "with evening meal",
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

function describeWhen(internal: ParsedSigInternal): string | undefined {
  if (!internal.when.length) {
    return undefined;
  }
  const parts = internal.when
    .map((code) => WHEN_TEXT[code] ?? code)
    .filter(Boolean);
  if (!parts.length) {
    return undefined;
  }
  return parts.join(" and ");
}

function describeDayOfWeek(internal: ParsedSigInternal): string | undefined {
  if (!internal.dayOfWeek.length) {
    return undefined;
  }
  const days = internal.dayOfWeek.map((d) => DAY_NAMES[d] ?? d);
  if (days.length === 1) {
    return `on ${days[0]}`;
  }
  return `on ${days.join(" and ")}`;
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
  const parts: string[] = [];
  const dosePart = formatDoseLong(internal);
  if (dosePart) {
    parts.push(dosePart);
  }
  if (internal.routeText) {
    parts.push(internal.routeText);
  }
  const freqText = describeFrequency(internal);
  if (freqText) {
    parts.push(freqText);
  }
  const whenText = describeWhen(internal);
  if (whenText) {
    parts.push(whenText);
  }
  const dayText = describeDayOfWeek(internal);
  if (dayText) {
    parts.push(dayText);
  }
  if (internal.asNeeded) {
    parts.push(
      internal.asNeededReason
        ? `as needed for ${internal.asNeededReason}`
        : "as needed"
    );
  }
  if (internal.siteText) {
    parts.push(`at ${internal.siteText}`);
  }
  return parts.join(" ").trim();
}

function stripTrailingZero(value: number): string {
  const text = value.toString();
  if (text.includes(".")) {
    return text.replace(/\.0+$/, "").replace(/0+$/, "");
  }
  return text;
}

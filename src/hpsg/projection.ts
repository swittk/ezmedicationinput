import { stableStructureKey } from "../stable-structure";
import { ParserState, Token } from "../parser-state";
import { EventTiming, FhirDayOfWeek, FhirDosage, RouteCode, TextRange } from "../types";
import {
  HpsgClinicalAdjunctFeature,
  HpsgClinicalQuantityFeature,
  HpsgScheduleFeature,
  HpsgSign
} from "./signature";

const ALL_DAYS = [
  FhirDayOfWeek.Monday, FhirDayOfWeek.Tuesday, FhirDayOfWeek.Wednesday,
  FhirDayOfWeek.Thursday, FhirDayOfWeek.Friday, FhirDayOfWeek.Saturday,
  FhirDayOfWeek.Sunday
] as const;

export interface HpsgProjectionDeps {
  addDayOfWeekList: (state: ParserState, days: FhirDayOfWeek[]) => void;
  addWhen: (target: EventTiming[], whenCode: EventTiming) => void;
  markToken: (state: ParserState, token: Token) => void;
  recordEvidence: (state: ParserState, rule: string, startIndex: number, endIndex: number) => void;
  refreshMethodSurface: (state: ParserState) => void;
  setRoute: (state: ParserState, code: RouteCode, text?: string) => void;
}

function applySchedule(
  state: ParserState,
  schedule: HpsgScheduleFeature,
  deps: HpsgProjectionDeps
): void {
  if (schedule.timingCode !== undefined) {
    state.timingCode = schedule.timingCode;
  }
  if (schedule.count !== undefined) {
    state.count = schedule.count;
  }
  if (schedule.countMax !== undefined) {
    state.countMax = schedule.countMax;
  }
  if (schedule.duration !== undefined) {
    state.duration = schedule.duration;
  }
  if (schedule.durationMax !== undefined) {
    state.durationMax = schedule.durationMax;
  }
  if (schedule.durationUnit !== undefined) {
    state.durationUnit = schedule.durationUnit;
  }
  if (schedule.boundsStart !== undefined || schedule.boundsEnd !== undefined) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    if (schedule.boundsStart !== undefined) target.boundsStart = schedule.boundsStart;
    if (schedule.boundsEnd !== undefined) target.boundsEnd = schedule.boundsEnd;
  }
  if (schedule.frequency !== undefined) {
    state.frequency = schedule.frequency;
  }
  if (schedule.frequencyMax !== undefined) {
    state.frequencyMax = schedule.frequencyMax;
  }
  if (schedule.period !== undefined) {
    state.period = schedule.period;
  }
  if (schedule.periodMax !== undefined) {
    state.periodMax = schedule.periodMax;
  }
  if (schedule.periodUnit !== undefined) {
    state.periodUnit = schedule.periodUnit;
  }
  if (schedule.offset !== undefined) {
    state.offset = schedule.offset;
  }
  if (schedule.offsetMin !== undefined) {
    state.offsetMin = schedule.offsetMin;
  }
  if (schedule.offsetMax !== undefined) {
    state.offsetMax = schedule.offsetMax;
  }
  if (schedule.occurrenceCap !== undefined) {
    state.occurrenceCap = { ...schedule.occurrenceCap };
  }
  if (schedule.maxDosePerPeriod?.length) {
    state.maxDosePerPeriod = schedule.maxDosePerPeriod.map((maximum) => ({ ...maximum }));
  }
  if (schedule.activityTiming?.length) {
    const existing = state.activityTiming ? state.activityTiming.slice() : [];
    for (const item of schedule.activityTiming) {
      const key = stableStructureKey(item);
      if (!existing.some((candidate) => stableStructureKey(candidate) === key)) {
        existing.push(item);
      }
    }
    state.activityTiming = existing;
  }
  if (schedule.when) {
    for (const whenCode of schedule.when) {
      deps.addWhen(state.when, whenCode);
    }
  }
  if (schedule.dayOfWeek) {
    deps.addDayOfWeekList(state, schedule.dayOfWeek);
  }
  if (schedule.calendarEvents?.length) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    const existing = target.calendarEvents ? target.calendarEvents.slice() : [];
    for (const event of schedule.calendarEvents) {
      const key = stableStructureKey(event);
      if (!existing.some((candidate) => stableStructureKey(candidate) === key)) {
        existing.push(event);
      }
    }
    target.calendarEvents = existing;
  }
  if (schedule.timeOfDay?.length) {
    const existing = state.timeOfDay ? state.timeOfDay.slice() : [];
    for (const time of schedule.timeOfDay) {
      if (existing.indexOf(time) === -1) {
        existing.push(time);
      }
    }
    state.timeOfDay = existing;
  }
}

function findTokenByIndex(tokens: Token[], tokenIndex: number): Token | undefined {
  const direct = tokens[tokenIndex];
  if (direct && direct.index === tokenIndex) {
    return direct;
  }
  return tokens.find((candidate) => candidate.index === tokenIndex);
}

function appendScheduleEvidence(
  state: ParserState,
  evidence: HpsgSign["evidence"][number],
  tokens: Token[]
): void {
  if (evidence.rule !== "hpsg.lex.schedule.calendarDateList" || !evidence.tokenIndices.length) return;
  const owned = evidence.tokenIndices
    .map((tokenIndex) => findTokenByIndex(tokens, tokenIndex))
    .filter((token): token is Token => token !== undefined);
  if (!owned.length) return;
  const start = Math.min(...owned.map((token) => token.sourceStart));
  const end = Math.max(...owned.map((token) => token.sourceEnd));
  const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
  const scheduleEvidence = target.evidence ?? (target.evidence = []);
  if (scheduleEvidence.some((candidate) =>
    candidate.rule === evidence.rule &&
    candidate.spans.some((span) => span.start === start && span.end === end)
  )) return;
  scheduleEvidence.push({
    rule: evidence.rule,
    spans: [{ start, end, text: state.input.slice(start, end) }]
  });
}

function cloneClinicalQuantity(value: HpsgClinicalQuantityFeature): HpsgClinicalQuantityFeature {
  return {
    ...value,
    numerator: { ...value.numerator },
    denominators: value.denominators.map((term) => ({ ...term })),
    projectedDose: value.projectedDose ? { ...value.projectedDose } : undefined,
    administrationDuration: value.administrationDuration
      ? { ...value.administrationDuration }
      : undefined
  };
}

function hasRecurringSchedule(schedule: HpsgScheduleFeature | undefined): boolean {
  return Boolean(schedule && (
    schedule.frequency !== undefined ||
    schedule.frequencyMax !== undefined ||
    schedule.period !== undefined ||
    schedule.periodMax !== undefined ||
    schedule.dayOfWeek?.length ||
    schedule.when?.length ||
    schedule.timeOfDay?.length
  ));
}

function appendRange(target: TextRange[], value: TextRange): void {
  if (!target.some((candidate) =>
    candidate.start === value.start && candidate.end === value.end
  )) target.push({ ...value });
}

function applyClinicalAdjunct(
  state: ParserState,
  adjunct: HpsgClinicalAdjunctFeature
): TextRange[] {
  const clause = state.primaryClause;
  const clinical = clause.clinicalAdjuncts ?? {};
  const acceptedRules = new Set<string>();
  // An elliptical regimen phase can contain only a cadence at this stage.
  // The typed sequence will inherit its dose/site from the predecessor, so a
  // local guard attached to that cadence is still a clinical adjunct.
  const hasAdministration = Boolean(
    clause.dose || clause.method || clause.route || clause.site ||
    hasRecurringSchedule(clause.schedule)
  );
  if (adjunct.condition && hasAdministration) {
    clinical.condition = adjunct.condition;
    acceptedRules.add("hpsg.lex.clinical.condition");
  }

  const schedule = clause.schedule;
  const hasCadence = Boolean(schedule && (
    schedule.frequency !== undefined ||
    schedule.period !== undefined ||
    schedule.when?.length ||
    schedule.timeOfDay?.length
  ));
  if (schedule && hasCadence &&
      (adjunct.excludedWeekdays?.length || adjunct.excludedDates?.length)) {
    if (adjunct.excludedWeekdays?.length) {
      const excluded = new Set(adjunct.excludedWeekdays);
      const allowed = (adjunct.includedWeekdays?.length
        ? adjunct.includedWeekdays : [...ALL_DAYS]).filter((day) => !excluded.has(day));
      if (allowed.length) {
        schedule.dayOfWeek = allowed;
        clinical.excludedWeekdays = [...adjunct.excludedWeekdays];
      }
    }
    if (adjunct.excludedDates?.length) {
      clinical.excludedDates = [...adjunct.excludedDates];
      schedule.calendarEvents = schedule.calendarEvents?.filter((event) =>
        adjunct.excludedDates!.indexOf(event.isoDate) < 0
      );
      if (!schedule.calendarEvents?.length) delete schedule.calendarEvents;
    }
    acceptedRules.add("hpsg.lex.clinical.calendar-exclusion");
  }
  if (adjunct.unresolved && hasAdministration) {
    acceptedRules.add("hpsg.lex.clinical.calendar-exclusion.unresolved");
  }

  const localRanges = clinical.localRanges ?? [];
  const evidence = clinical.evidence ?? [];
  const rejectedRanges: TextRange[] = [];
  for (const item of adjunct.evidence) {
    if (!acceptedRules.has(item.rule)) {
      for (const range of item.ranges) appendRange(rejectedRanges, range);
      continue;
    }
    const spans = item.ranges.map((range) => ({
      ...range,
      text: state.input.slice(range.start, range.end)
    }));
    if (!evidence.some((candidate) =>
      candidate.rule === item.rule &&
      stableStructureKey(candidate.spans) === stableStructureKey(spans)
    )) evidence.push({ rule: item.rule, spans });
    for (const range of item.ranges) appendRange(localRanges, range);
    if (item.rule === "hpsg.lex.clinical.calendar-exclusion.unresolved") {
      // Provenance is accepted, but unresolved words remain editable/lintable.
      for (const range of item.ranges) appendRange(rejectedRanges, range);
    }
  }
  if (acceptedRules.size) {
    clinical.localRanges = localRanges;
    clinical.evidence = evidence;
    clause.clinicalAdjuncts = clinical;
  }
  return rejectedRanges;
}

export function projectHpsgSignToState(
  sign: HpsgSign,
  state: ParserState,
  tokens: Token[],
  deps: HpsgProjectionDeps
): void {
  const method = sign.synsem.head.method;
  if (method && method.headClass !== "procedure") {
    state.methodVerb = method.verb;
    if (method.text !== undefined) {
      state.methodText = method.text;
    } else {
      deps.refreshMethodSurface(state);
    }
    if (method.textElement !== undefined) {
      state.methodTextElement = method.textElement;
    }
    if (method.coding !== undefined) {
      state.methodCoding = method.coding;
    }
  }

  const route = sign.synsem.head.route;
  if (route && route.attachmentClass !== "procedure") {
    deps.setRoute(state, route.code, route.text);
  }

  const site = sign.synsem.valence.site;
  if (site && site.attachmentClass !== "procedure") {
    if (site.text !== undefined) {
      state.siteText = site.text;
    }
    if (site.i18n !== undefined) {
      state.siteI18n = site.i18n;
    }
    if (site.source !== undefined) {
      state.siteSource = site.source;
    }
    if (site.coding !== undefined) {
      state.siteCoding = site.coding;
    }
    if (site.spatialRelation !== undefined) {
      state.siteSpatialRelation = site.spatialRelation;
    }
    if (site.lookupRequest !== undefined) {
      state.siteLookupRequest = site.lookupRequest;
    }
    if (site.administrationTargetCount !== undefined) {
      state.siteAdministrationTargetCount = site.administrationTargetCount;
    }
    if (site.range !== undefined) {
      state.primaryClause.site = {
        ...state.primaryClause.site,
        range: { ...site.range }
      };
    }
    if (site.coordination) {
      state.administrationTargetGroup = {
        coordination: site.coordination.coordination,
        sourceText: site.coordination.sourceText,
        range: { ...site.coordination.range },
        targets: site.coordination.targets.map((target) => ({
          text: target.text,
          i18n: target.i18n ? { ...target.i18n } : undefined,
          source: target.source,
          coding: target.coding?.code ? {
            code: target.coding.code,
            system: target.coding.system,
            display: target.coding.display,
            i18n: target.coding.i18n ? { ...target.coding.i18n } : undefined
          } : undefined,
          spatialRelation: target.spatialRelation ? { ...target.spatialRelation } : undefined,
          administrationTargetCount: target.administrationTargetCount,
          range: target.range ? { ...target.range } : undefined
        }))
      };
    }
  }

  const prn = sign.synsem.valence.prn;
  if (prn) {
    state.asNeeded = true;
    if (prn.reasonText !== undefined) {
      state.asNeededReason = prn.reasonText;
    }
    if (prn.triggerPhase !== undefined) {
      state.asNeededReasonTriggerPhase = prn.triggerPhase;
    }
    if (prn.reasons?.length) {
      state.asNeededReasons = prn.reasons.map((reason) => ({
        text: reason.text,
        triggerPhase: reason.triggerPhase
      }));
    }
    if (prn.lookupRequests?.length) {
      state.prnReasonLookupRequests = prn.lookupRequests.slice();
    }
    if (prn.lookupRequest !== undefined) {
      state.prnReasonLookupRequest = prn.lookupRequest;
    }
  }

  const instructions = sign.synsem.valence.instructions;
  if (instructions?.length) {
    const existing = state.additionalInstructions.slice();
    for (const instruction of instructions) {
      if (
        !existing.some((candidate) =>
          candidate.text === instruction.text &&
          candidate.coding?.code === instruction.coding?.code
        )
      ) {
        existing.push({
          text: instruction.text,
          i18n: instruction.i18n ? { ...instruction.i18n } : undefined,
          coding: instruction.coding,
          frames: instruction.frames
        });
      }
    }
    state.additionalInstructions = existing;
  }

  const patientInstruction = sign.synsem.valence.patientInstruction;
  if (patientInstruction?.text) {
    state.patientInstruction = state.patientInstruction
      ? `${state.patientInstruction}; ${patientInstruction.text}`
      : patientInstruction.text;
  }

  const dose = sign.synsem.head.dose;
  if (dose && dose.attachmentClass !== "procedure") {
    const clinical = dose.clinicalQuantity;
    if (clinical) {
      state.primaryClause.clinicalQuantity = cloneClinicalQuantity(clinical);
      if (clinical.status === "resolved" && clinical.projectedDose) {
        state.dose = clinical.projectedDose.value;
        state.unit = clinical.projectedDose.unit;
      } else {
        // A rate or unresolved expression is not a scalar medication dose.
        delete state.primaryClause.dose;
      }
    } else {
      if (dose.value !== undefined) {
        state.dose = dose.value;
      }
      if (dose.range !== undefined) {
        state.doseRange = dose.range;
      }
      if (dose.unit !== undefined) {
        state.unit = dose.unit;
      }
    }
  }

  const schedule = sign.synsem.head.schedule;
  if (schedule && schedule.attachmentClass !== "procedure") {
    applySchedule(state, schedule, deps);
  }

  const clinicalDuration = dose?.attachmentClass !== "procedure"
    ? dose?.clinicalQuantity?.administrationDuration
    : undefined;
  if (clinicalDuration) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    target.administrationDuration = clinicalDuration.value;
    target.administrationDurationUnit = clinicalDuration.unit;
    // Duration qualifies each infusion. It is never regimen boundsDuration;
    // a single-occurrence count is only appropriate without a recurrence.
    delete target.duration;
    delete target.durationMax;
    delete target.durationUnit;
    if (!hasRecurringSchedule(schedule) && target.count === undefined) target.count = 1;
  }

  const rejectedClinicalRanges = sign.synsem.cont.clinicalAdjunct
    ? applyClinicalAdjunct(state, sign.synsem.cont.clinicalAdjunct)
    : [];

  if (sign.warnings?.length) {
    for (const warning of sign.warnings) {
      if (state.warnings.indexOf(warning) === -1) {
        state.warnings.push(warning);
      }
    }
  }

  if (sign.siteTokenIndices?.length) {
    for (const tokenIndex of sign.siteTokenIndices) {
      state.siteTokenIndices.add(tokenIndex);
    }
  }

  for (const tokenIndex of sign.consumedTokenIndices) {
    const token = findTokenByIndex(tokens, tokenIndex);
    const rejectedClinicalToken = token && rejectedClinicalRanges.some((range) =>
      token.sourceStart < range.end && range.start < token.sourceEnd
    );
    if (token && !rejectedClinicalToken) {
      deps.markToken(state, token);
    }
  }

  for (const evidence of sign.evidence) {
    if (!evidence.tokenIndices.length) {
      continue;
    }
    if (schedule?.attachmentClass !== "procedure") appendScheduleEvidence(state, evidence, tokens);
    const startIndex = Math.min(...evidence.tokenIndices);
    const endIndex = Math.max(...evidence.tokenIndices);
    deps.recordEvidence(state, evidence.rule, startIndex, endIndex);
  }
}

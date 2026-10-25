import { equalStructuredValues } from "../stable-structure";
import { ParserState, Token } from "../parser-state";
import {
  EventTiming,
  FhirDayOfWeek,
  FhirDosage,
  RouteCode,
  TextRange,
  type CanonicalAdministrationTargetGroup,
  type CanonicalAdditionalInstructionExpr,
  type CanonicalSigClause,
  type CanonicalSiteExpr,
  type CanonicalEvidence,
  type CanonicalLexicalCategory,
  type CanonicalScheduleSemanticField
} from "../types";
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
  recordEvidence: (
    state: ParserState,
    rule: string,
    startIndex: number,
    endIndex: number,
    scheduleFields?: CanonicalScheduleSemanticField[],
    lexicalCategory?: CanonicalLexicalCategory
  ) => void;
  refreshMethodSurface: (state: ParserState) => void;
  setRoute: (state: ParserState, code: RouteCode, text?: string) => void;
}

/**
 * Locate an instruction by its typed lexical evidence or procedural frames.
 * @param instruction The source-backed instruction whose relative order is needed.
 */
function instructionSourceStart(instruction: CanonicalAdditionalInstructionExpr): number | undefined {
  let start: number | undefined;
  for (const evidence of instruction.evidence ?? []) {
    for (const span of evidence.spans) {
      if (start === undefined || span.start < start) start = span.start;
    }
  }
  for (const frame of instruction.frames ?? []) {
    if (start === undefined || frame.span.start < start) start = frame.span.start;
  }
  return start;
}

function applySchedule(
  state: ParserState,
  schedule: HpsgScheduleFeature,
  deps: HpsgProjectionDeps
): void {
  if (schedule.cycleDayConstraint) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    target.cycleDayConstraint = { ...schedule.cycleDayConstraint, days: [...schedule.cycleDayConstraint.days] };
  }
  if (schedule.dayOfMonth?.length) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    target.dayOfMonth = [...schedule.dayOfMonth];
  }
  if (schedule.timingCode !== undefined) {
    state.timingCode = schedule.timingCode;
  }
  if (schedule.treatmentStartOffsetDays !== undefined) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    target.treatmentStartOffsetDays = schedule.treatmentStartOffsetDays;
  }
  if (schedule.timingReference !== undefined) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    target.timingReference = schedule.timingReference;
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
  if (schedule.administrationOffsetMinutes !== undefined) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    target.administrationOffsetMinutes = schedule.administrationOffsetMinutes;
  }
  if (schedule.boundsStart !== undefined || schedule.boundsEnd !== undefined) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    if (schedule.boundsStart !== undefined) target.boundsStart = schedule.boundsStart;
    if (schedule.boundsEnd !== undefined) target.boundsEnd = schedule.boundsEnd;
  }
  if (schedule.repeatCycle !== undefined) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    target.repeatCycle = { ...schedule.repeatCycle };
    if (schedule.repeatCount !== undefined) target.repeatCount = schedule.repeatCount;
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
  if (schedule.clockWindow) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    target.clockWindow = { ...schedule.clockWindow };
  }
  if (schedule.weekdayOrdinal !== undefined) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    target.weekdayOrdinal = schedule.weekdayOrdinal;
  }
  if (schedule.eventWindow) {
    const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
    target.eventWindow = { ...schedule.eventWindow };
  }
  if (schedule.activityTiming?.length) {
    const existing = state.activityTiming ? state.activityTiming.slice() : [];
    for (const item of schedule.activityTiming) {
      if (!existing.some((candidate) => equalStructuredValues(candidate, item))) {
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
      if (!existing.some((candidate) => equalStructuredValues(candidate, event))) {
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
  tokens: Token[],
  schedule: HpsgScheduleFeature | undefined
): void {
  // Typed lexical schedule ownership, never dispatch by a rule name.
  if (!evidence.tokenIndices.length ||
      (!evidence.scheduleFields?.length && !schedule?.sourceRanges?.length)) return;
  const owned = evidence.tokenIndices
    .map((tokenIndex) => findTokenByIndex(tokens, tokenIndex))
    .filter((token): token is Token => token !== undefined);
  if (!owned.length) return;
  const start = Math.min(...owned.map((token) => token.sourceStart));
  const end = Math.max(...owned.map((token) => token.sourceEnd));
  if (!evidence.scheduleFields?.length && !schedule?.sourceRanges?.some(range =>
    range.start <= start && end <= range.end
  )) return;
  const target = state.primaryClause.schedule ?? (state.primaryClause.schedule = {});
  const scheduleEvidence = target.evidence ?? (target.evidence = []);
  if (scheduleEvidence.some((candidate) =>
    candidate.rule === evidence.rule &&
    candidate.spans.some((span) => span.start === start && span.end === end)
  )) return;
  const canonicalEvidence: CanonicalEvidence = {
    rule: evidence.rule,
    spans: [{ start, end, text: state.input.slice(start, end) }]
  };
  if (evidence.scheduleFields?.length) {
    canonicalEvidence.scheduleFields = [...evidence.scheduleFields];
  }
  scheduleEvidence.push(canonicalEvidence);
}

function cloneClinicalQuantity(value: HpsgClinicalQuantityFeature): HpsgClinicalQuantityFeature {
  return {
    ...value,
    numerator: { ...value.numerator },
    denominators: value.denominators.map((term) => ({ ...term })),
    projectedDose: value.projectedDose ? { ...value.projectedDose } : undefined,
    ...(value.carrierMaterial ? { carrierMaterial: {
      text: value.carrierMaterial.text,
      range: value.carrierMaterial.range ? { ...value.carrierMaterial.range } : undefined
    } } : {}),
    administrationDuration: value.administrationDuration
      ? { ...value.administrationDuration }
      : undefined
  };
}

function cloneSiteRestrictions(
  restrictions: NonNullable<HpsgSign["synsem"]["valence"]["site"]>["restrictions"]
) {
  return restrictions?.map((restriction) => ({
    ...restriction,
    range: restriction.range ? { ...restriction.range } : undefined,
    markerRange: restriction.markerRange ? { ...restriction.markerRange } : undefined,
    predicate: {
      ...restriction.predicate,
      range: restriction.predicate.range ? { ...restriction.predicate.range } : undefined
    }
  }));
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
  const acceptedKinds = new Set<HpsgClinicalAdjunctFeature['evidence'][number]['kind']>();
  // An elliptical regimen phase can contain only a cadence at this stage.
  // The typed sequence will inherit its dose/site from the predecessor, so a
  // local guard attached to that cadence is still a clinical adjunct.
  const hasAdministration = Boolean(
    clause.dose || clause.method || clause.route || clause.site ||
    hasRecurringSchedule(clause.schedule)
  );
  if (hasAdministration && adjunct.conditionTarget) clinical.conditionTarget = {
    ...adjunct.conditionTarget,
    when: adjunct.conditionTarget.when ? [...adjunct.conditionTarget.when] : undefined,
    timeOfDay: adjunct.conditionTarget.timeOfDay ? [...adjunct.conditionTarget.timeOfDay] : undefined,
    clockRange: adjunct.conditionTarget.clockRange ? { ...adjunct.conditionTarget.clockRange } : undefined
  };
  if (adjunct.treatmentPause && hasAdministration) {
    clinical.treatmentPause = { ...adjunct.treatmentPause, range: { ...adjunct.treatmentPause.range } };
    acceptedKinds.add("treatment-pause");
  }
  if (adjunct.condition && hasAdministration) {
    clinical.condition = adjunct.condition;
    if (adjunct.calendarDayCondition) clinical.calendarDayCondition = adjunct.calendarDayCondition;
    acceptedKinds.add("condition");
  }

  const schedule = clause.schedule;
  const hasCadence = Boolean(schedule && (
    schedule.occurrenceCap !== undefined ||
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
      // The exclusion is clinical meaning even if NO weekday is eligible.
      // An empty allowed set is a contradictory/non-executable course, not
      // permission to drop the exclusion and schedule the medication daily.
      // Retain the full FHIR exclusion extension for review and editing.
      clinical.excludedWeekdays = [...adjunct.excludedWeekdays];
      // Selected-dose exclusions are scoped after partitioning source anchors.
      if (allowed.length && !adjunct.conditionTarget) schedule.dayOfWeek = allowed;
    }
    if (adjunct.excludedDates?.length) {
      clinical.excludedDates = [...adjunct.excludedDates];
      schedule.calendarEvents = schedule.calendarEvents?.filter((event) =>
        adjunct.excludedDates!.indexOf(event.isoDate) < 0
      );
      if (!schedule.calendarEvents?.length) delete schedule.calendarEvents;
    }
    acceptedKinds.add("calendar-exclusion");
  }
  if (adjunct.unresolved && hasAdministration) {
    acceptedKinds.add("unresolved");
  }

  const localRanges = clinical.localRanges ?? [];
  const evidence = clinical.evidence ?? [];
  const rejectedRanges: TextRange[] = [];
  for (const item of adjunct.evidence) {
    if (!acceptedKinds.has(item.kind)) {
      for (const range of item.ranges) appendRange(rejectedRanges, range);
      continue;
    }
    const spans = item.ranges.map((range) => ({
      ...range,
      text: state.input.slice(range.start, range.end)
    }));
    if (!evidence.some((candidate) =>
      candidate.rule === item.rule &&
      equalStructuredValues(candidate.spans, spans)
    )) evidence.push({ rule: item.rule, spans });
    for (const range of item.ranges) appendRange(localRanges, range);
    if (item.kind === "unresolved") {
      // Provenance is accepted, but unresolved words remain editable/lintable.
      for (const range of item.ranges) appendRange(rejectedRanges, range);
    }
  }
  if (acceptedKinds.size) {
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
  if (sign.synsem.cont.regimenAdjustment) {
    state.primaryClause.regimenAdjustment = sign.synsem.cont.regimenAdjustment;
  }
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
    if (site.restrictions?.length) {
      state.primaryClause.site = {
        ...state.primaryClause.site,
        restrictions: cloneSiteRestrictions(site.restrictions)
      };
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
          ...(target.restrictions?.length
            ? { restrictions: cloneSiteRestrictions(target.restrictions) } : {}),
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
        const projected: CanonicalAdditionalInstructionExpr = {
          text: instruction.text,
          i18n: instruction.i18n ? { ...instruction.i18n } : undefined,
          coding: instruction.coding,
          frames: instruction.frames,
          evidence: instruction.evidence
        };
        const sourceStart = instructionSourceStart(projected);
        const following = sourceStart === undefined ? -1 : existing.findIndex((candidate) => {
          const candidateStart = instructionSourceStart(candidate);
          return candidateStart !== undefined && candidateStart > sourceStart;
        });
        if (following === -1) existing.push(projected);
        else existing.splice(following, 0, projected);
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

  for (const scoped of sign.synsem.cont.scopedAdministrations ?? []) {
    const condition = scoped.condition;
    const scopes = state.primaryClause.instructionScopes ?? (state.primaryClause.instructionScopes = []);
    if (!scopes.some(scope => scope.kind === condition.relation &&
        scope.span.start === condition.sourceStart && scope.span.end === condition.sourceEnd &&
        scope.target.start === condition.targetStart && scope.target.end === condition.targetEnd)) {
      scopes.push({
        kind: condition.relation,
        span: { start: condition.sourceStart, end: condition.sourceEnd },
        target: { start: condition.targetStart, end: condition.targetEnd }
      });
    }
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
    // Keep a separately owned course duration (for example, daily for three
    // days). Only the overlapping timing artifact without typed schedule-field
    // ownership belongs to the clinical quantity's elapsed-time daughter.
    const hasCourseDurationEvidence = sign.evidence.some(item =>
      item.scheduleFields?.some(field =>
        field === "duration" || field === "durationMax" || field === "durationUnit"
      )
    );
    if (!hasCourseDurationEvidence) {
      delete target.duration;
      delete target.durationMax;
      delete target.durationUnit;
    }
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
    if (schedule?.attachmentClass !== "procedure") appendScheduleEvidence(state, evidence, tokens, schedule);
    const startIndex = Math.min(...evidence.tokenIndices);
    const endIndex = Math.max(...evidence.tokenIndices);
    deps.recordEvidence(
      state,
      evidence.rule,
      startIndex,
      endIndex,
      evidence.scheduleFields,
      evidence.lexicalCategory
    );
  }
}

function cloneAdministrationTarget(site: CanonicalSiteExpr): CanonicalSiteExpr {
  return {
    ...site,
    i18n: site.i18n ? { ...site.i18n } : undefined,
    coding: site.coding ? {
      ...site.coding,
      i18n: site.coding.i18n ? { ...site.coding.i18n } : undefined
    } : undefined,
    spatialRelation: site.spatialRelation ? { ...site.spatialRelation } : undefined,
    ...(site.restrictions?.length ? {
      restrictions: site.restrictions.map(restriction => ({
        ...restriction,
        range: restriction.range ? { ...restriction.range } : undefined,
        markerRange: restriction.markerRange ? { ...restriction.markerRange } : undefined,
        predicate: {
          ...restriction.predicate,
          range: restriction.predicate.range ? { ...restriction.predicate.range } : undefined
        }
      }))
    } : {}),
    evidence: site.evidence?.map((item) => ({
      ...item,
      spans: item.spans.map((span) => ({ ...span }))
    })),
    range: site.range ? { ...site.range } : undefined
  };
}

function cloneAdministrationTargetGroup(
  group: CanonicalAdministrationTargetGroup
): CanonicalAdministrationTargetGroup {
  return {
    coordination: group.coordination,
    sourceText: group.sourceText,
    range: group.range ? { ...group.range } : undefined,
    targets: group.targets.map(cloneAdministrationTarget)
  };
}

/**
 * Return the FHIR projection alternatives licensed by the typed HPSG site
 * coordination. A disjunction is deliberately one retained canonical clause;
 * it is never converted into simultaneous administrations.
 */
export function administrationTargetProjections(
  clauses: readonly CanonicalSigClause[]
): Array<CanonicalSiteExpr | undefined> {
  const group = clauses.find((clause) => clause.administrationTargetGroup)
    ?.administrationTargetGroup;
  if (!group || group.coordination !== "conjunction" || group.targets.length < 2) {
    return [undefined];
  }
  return group.targets.map(cloneAdministrationTarget);
}

/** Pure pre-FHIR projection from one typed conjunction to one singular site. */
export function projectAdministrationTargetClauses(
  clauses: readonly CanonicalSigClause[],
  target: CanonicalSiteExpr | undefined
): CanonicalSigClause[] {
  if (!target) return clauses.slice();
  return clauses.map((clause) => {
    const group = clause.administrationTargetGroup;
    if (!group || group.coordination !== "conjunction") return clause;
    return {
      ...clause,
      site: cloneAdministrationTarget(target),
      administrationTargetGroup: cloneAdministrationTargetGroup(group)
    };
  });
}

import { ParserState, Token } from "../parser-state";
import { EventTiming, FhirDayOfWeek, RouteCode } from "../types";
import { HpsgScheduleFeature, HpsgSign } from "./signature";

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
  if (schedule.duration !== undefined) {
    state.duration = schedule.duration;
  }
  if (schedule.durationMax !== undefined) {
    state.durationMax = schedule.durationMax;
  }
  if (schedule.durationUnit !== undefined) {
    state.durationUnit = schedule.durationUnit;
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
  if (schedule.when) {
    for (const whenCode of schedule.when) {
      deps.addWhen(state.when, whenCode);
    }
  }
  if (schedule.dayOfWeek) {
    deps.addDayOfWeekList(state, schedule.dayOfWeek);
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

export function projectHpsgSignToState(
  sign: HpsgSign,
  state: ParserState,
  tokens: Token[],
  deps: HpsgProjectionDeps
): void {
  const method = sign.synsem.head.method;
  if (method) {
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
  if (route) {
    deps.setRoute(state, route.code, route.text);
  }

  const site = sign.synsem.valence.site;
  if (site) {
    if (site.text !== undefined) {
      state.siteText = site.text;
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
  }

  const prn = sign.synsem.valence.prn;
  if (prn) {
    state.asNeeded = true;
    if (prn.reasonText !== undefined) {
      state.asNeededReason = prn.reasonText;
    }
    if (prn.reasons?.length) {
      state.asNeededReasons = prn.reasons.map((reason) => ({
        text: reason.text
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
  if (dose) {
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

  const schedule = sign.synsem.head.schedule;
  if (schedule) {
    applySchedule(state, schedule, deps);
  }

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
    if (token) {
      deps.markToken(state, token);
    }
  }

  for (const evidence of sign.evidence) {
    if (!evidence.tokenIndices.length) {
      continue;
    }
    const startIndex = Math.min(...evidence.tokenIndices);
    const endIndex = Math.max(...evidence.tokenIndices);
    deps.recordEvidence(state, evidence.rule, startIndex, endIndex);
  }
}

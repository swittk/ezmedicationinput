import { EVENT_TIMING_TOKENS } from "../../maps";
import { parseAdditionalInstructions, realizeAdviceFramesText } from "../../advice";
import { resolveBodySitePhrase } from "../../body-site-grammar";
import { medicationInstructionActionIsSafetyScopeTarget, resolveMedicationInstructionAction } from "../../instruction-action-terminology";
import { medicationInstructionConceptCodings, resolveMedicationInstructionConcept } from "../../instruction-concept-terminology";
import {
  getAdviceRelationRealizations,
  resolveActionRelationSurface
} from "../../relation-terminology";
import { composeLocalizedRecords } from "../../localization";
import { joinLocalizedTokens } from "../../locale-realization";
import { getProceduralFrames, sourceRangeAttachmentClass } from "../procedural-context";
import { LexKind } from "../../lexer/token-types";
import { getRouteMeaning } from "../../lexer/meaning";
import { lexInput } from "../../lexer/lex";
import { Token } from "../../parser-state";
import { normalizeUnit } from "../../unit-lexicon";
import {
  AdviceArgumentRole,
  AdviceForce,
  AdviceFrame,
  AdvicePolarity,
  AdviceRelation,
  CanonicalAdditionalInstructionExpr
} from "../../types";
import { mapIntervalUnit } from "../timing-lexicon";
import {
  ACTION_COORDINATION_CONNECTORS,
  ACTION_COORDINATION_CONNECTOR_I18N,
  ACTION_SEQUENCE_MARKERS,
  ADMINISTRATION_WINDOW_INSTRUCTIONS,
  BODY_SITE_ATTRIBUTIVE_MODIFIERS,
  EVENT_ARTICLE_TOKENS,
  EVENT_PREPOSITIONS,
  FREE_TEXT_DIRECTIVE_STARTS,
  CONDITIONAL_INSTRUCTION_EXCLUSIVE_LEADS,
  INSTRUCTION_LEADING_SEPARATORS,
  INSTRUCTION_START_WORDS,
  LIST_SEPARATORS,
  MEAL_RELATION_BY_TOKEN,
  SITE_ANCHORS,
  SITE_TRAILING_INSTRUCTION_WORDS,
  WORKFLOW_ACTION_RELATION_LEADS,
  WORKFLOW_CONTINUATION_LICENSES,
  WORKFLOW_NOUNS,
  WORKFLOW_START_WORDS
} from "../lexical-classes";
import { isMedicationAdministrationMethod } from "../method-lexicon";
import {
  HpsgClauseContext,
  joinTokenText,
  lexicalRule,
  normalizeTokenLower,
  rangeFromTokens,
  tokensAvailable
} from "../rule-context";
import { HpsgLexicalRule, lexicalSign } from "../signature";
import { isScheduleLead } from "./timing-rules";

const INSTRUCTION_PREDICATES = ["take", "apply", "use"] as const;
const ADMINISTRATION_WINDOWS_BY_FIRST = new Map<string, typeof ADMINISTRATION_WINDOW_INSTRUCTIONS>();
for (const definition of ADMINISTRATION_WINDOW_INSTRUCTIONS) {
  const first = definition.parts[0];
  if (!first) continue;
  const existing = ADMINISTRATION_WINDOWS_BY_FIRST.get(first) ?? [];
  existing.push(definition);
  ADMINISTRATION_WINDOWS_BY_FIRST.set(first, existing);
}


function startsEventTimingPhrase(context: HpsgClauseContext, index: number): boolean {
  const lead = context.tokens[index];
  if (!lead || !EVENT_PREPOSITIONS.has(normalizeTokenLower(lead))) return false;
  const second = context.tokens[index + 1];
  const secondLower = second ? normalizeTokenLower(second) : "";
  if (EVENT_TIMING_TOKENS[secondLower]) return true;
  if (!EVENT_ARTICLE_TOKENS.has(secondLower)) return false;
  const third = context.tokens[index + 2];
  return Boolean(third && EVENT_TIMING_TOKENS[normalizeTokenLower(third)]);
}

function isExplicitDoseLead(context: HpsgClauseContext, index: number): boolean {
  const token = context.tokens.slice(index, index + 1)[0];
  const unitToken = context.tokens[index + 1];
  if (
    !token ||
    !unitToken ||
    context.state.consumed.has(token.index) ||
    context.state.consumed.has(unitToken.index)
  ) {
    return false;
  }
  if (token.kind !== LexKind.Number && token.kind !== LexKind.NumberRange) {
    return false;
  }
  return Boolean(normalizeUnit(normalizeTokenLower(unitToken), context.options));
}

function startsScheduledAdministration(context: HpsgClauseContext, index: number): boolean {
  const token = context.tokens.slice(index, index + 1)[0];
  if (!token || context.state.consumed.has(token.index)) {
    return false;
  }
  return Boolean(
    isMedicationAdministrationMethod(normalizeTokenLower(token), context.options) &&
    isScheduleLead(context, index + 1)
  );
}

function containsCoordinationSurface(text: string): boolean {
  return lexInput(text).some((token) =>
    ACTION_COORDINATION_CONNECTORS.has(token.canonical ?? token.lower)
  );
}

function proceduralFrames(context: HpsgClauseContext): AdviceFrame[] {
  return getProceduralFrames(context).filter((frame) => {
    const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
    const scopedDirective = frame.polarity === AdvicePolarity.Negate ||
      medicationInstructionActionIsSafetyScopeTarget(frame.predicate.lemma, context.options);
    if (
      (!definition?.procedural && !scopedDirective) ||
      (definition?.primaryAdministrationHead && !scopedDirective) ||
      (WORKFLOW_START_WORDS.has(frame.predicate.lemma) && !scopedDirective)
    ) {
      return false;
    }
    return !frame.args.some((arg) =>
      !arg.conceptId &&
      !arg.coding?.code &&
      !arg.quantity &&
      containsCoordinationSurface(arg.text)
    );
  });
}

function frameTokens(context: HpsgClauseContext, frame: AdviceFrame): Token[] {
  return context.tokens.filter((token) =>
    token.sourceStart >= frame.span.start && token.sourceEnd <= frame.span.end
  );
}

function frameDose(
  context: HpsgClauseContext,
  frame: AdviceFrame
): { value?: number; range?: { low?: number; high?: number }; unit?: string } | undefined {
  const definition = resolveMedicationInstructionAction(frame.predicate.lemma, context.options);
  if (!definition?.definesDose) return undefined;
  const amount = frame.args.find((arg) => arg.role === AdviceArgumentRole.Amount && arg.quantity);
  if (!amount?.quantity) return undefined;
  return {
    value: amount.quantity.value,
    range: amount.quantity.range ? { ...amount.quantity.range } : undefined,
    unit: amount.quantity.unit
  };
}

export function proceduralActionLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.patientInstruction.procedure", (context, start) => {
    const startToken = context.tokens[start];
    if (!startToken || context.state.consumed.has(startToken.index)) return [];
    const signs = [];
    for (const frame of proceduralFrames(context)) {
      if (frame.span.start !== startToken.sourceStart) continue;
      const tokens = frameTokens(context, frame);
      if (!tokens.length || tokens.some((token) => context.state.consumed.has(token.index))) continue;
      const text = context.state.input.slice(frame.span.start, frame.span.end).trim();
      if (!text) continue;
      const directiveInstructions = frame.polarity === AdvicePolarity.Negate
        ? parseInstructionCandidates(text, frame.span)
        : [];
      signs.push(
        lexicalSign({
          type: "instruction-sign",
          rule: "hpsg.lex.patientInstruction.procedure",
          tokens,
          synsem: {
            head: { dose: frameDose(context, frame) },
            valence: frame.polarity === AdvicePolarity.Negate
              ? { instructions: directiveInstructions.length ? directiveInstructions : [{ text, frames: [frame] }] }
              : { patientInstruction: { text } },
            cont: { clauseKind: "administration" }
          },
          score: 18 + tokens.length + frame.args.length * 2
        })
      );
    }
    return signs;
  });
}

function workflowStartIsAnchoredSiteModifier(
  context: HpsgClauseContext,
  start: number
): boolean {
  const startToken = context.tokens[start];
  if (!startToken || !BODY_SITE_ATTRIBUTIVE_MODIFIERS.has(normalizeTokenLower(startToken))) return false;
  let modifierStart = start;
  while (modifierStart > 0) {
    const previousModifier = context.tokens[modifierStart - 1];
    if (!previousModifier || !BODY_SITE_ATTRIBUTIVE_MODIFIERS.has(normalizeTokenLower(previousModifier))) break;
    modifierStart -= 1;
  }
  const anchor = context.tokens[modifierStart - 1];
  if (!anchor || !SITE_ANCHORS.has(normalizeTokenLower(anchor))) return false;
  const parts: string[] = [];
  const maxEnd = Math.min(context.limit, start + 5);
  for (let index = modifierStart; index < maxEnd; index += 1) {
    const token = context.tokens[index];
    if (!token || context.state.consumed.has(token.index)) break;
    const lower = normalizeTokenLower(token);
    if (index > start && (isScheduleLead(context, index) || LIST_SEPARATORS.has(lower))) break;
    parts.push(token.original);
    const resolved = resolveBodySitePhrase(parts.join(" "), context.options?.siteCodeMap, {
      bodySiteContext: context.options?.context?.bodySiteContext,
      allowTerminalModifierInheritance: true
    });
    if (resolved?.coding || resolved?.definition) return true;
  }
  return false;
}

function semanticActivityWindowStartsAt(context: HpsgClauseContext, start: number): boolean {
  return ADMINISTRATION_WINDOW_INSTRUCTIONS.some((definition) => {
    if (definition.offsetOnly || !definition.relation || !definition.activity) return false;
    const tokens = tokensAvailable(context, start, definition.parts.length);
    return Boolean(tokens && tokens.every(
      (token, index) => normalizeTokenLower(token) === definition.parts[index]
    ));
  });
}

export function workflowLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.patientInstruction.workflow", (context, start) => {
    let cursor = start;
    const consumed: Token[] = [];
    while (cursor < context.limit) {
      const token = context.tokens[cursor];
      const lower = token ? normalizeTokenLower(token) : "";
      if (!token || context.state.consumed.has(token.index) || !LIST_SEPARATORS.has(lower)) {
        break;
      }
      consumed.push(token);
      cursor += 1;
    }

    const first = context.tokens[cursor];
    if (!first || context.state.consumed.has(first.index)) {
      return [];
    }
    const firstLower = normalizeTokenLower(first);
    if (semanticActivityWindowStartsAt(context, cursor)) return [];
    if (workflowStartIsAnchoredSiteModifier(context, cursor)) return [];
    const firstFrame = getProceduralFrames(context).find((frame) =>
      frame.span.start <= first.sourceStart && first.sourceEnd <= frame.span.end
    );
    const firstDefinition = firstFrame
      ? resolveMedicationInstructionAction(firstFrame.predicate.lemma, context.options)
      : undefined;
    const structurallyHeadedProcedure = Boolean(
      firstFrame &&
      firstDefinition?.procedural &&
      firstFrame.args.some((arg) => arg.role === AdviceArgumentRole.Site) &&
      sourceRangeAttachmentClass(context, first.sourceStart, first.sourceEnd) === "administration"
    );
    if (structurallyHeadedProcedure) return [];
    if (!WORKFLOW_START_WORDS.has(firstLower)) {
      return [];
    }
    const second = context.tokens[cursor + 1];
    const secondLower = second ? normalizeTokenLower(second) : "";
    if (firstLower === MEAL_RELATION_BY_TOKEN.get("with") && !WORKFLOW_CONTINUATION_LICENSES.has(`${firstLower} ${secondLower}`)) {
      return [];
    }
    if (isScheduleLead(context, cursor)) {
      return [];
    }

    const bodyTokens: Token[] = [];
    for (; cursor < context.limit; cursor += 1) {
      const token = context.tokens[cursor];
      if (!token || context.state.consumed.has(token.index)) {
        break;
      }
      const lower = normalizeTokenLower(token);
      const previousLower = bodyTokens.length ? normalizeTokenLower(bodyTokens[bodyTokens.length - 1]) : "";
      const nextLower = context.tokens[cursor + 1] ? normalizeTokenLower(context.tokens[cursor + 1]) : "";
      const actionDefinition = resolveMedicationInstructionAction(lower, context.options);
      if (
        bodyTokens.length &&
        actionDefinition &&
        !actionDefinition.procedural &&
        isMedicationAdministrationMethod(lower, context.options) &&
        !WORKFLOW_ACTION_RELATION_LEADS.has(previousLower)
      ) {
        break;
      }
      if (
        bodyTokens.length &&
        (isExplicitDoseLead(context, cursor) || startsScheduledAdministration(context, cursor)) &&
        !WORKFLOW_ACTION_RELATION_LEADS.has(previousLower)
      ) {
        break;
      }
      if (
        bodyTokens.length &&
        (isInstructionSeparator(token) || INSTRUCTION_START_WORDS.has(lower)) &&
        !WORKFLOW_CONTINUATION_LICENSES.has(`${previousLower} ${lower}`)
      ) {
        break;
      }
      if (
        bodyTokens.length &&
        isScheduleLead(context, cursor) &&
        !([LexKind.Number, LexKind.NumberRange].indexOf(bodyTokens[bodyTokens.length - 1]?.kind as LexKind) >= 0 && mapIntervalUnit(lower)) &&
        !WORKFLOW_CONTINUATION_LICENSES.has(`${previousLower} ${lower}`) &&
        !(
          previousLower &&
          WORKFLOW_CONTINUATION_LICENSES.has(`${previousLower} *event`) &&
          EVENT_TIMING_TOKENS[lower]
        ) &&
        !WORKFLOW_CONTINUATION_LICENSES.has(`${lower} ${nextLower}`)
      ) {
        break;
      }
      if (LIST_SEPARATORS.has(lower) && bodyTokens.length && !WORKFLOW_NOUNS.has(normalizeTokenLower(context.tokens[cursor + 1] ?? token))) {
        break;
      }
      bodyTokens.push(token);
    }
    if (!bodyTokens.length) {
      return [];
    }
    const range = rangeFromTokens(bodyTokens);
    const text = range
      ? context.state.input.slice(range.start, range.end).trim()
      : joinTokenText(bodyTokens);
    if (!text) {
      return [];
    }
    return [
      lexicalSign({
        type: "instruction-sign",
        rule: "hpsg.lex.patientInstruction.workflow",
        tokens: [...consumed, ...bodyTokens],
        synsem: {
          head: {},
          valence: { patientInstruction: { text } },
          cont: { clauseKind: "administration" }
        },
        score: 12 + bodyTokens.length
      })
    ];
  });
}

function isInstructionSeparator(token: Token | undefined): boolean {
  return Boolean(token && INSTRUCTION_LEADING_SEPARATORS.has(token.original.trim().toLowerCase()));
}

function instructionStartIsLicensed(
  context: HpsgClauseContext,
  start: number,
  hasLeadingSeparator: boolean
): boolean {
  if (hasLeadingSeparator) {
    return true;
  }
  const token = tokensAvailable(context, start, 1)?.pop();
  const lower = token ? normalizeTokenLower(token) : "";
  const enclosedByProcedure = Boolean(token && getProceduralFrames(context).some((frame) => {
    if (frame.span.start >= token.sourceStart || token.sourceEnd > frame.span.end) return false;
    if (frame.polarity === AdvicePolarity.Negate) return false;
    return resolveMedicationInstructionAction(frame.predicate.lemma, context.options)?.procedural === true;
  }));
  if (enclosedByProcedure) return false;
  const previous = context.tokens[start - 1];
  const previousLower = previous ? normalizeTokenLower(previous) : "";
  if (previousLower && WORKFLOW_CONTINUATION_LICENSES.has(`${previousLower} ${lower}`)) {
    return false;
  }
  if (INSTRUCTION_START_WORDS.has(lower)) {
    return true;
  }
  return Boolean(previous && isMedicationAdministrationMethod(previousLower, context.options));
}

function parseTypedConceptInstruction(
  text: string,
  range: { start: number; end: number },
  predicate: string,
  context: HpsgClauseContext
): CanonicalAdditionalInstructionExpr | undefined {
  const concept = resolveMedicationInstructionConcept(text, context.options);
  if (!concept || (concept.role !== AdviceArgumentRole.Amount && concept.role !== AdviceArgumentRole.Manner)) {
    return undefined;
  }
  const codings = medicationInstructionConceptCodings(concept);
  const action = resolveMedicationInstructionAction(predicate, context.options);
  const display = action?.display ?? predicate;
  const i18n = composeLocalizedRecords(
    [action?.i18n, concept.i18n],
    ([actionText, conceptText], locale) => joinLocalizedTokens(locale, [actionText, conceptText])
  );
  const frame: AdviceFrame = {
    force: AdviceForce.Instruction,
    predicate: { lemma: predicate, semanticClass: "administration" },
    args: [{
      role: concept.role,
      text,
      normalized: concept.display,
      conceptId: concept.code,
      coding: codings[0],
      codings,
      i18n: { en: concept.display, ...(concept.i18n ?? {}) }
    }],
    span: { ...range },
    sourceText: text,
    sequenceIndex: 0
  };
  return {
    text: `${display} ${concept.display}`,
    i18n,
    coding: codings[0],
    frames: [frame]
  };
}

function parseInstructionCandidates(
  text: string,
  range: { start: number; end: number }
): CanonicalAdditionalInstructionExpr[] {
  let best: CanonicalAdditionalInstructionExpr[] = [];
  let bestScore = -1;
  for (const predicate of INSTRUCTION_PREDICATES) {
    const parsed = parseAdditionalInstructions(text, range, {
      defaultPredicate: predicate,
      defaultForce: AdviceForce.Instruction,
      allowFreeTextFallback: true
    });
    const instructions = parsed.map((instruction) => {
      const thai = !instruction.coding?.code && instruction.frames?.length
        ? realizeAdviceFramesText(instruction.frames, "th")
        : undefined;
      return {
        text: instruction.text,
        i18n: thai ? { th: thai } : undefined,
        coding: instruction.coding,
        frames: instruction.frames
      };
    });
    const score = instructions.reduce((sum, instruction) =>
      sum + (instruction.coding?.code ? 4 : 0) + (instruction.frames?.length ? 2 : 0) + (instruction.text ? 1 : 0),
      0
    );
    if (score > bestScore) {
      best = instructions;
      bestScore = score;
    }
  }
  return best;
}

function bodyParsesAsStyleInstruction(
  context: HpsgClauseContext,
  bodyTokens: Token[]
): boolean {
  const range = rangeFromTokens(bodyTokens);
  const text = range
    ? context.state.input.slice(range.start, range.end).replace(/\s+/g, " ").trim()
    : joinTokenText(bodyTokens);
  if (!range || !text) {
    return false;
  }
  const typedConcept = resolveMedicationInstructionConcept(text, context.options);
  if (typedConcept && (
    typedConcept.role === AdviceArgumentRole.Amount ||
    typedConcept.role === AdviceArgumentRole.Manner
  )) return true;
  const hasStyleLexeme = bodyTokens.some((token) =>
    SITE_TRAILING_INSTRUCTION_WORDS.has(normalizeTokenLower(token))
  );
  return hasStyleLexeme && parseInstructionCandidates(text, range).some((instruction) =>
    Boolean(instruction.coding?.code || instruction.frames?.length)
  );
}


function activityConceptAt(
  context: HpsgClauseContext,
  start: number
): { length: number; display: string; i18n?: Record<string, string> } | undefined {
  const maxLength = Math.min(4, context.limit - start);
  for (let length = maxLength; length >= 1; length -= 1) {
    const tokens = tokensAvailable(context, start, length);
    if (!tokens) continue;
    const surface = tokens.map((token) => normalizeTokenLower(token)).join(" ");
    const concept = resolveMedicationInstructionConcept(surface, context.options);
    if (concept?.role !== AdviceArgumentRole.Activity) continue;
    return { length, display: concept.display, i18n: concept.i18n ? { ...concept.i18n } : undefined };
  }
  return undefined;
}

function coordinatedAdministrationWindowInstructionAt(
  context: HpsgClauseContext,
  start: number
) {
  const relationToken = context.tokens[start];
  if (!relationToken || context.state.consumed.has(relationToken.index)) return undefined;
  const relation = resolveActionRelationSurface(normalizeTokenLower(relationToken));
  if (relation !== AdviceRelation.Before && relation !== AdviceRelation.After) return undefined;
  const left = activityConceptAt(context, start + 1);
  if (!left) return undefined;
  const connectorIndex = start + 1 + left.length;
  const connectorToken = context.tokens[connectorIndex];
  const connector = connectorToken ? normalizeTokenLower(connectorToken) : "";
  if (!connectorToken || !ACTION_COORDINATION_CONNECTORS.has(connector)) return undefined;
  const right = activityConceptAt(context, connectorIndex + 1);
  if (!right) return undefined;
  const end = connectorIndex + 1 + right.length;
  const tokens = tokensAvailable(context, start, end - start);
  if (!tokens) return undefined;
  const relationRealizations = getAdviceRelationRealizations(relation);
  const i18n = composeLocalizedRecords(
    [relationRealizations, left.i18n, ACTION_COORDINATION_CONNECTOR_I18N[connector], right.i18n],
    ([relationText, leftText, connectorText, rightText], locale) =>
      joinLocalizedTokens(locale, [relationText, leftText, connectorText, rightText])
  );
  return lexicalSign({
    type: "instruction-sign",
    rule: "hpsg.lex.instruction.coordinatedAdministrationWindow",
    tokens,
    synsem: {
      head: {},
      valence: {
        instructions: [{
          text: `${relation} ${left.display} ${connector} ${right.display}`,
          i18n
        }]
      },
      cont: { clauseKind: "administration" }
    },
    score: 27 + tokens.length
  });
}

function administrationWindowInstructionAt(
  context: HpsgClauseContext,
  start: number
) {
  const first = context.tokens[start];
  if (!first || context.state.consumed.has(first.index)) return undefined;
  const coordinated = coordinatedAdministrationWindowInstructionAt(context, start);
  if (coordinated) return coordinated;
  const candidates = ADMINISTRATION_WINDOWS_BY_FIRST.get(normalizeTokenLower(first)) ?? [];
  for (const definition of candidates) {
    if (definition.offsetOnly) continue;
    const tokens = tokensAvailable(context, start, definition.parts.length);
    if (!tokens) continue;
    if (!tokens.every((token, index) => normalizeTokenLower(token) === definition.parts[index])) continue;
    if (definition.relation && definition.activity) {
      const activity = resolveMedicationInstructionConcept(definition.activity, context.options);
      if (activity) {
        return lexicalSign({
          type: "schedule-sign",
          rule: "hpsg.lex.schedule.activityTiming",
          tokens,
          synsem: {
            head: {
              schedule: {
                activityTiming: [{
                  relation: definition.relation,
                  activity: {
                    text: activity.display,
                    i18n: activity.i18n ? { ...activity.i18n } : undefined,
                    coding: medicationInstructionConceptCodings(activity)[0]
                  }
                }]
              }
            },
            valence: {},
            cont: { clauseKind: "administration" }
          },
          score: 26 + tokens.length
        });
      }
    }
    return lexicalSign({
      type: "instruction-sign",
      rule: "hpsg.lex.instruction.administrationWindow",
      tokens,
      synsem: {
        head: {},
        valence: {
          instructions: [{
            text: definition.text,
            i18n: definition.i18n ? { ...definition.i18n } : undefined
          }]
        },
        cont: { clauseKind: "administration" }
      },
      score: 24 + tokens.length
    });
  }
  return undefined;
}

export function instructionLexicalRule(): HpsgLexicalRule<HpsgClauseContext> {
  return lexicalRule("hpsg.lex.instruction", (context, start) => {
    const first = context.tokens[start];
    if (!first || context.state.consumed.has(first.index)) {
      return [];
    }
    const administrationWindow = administrationWindowInstructionAt(context, start);
    if (administrationWindow) return [administrationWindow];

    let cursor = start;
    const consumed: Token[] = [];
    while (cursor < context.limit && isInstructionSeparator(context.tokens[cursor])) {
      const separator = context.tokens[cursor];
      if (!separator || context.state.consumed.has(separator.index)) {
        return [];
      }
      consumed.push(separator);
      cursor += 1;
    }
    const sequenceLead = context.tokens[cursor];
    if (
      consumed.length > 0 &&
      sequenceLead &&
      ACTION_SEQUENCE_MARKERS.has(normalizeTokenLower(sequenceLead))
    ) {
      const next = context.tokens[cursor + 1];
      const nextLower = next ? normalizeTokenLower(next) : "";
      const nextAction = resolveMedicationInstructionAction(nextLower, context.options);
      if (nextAction?.procedural) {
        return [];
      }
      if (
        (nextAction && !nextAction.procedural && isMedicationAdministrationMethod(nextLower, context.options)) ||
        FREE_TEXT_DIRECTIVE_STARTS.has(nextLower)
      ) {
        cursor += 1;
      }
    }
    if (!instructionStartIsLicensed(context, cursor, consumed.length > 0)) {
      return [];
    }
    if (consumed.length > 0 && startsEventTimingPhrase(context, cursor)) return [];
    const firstBodyToken = context.tokens[cursor];
    const firstBodyLower = firstBodyToken ? normalizeTokenLower(firstBodyToken) : "";
    if (CONDITIONAL_INSTRUCTION_EXCLUSIVE_LEADS.has(firstBodyLower)) return [];
    const firstBodyAction = resolveMedicationInstructionAction(firstBodyLower, context.options);
    if (
      !consumed.length &&
      firstBodyAction &&
      !firstBodyAction.procedural &&
      isMedicationAdministrationMethod(firstBodyLower, context.options) &&
      isScheduleLead(context, cursor + 1)
    ) {
      return [];
    }
    if (consumed.length && firstBodyAction && !firstBodyAction.procedural && isMedicationAdministrationMethod(firstBodyLower, context.options)) {
      const priorPrimaryMethod = context.tokens.slice(0, cursor).some((candidate) => {
        const priorLower = normalizeTokenLower(candidate);
        const method = isMedicationAdministrationMethod(priorLower, context.options);
        const definition = resolveMedicationInstructionAction(priorLower, context.options);
        return Boolean(method && definition && !definition.procedural);
      });
      if (!priorPrimaryMethod) return [];
    }

    const bodyStart = cursor;
    const bodyTokens: Token[] = [];
    for (; cursor < context.limit; cursor += 1) {
      const token = context.tokens[cursor];
      if (!token || context.state.consumed.has(token.index)) {
        break;
      }
      if (isInstructionSeparator(token) && bodyTokens.length) {
        break;
      }
      if (!bodyTokens.length && isScheduleLead(context, cursor)) {
        return [];
      }
      if (bodyTokens.length && isScheduleLead(context, cursor)) {
        break;
      }
      if (bodyTokens.length && bodyParsesAsStyleInstruction(context, bodyTokens)) {
        const lower = normalizeTokenLower(token);
        const resolvedSite = resolveBodySitePhrase(
          token.original,
          context.options?.siteCodeMap,
          { bodySiteContext: context.options?.context?.bodySiteContext }
        );
        const startsSite = SITE_ANCHORS.has(lower) || Boolean(
          resolvedSite?.coding || resolvedSite?.definition || resolvedSite?.spatialRelation
        );
        if (startsSite) break;
      }
      bodyTokens.push(token);
    }
    if (!bodyTokens.length) {
      return [];
    }
    const range = rangeFromTokens(bodyTokens);
    const text = range
      ? context.state.input.slice(range.start, range.end).replace(/\s+/g, " ").trim()
      : joinTokenText(bodyTokens);
    if (!range || !text) {
      return [];
    }
    const previous = context.tokens[bodyStart - 1];
    const previousLower = previous ? normalizeTokenLower(previous) : "";
    const predicate = isMedicationAdministrationMethod(previousLower, context.options)
      ? previousLower
      : "apply";
    const adviceInstructions = parseInstructionCandidates(text, range);
    const hasCodedAdvice = adviceInstructions.some((instruction) => Boolean(instruction.coding?.code));
    const typedInstruction = hasCodedAdvice
      ? undefined
      : parseTypedConceptInstruction(text, range, predicate, context);
    const instructions = typedInstruction ? [typedInstruction] : adviceInstructions;
    if (!instructions.length) {
      return [];
    }
    const hasStructuredInstruction = instructions.some((instruction) =>
      instruction.coding?.code || instruction.frames?.length
    );
    const explicitFreeTextDirective = FREE_TEXT_DIRECTIVE_STARTS.has(
      normalizeTokenLower(bodyTokens[0])
    );
    if (!hasStructuredInstruction && !consumed.length && !explicitFreeTextDirective) {
      return [];
    }
    return [
      lexicalSign({
        type: "instruction-sign",
        rule: "hpsg.lex.instruction",
        tokens: [...consumed, ...bodyTokens],
        synsem: {
          head: {},
          valence: { instructions },
          cont: { clauseKind: "administration" }
        },
        score: 8 + instructions.length
      })
    ];
  });
}

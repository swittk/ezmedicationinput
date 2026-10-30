import {
  medicationGuardLeadLexeme, medicationConditionAtomLexeme, conditionSourceLexemes, conditionNegationPrefixLength,
  medicationGuardClauseBoundary, MEDICATION_GUARD_BOUNDARIES
} from "../medication-condition";
import { lexInput } from "../lexer/lex";
import { LexKind } from "../lexer/token-types";
import { annotateLexTokens } from "../lexer/meaning";
import type { Token } from "../parser-state";
import type { MedicationCondition } from "../types";
import { lexicalSign, type HpsgGuardExpression, type HpsgSynsem, type HpsgPhraseRule } from "./signature";
import { combineSignFeatureStructures } from "./feature-structure";
import { AdviceArgumentRole, AdviceForce, AdvicePolarity, AdviceRelation, type AdviceArgument, type AdviceFrame } from "../types";
import type {
  HpsgConstruction,
  HpsgConstructionKind,
  HpsgConstructionOperation,
  HpsgSign,
  HpsgType
} from "./signature";
import { grammaticalCoordinationScopes } from "../regimen/grammar";
import { equalStructuredValues } from "../stable-structure";
import type {
  BoundaryRelation,
  CoordinationScopeFacts,
  RegimenSemanticSelection
} from "./signature";

export interface HpsgConstructionSelection {
  motherType: HpsgType;
  construction: HpsgConstruction;
}

export interface HpsgCoordinationScopeSelection extends HpsgConstructionSelection {
  semantic: RegimenSemanticSelection;
}

/** Typed daughter facts for one administration with coordinated timing anchors. */
export interface HpsgTimingAnchorCoordinationFacts {
  relation?: BoundaryRelation;
  sameSourceExpansion: boolean;
  adjacent: boolean;
  leftComplete: boolean;
  rightComplete: boolean;
  sameAdministration: boolean;
  compatibleMethod: boolean;
  leftHasMethod: boolean;
  rightHasMethod: boolean;
  leftAnchorOnly: boolean;
  rightAnchorOnly: boolean;
  sameScheduleContext: boolean;
  addsAnchor: boolean;
  /** The left event is already the first equal-dose occurrence of the right interval. */
  originOfRightInterval?: boolean;
}

export interface HpsgTimingAnchorCoordinationSelection
  extends HpsgConstructionSelection {
  id: "hpsg.cx.regimen.coordinated-timing-anchors" | "hpsg.cx.regimen.interval-origin";
  scheduleComposition: "union-anchors" | "right-interval";
}

type SignTrait =
  | "any"
  | "condition"
  | "marker"
  | "administration-head"
  | "method-specialization"
  | "complement"
  | "adjunct"
  | "clinical-adjunct"
  | "dose"
  | "site"
  | "site-head"
  | "procedure"
  | "scope-target"
  | "marked"
  | "site-relative-marker"
  | "site-predicate"
  | "site-relative";

type HeadSource = "left" | "right" | "administration-head" | "method-specialization" | "scope-target" | "non-marker" | "none";

interface ConstructionSchema {
  motherType: HpsgType;
  kind: HpsgConstructionKind;
  left: readonly SignTrait[];
  right: readonly SignTrait[];
  symmetric?: boolean;
  headFrom?: HeadSource;
  operation?: HpsgConstructionOperation;
  forbidLeft?: readonly SignTrait[];
  forbidRight?: readonly SignTrait[];
}

function signTraits(sign: HpsgSign): Set<SignTrait> {
  const traits = new Set<SignTrait>(["any"]);
  if (sign.synsem.cont.condition && !sign.synsem.cont.scopeClosed) traits.add("condition");
  if (sign.type === "connector-sign") traits.add("marker");
  if (sign.synsem.cont.siteRelativeMarker) traits.add("site-relative-marker");
  if (sign.synsem.cont.sitePredicate) {
    traits.add("site-predicate");
  }
  if (sign.synsem.cont.siteRestriction) {
    traits.add("site-relative");
  }
  if (sign.synsem.head.method) {
    traits.add("administration-head");
    if (sign.synsem.head.method.text) traits.add("method-specialization");
    if (sign.synsem.head.method.headClass === "procedure") traits.add("procedure");
  }
  if (sign.synsem.head.route || sign.synsem.head.dose || sign.synsem.valence.site) traits.add("complement");
  if (sign.synsem.head.dose) traits.add("dose");
  if (sign.synsem.valence.site) traits.add("site");
  if (sign.type === "site-sign" || sign.type === "restricted-site-phrase") {
    traits.add("site-head");
  }
  if (
    sign.synsem.head.schedule ||
    sign.synsem.valence.prn ||
    sign.synsem.valence.instructions?.length ||
    sign.type === "adjustment-sign"
  ) traits.add("adjunct");
  if (sign.synsem.cont.clinicalAdjunct) {
    traits.add("adjunct");
    traits.add("clinical-adjunct");
  }
  if (sign.synsem.valence.patientInstruction || sign.construction?.kind === "procedure-sequence") {
    traits.add("procedure");
  }
  if (sign.synsem.valence.patientInstruction || sign.synsem.valence.instructions?.length) {
    traits.add("scope-target");
  }
  if (sign.construction?.kind === "head-marker" && sign.type !== "site-relative-clause") {
    traits.add("marked");
  }
  return traits;
}

const CONSTRUCTION_SCHEMAS: readonly ConstructionSchema[] = [
  {
    motherType: "site-relative-clause",
    kind: "head-marker",
    left: ["site-relative-marker"],
    right: ["site-predicate"],
    headFrom: "right",
    operation: "form-site-relative"
  },
  {
    motherType: "restricted-site-phrase",
    kind: "head-adjunct",
    left: ["site-head"],
    right: ["site-relative"],
    headFrom: "left",
    operation: "restrict-site"
  },
  {
    motherType: "conditional-instruction-phrase",
    kind: "conditional-instruction",
    left: ["condition"],
    right: ["scope-target"],
    symmetric: true,
    headFrom: "scope-target",
    operation: "scope"
  },
  {
    motherType: "head-marker-phrase",
    kind: "head-marker",
    left: ["marker"],
    right: ["any"],
    symmetric: true,
    headFrom: "non-marker",
    forbidLeft: ["site-relative-marker", "site-predicate", "site-relative"],
    forbidRight: ["site-relative-marker", "site-predicate", "site-relative"]
  },
  {
    motherType: "procedure-sequence-phrase",
    kind: "procedure-sequence",
    left: ["procedure"],
    right: ["procedure"],
    headFrom: "none"
  },
  {
    motherType: "head-complement-phrase",
    kind: "head-complement",
    left: ["administration-head"],
    right: ["method-specialization"],
    symmetric: true,
    headFrom: "method-specialization"
  },
  {
    motherType: "head-complement-phrase",
    kind: "head-complement",
    left: ["administration-head"],
    right: ["complement"],
    symmetric: true,
    headFrom: "administration-head"
  },
  {
    motherType: "head-adjunct-phrase",
    kind: "head-adjunct",
    left: ["administration-head"],
    right: ["adjunct"],
    symmetric: true,
    headFrom: "administration-head"
  },
  {
    motherType: "administration-clause",
    kind: "administration-clause",
    left: ["administration-head"],
    right: ["procedure"],
    symmetric: true,
    headFrom: "administration-head"
  },
  {
    motherType: "site-coordination-phrase",
    kind: "coordination",
    left: ["marked", "site"],
    right: ["site"],
    symmetric: true,
    headFrom: "none",
    forbidLeft: ["condition", "administration-head", "dose", "adjunct", "procedure"],
    forbidRight: ["condition", "administration-head", "dose", "adjunct", "procedure"]
  },
  {
    motherType: "coordination-phrase",
    kind: "coordination",
    left: ["marked"],
    right: ["any"],
    symmetric: true,
    headFrom: "administration-head",
    forbidLeft: ["condition", "site-relative-marker", "site-predicate", "site-relative"],
    forbidRight: ["condition", "site-relative-marker", "site-predicate", "site-relative"]
  },
  {
    motherType: "administration-clause",
    kind: "administration-clause",
    left: ["administration-head"],
    right: ["any"],
    symmetric: true,
    headFrom: "administration-head",
    forbidLeft: ["condition", "site-relative-marker", "site-predicate", "site-relative"],
    forbidRight: ["condition", "site-relative-marker", "site-predicate", "site-relative"]
  },
  {
    motherType: "clause-sign",
    kind: "generic",
    left: ["any"],
    right: ["any"],
    headFrom: "none",
    forbidLeft: ["condition", "site-relative-marker", "site-predicate", "site-relative"],
    forbidRight: ["condition", "site-relative-marker", "site-predicate", "site-relative"]
  }
];

function hasAll(actual: Set<SignTrait>, expected: readonly SignTrait[]): boolean {
  return expected.every((trait) => actual.has(trait));
}

function sourceRange(sign: HpsgSign): { start: number; end: number } | undefined {
  if (!sign.tokens.length) return undefined;
  return {
    start: Math.min(...sign.tokens.map((token) => token.sourceStart)),
    end: Math.max(...sign.tokens.map((token) => token.sourceEnd))
  };
}

function scopeRequirementSatisfied(left: HpsgSign, right: HpsgSign): boolean {
  const conditionSign = left.synsem.cont.condition && !left.synsem.cont.scopeClosed ? left
    : right.synsem.cont.condition && !right.synsem.cont.scopeClosed ? right
    : undefined;
  if (!conditionSign) return false;
  const target = conditionSign === left ? right : left;
  const condition = conditionSign.synsem.cont.condition;
  const range = sourceRange(target);
  return Boolean(
    condition && range &&
    range.start <= condition.targetStart && range.end >= condition.targetEnd &&
    // Containing the target does not license scoping its unrelated siblings.
    // Attach the condition to the source-owned action constituent first; a
    // preceding medication duration/cap then unifies outside that scope.
    target.tokens.every(token => token.kind === LexKind.Separator ||
      condition.targetStart <= token.sourceStart && token.sourceEnd <= condition.targetEnd)
  );
}

function forbidden(actual: Set<SignTrait>, values: readonly SignTrait[] | undefined): boolean {
  return Boolean(values?.some((trait) => actual.has(trait)));
}

function schemaMatches(
  schema: ConstructionSchema,
  leftTraits: Set<SignTrait>,
  rightTraits: Set<SignTrait>
): { direct: boolean; swapped: boolean } | undefined {
  const directAllowed = !forbidden(leftTraits, schema.forbidLeft) && !forbidden(rightTraits, schema.forbidRight);
  const direct = directAllowed && hasAll(leftTraits, schema.left) && hasAll(rightTraits, schema.right);
  const swappedAllowed = !forbidden(leftTraits, schema.forbidRight) && !forbidden(rightTraits, schema.forbidLeft);
  const swapped = Boolean(
    schema.symmetric && swappedAllowed && hasAll(leftTraits, schema.right) && hasAll(rightTraits, schema.left)
  );
  return direct || swapped ? { direct, swapped } : undefined;
}

function rawTraitHeadSide(
  source: HeadSource | undefined,
  leftTraits: Set<SignTrait>,
  rightTraits: Set<SignTrait>
): "left" | "right" | undefined {
  if (!source || source === "none") return undefined;
  if (source === "left" || source === "right") return source;
  if (source === "non-marker") {
    if (leftTraits.has("marker") !== rightTraits.has("marker")) {
      return leftTraits.has("marker") ? "right" : "left";
    }
    return undefined;
  }
  const trait: SignTrait | undefined = source === "administration-head"
    ? "administration-head"
    : source === "method-specialization"
      ? "method-specialization"
      : source === "scope-target"
        ? "scope-target"
        : undefined;
  if (!trait) return undefined;
  const left = leftTraits.has(trait) && (source !== "scope-target" || !leftTraits.has("condition"));
  const right = rightTraits.has(trait) && (source !== "scope-target" || !rightTraits.has("condition"));
  return left === right ? undefined : left ? "left" : "right";
}

function headedMatchIsAmbiguous(
  source: HeadSource | undefined,
  match: { direct: boolean; swapped: boolean },
  leftTraits: Set<SignTrait>,
  rightTraits: Set<SignTrait>
): boolean {
  if (!source || source === "none") return false;
  if ((source === "left" || source === "right") && match.direct && match.swapped) return true;
  if (source === "administration-head") {
    return leftTraits.has("administration-head") && rightTraits.has("administration-head");
  }
  if (source === "method-specialization") {
    return leftTraits.has("method-specialization") && rightTraits.has("method-specialization");
  }
  if (source === "scope-target") {
    const left = leftTraits.has("scope-target") && !leftTraits.has("condition");
    const right = rightTraits.has("scope-target") && !rightTraits.has("condition");
    return left && right;
  }
  if (source === "non-marker") {
    return leftTraits.has("marker") && rightTraits.has("marker");
  }
  return false;
}

function schemaTraitHeadSide(
  schema: ConstructionSchema,
  match: { direct: boolean; swapped: boolean },
  source: HeadSource | undefined,
  leftTraits: Set<SignTrait>,
  rightTraits: Set<SignTrait>
): "left" | "right" | undefined {
  if (!source || source === "none") return undefined;
  if (match.direct !== match.swapped) {
    const physicalSide = (schemaSide: "left" | "right"): "left" | "right" =>
      match.direct ? schemaSide : schemaSide === "left" ? "right" : "left";
    if (source === "left" || source === "right") return physicalSide(source);
    const trait: SignTrait | undefined = source === "administration-head"
      ? "administration-head"
      : source === "method-specialization"
        ? "method-specialization"
        : source === "scope-target"
          ? "scope-target"
          : source === "non-marker"
            ? "marker"
            : undefined;
    if (trait) {
      const leftRequires = schema.left.indexOf(trait) >= 0;
      const rightRequires = schema.right.indexOf(trait) >= 0;
      if (leftRequires !== rightRequires) {
        if (source === "non-marker") return physicalSide(leftRequires ? "right" : "left");
        return physicalSide(leftRequires ? "left" : "right");
      }
    }
  }
  return rawTraitHeadSide(source, leftTraits, rightTraits);
}

export function selectHpsgConstruction(left: HpsgSign, right: HpsgSign): HpsgConstructionSelection | undefined {
  const leftTraits = signTraits(left);
  const rightTraits = signTraits(right);
  let ambiguousHeadedMatch = false;
  for (const schema of CONSTRUCTION_SCHEMAS) {
    const match = schemaMatches(schema, leftTraits, rightTraits);
    if (!match) continue;
    if (schema.operation === "scope" && !scopeRequirementSatisfied(left, right)) continue;

    const headed = Boolean(schema.headFrom && schema.headFrom !== "none");
    const headSide = schemaTraitHeadSide(schema, match, schema.headFrom, leftTraits, rightTraits);
    if (headed && !headSide) {
      if (headedMatchIsAmbiguous(schema.headFrom, match, leftTraits, rightTraits)) {
        ambiguousHeadedMatch = true;
      }
      continue;
    }
    if (schema.kind === "generic" && ambiguousHeadedMatch) return undefined;

    return {
      motherType: schema.motherType,
      construction: {
        kind: schema.kind,
        operation: schema.operation ?? "unify",
        headSide,
        leftType: left.type,
        rightType: right.type
      }
    };
  }
  return undefined;
}

/**
 * Select a construction over two already chart-parsed administration clauses.
 * This is the cross-clause counterpart of `selectHpsgConstruction`: the chart
 * daughters retain their own dose/site values while the licensed adjunct
 * daughter scopes over the coordinated phrase. An alternative has no head:
 * neither daughter is privileged as the executable administration.
 */
export function selectHpsgCoordinationScopeConstruction(
  facts: CoordinationScopeFacts
): HpsgCoordinationScopeSelection | undefined {
  const semantic = grammaticalCoordinationScopes(facts)[0];
  if (!semantic) return undefined;
  const operation = semantic.construction.operation;
  return {
    motherType: "coordination-phrase",
    construction: {
      kind: "coordination",
      operation: "scope",
      headSide: operation === "preserve-disjunctive-dosages"
        ? undefined
        : operation === "share-leading-adjuncts" || operation === "inherit-event-timing-administration" ||
          operation === "inherit-event-timing-and-share-trailing-course-duration" ||
          operation === "inherit-administration-head" ||
          operation === "inherit-administration-head-and-share-trailing-course-duration"
          ? "left" : "right",
      leftType: "administration-clause",
      rightType: "administration-clause"
    },
    semantic
  };
}

/**
 * License two complete administration daughters as one dosage with coordinated
 * timing anchors. Sequence and alternative relations remain separate phases;
 * a meal-dash expansion is already one source construction and needs no
 * surface connector relation.
 */
export function selectHpsgTimingAnchorCoordinationConstruction(
  facts: HpsgTimingAnchorCoordinationFacts
): HpsgTimingAnchorCoordinationSelection | undefined {
  const relationLicensed = facts.sameSourceExpansion || Boolean(
    facts.relation?.kind === "coordination"
  );
  const intervalOrigin = facts.relation?.semanticLicense === "interval-origin" &&
    facts.originOfRightInterval === true;
  if (!relationLicensed || !facts.adjacent ||
      !facts.leftComplete || !facts.rightComplete ||
      !facts.sameAdministration || !facts.compatibleMethod ||
      !facts.leftAnchorOnly || !facts.sameScheduleContext ||
      (!intervalOrigin && (!facts.rightAnchorOnly || !facts.addsAnchor))) {
    return undefined;
  }

  return {
    id: intervalOrigin ? "hpsg.cx.regimen.interval-origin" : "hpsg.cx.regimen.coordinated-timing-anchors",
    scheduleComposition: intervalOrigin ? "right-interval" : "union-anchors",
    motherType: "coordination-phrase",
    construction: {
      kind: "coordination",
      operation: "unify",
      headSide: facts.leftHasMethod || !facts.rightHasMethod ? "left" : "right",
      leftType: "administration-clause",
      rightType: "administration-clause"
    }
  };
}


/** Source-typed calendar alternatives can omit a shared clock and head. */
export interface HpsgCalendarClockEllipsisFacts {
  relation: BoundaryRelation;
  adjacent: boolean;
  calendarAlternatives: boolean;
  compatibleAdministration: boolean;
  omittedHead: boolean;
  omittedClock: boolean;
  /** Every antecedent contributes its clock; absence or disagreement blocks binding. */
  donorClocks: readonly (string | undefined)[];
}

export function selectHpsgCalendarClockEllipsisConstruction(
  facts: HpsgCalendarClockEllipsisFacts
): (HpsgConstructionSelection & { id: string; timeOfDay: string[] }) | undefined {
  const clock = facts.donorClocks[0];
  if ((facts.relation.kind !== "coordination" && facts.relation.kind !== "independent") ||
      !facts.adjacent || !facts.calendarAlternatives || !facts.compatibleAdministration ||
      !facts.omittedHead || !facts.omittedClock || clock === undefined ||
      !facts.donorClocks.every(value => value === clock)) return undefined;
  return {
    id: "hpsg.cx.coordination.calendar-clock-ellipsis",
    timeOfDay: [clock],
    motherType: "coordination-phrase",
    construction: {
      kind: "coordination", operation: "scope", headSide: "left",
      leftType: "administration-clause", rightType: "administration-clause"
    }
  };
}

/**
 * A shared directive scopes over coordinated action daughters. An explicit
 * directive on the right starts its own scope; sequencing is not coordination.
 * A trailing duration is an adjunct of the coordinated prohibition, not a
 * medication-course bound. This construction consumes typed action meaning.
 */
export function composeCoordinatedActionDirective(
  left: AdviceFrame,
  right: AdviceFrame,
  coordination: "conjunction" | "disjunction" | "unknown",
  explicitRightDirective: boolean
): readonly [AdviceFrame, AdviceFrame] {
  if (coordination === "unknown" || explicitRightDirective || left.polarity !== AdvicePolarity.Negate) {
    return [left, right];
  }
  const scopedRight: AdviceFrame = { ...right, polarity: AdvicePolarity.Negate, polaritySource: "shared", force: AdviceForce.Warning };
  const duration = right.args.find(arg => arg.role === AdviceArgumentRole.Duration);
  const scopedLeft = duration && !left.args.some(arg => arg.role === AdviceArgumentRole.Duration)
    ? { ...left, args: [...left.args, { ...duration, quantity: duration.quantity ? { ...duration.quantity } : undefined }] }
    : left;
  return [scopedLeft, scopedRight];
}

/** A contact clause licenses a preposed physical theme, as in a directive
 * preventing a bottle tip from touching the eye. A nominal and contact head
 * are required; the causative marker cannot turn an ordinary GIVE into this
 * construction or spread negation to an unrelated following action.
 */
export function licensesPreposedContactTheme(
  role: AdviceArgumentRole,
  semanticClass?: string
): boolean {
  return semanticClass === "contact" && (
    role === AdviceArgumentRole.Object || role === AdviceArgumentRole.Theme ||
    role === AdviceArgumentRole.Container
  );
}

/** Compose the two contact participants under their existing directive scope. */
export function composePreposedContactTheme(
  frame: AdviceFrame,
  theme: AdviceArgument
): AdviceFrame {
  if (!licensesPreposedContactTheme(theme.role, frame.predicate.semanticClass)) return frame;
  return {
    ...frame,
    relation: frame.relation ?? AdviceRelation.To,
    args: [{ ...theme, role: AdviceArgumentRole.Theme }, ...frame.args]
  };
}

export interface ParsedMedicationGuard {
  condition: MedicationCondition;
  start: number;
  markerEnd: number;
  end: number;
  text: string;
  otherwiseHold: boolean;
  otherwise?: { start: number; end: number };
  alternative?: { start: number; end: number };
  /** Authoritative typed derivation reused by the main clause chart. */
  sign: HpsgSign;
}
interface GuardHead { name: string; unit?: string }
interface GuardConstituentContext {
  source: string;
  range: { start: number; end: number };
  /** Licensed by a registered withholding action with a medication-dose object. */
  withholdingConsequent?: true;
}

/** A coordinate can share only the last explicitly typed measurement head. */
function guardMeasurementHead(value: HpsgGuardExpression): GuardHead | undefined {
  if (value.kind === "predicate" && value.value.kind === "measurement") {
    return { name: value.value.name, ...(value.value.unit ? { unit: value.value.unit } : {}) };
  }
  if (value.kind === "coordination" && value.parts.length) {
    return guardMeasurementHead(value.parts[value.parts.length - 1]);
  }
  return undefined;
}

/** Discharge a missing comparison head across a licensed coordinate daughter. */
function bindGuardMeasurementHead(value: HpsgGuardExpression, head?: GuardHead): HpsgGuardExpression {
  if (value.kind === "measurement-complement" && head) {
    return { kind: "predicate", value: {
      kind: "measurement", name: head.name, operation: value.operation, value: value.value,
      ...(value.unit || head.unit ? { unit: value.unit ?? head.unit } : {}), text: value.text
    } };
  }
  if (value.kind === "coordination") {
    let shared = head;
    const parts = value.parts.map(part => {
      const resolved = bindGuardMeasurementHead(part, shared);
      shared = guardMeasurementHead(resolved);
      return resolved;
    });
    return { ...value, parts };
  }
  return value;
}

/** Project a completed predicate constituent without further surface analysis. */
function guardPredicateValue(value: HpsgGuardExpression): MedicationCondition {
  switch (value.kind) {
    case "predicate": return value.value;
    case "measurement-complement": return { kind: "text", text: value.text };
    case "negation": return { kind: "not", condition: guardPredicateValue(value.operand) };
    case "coordination": return { kind: value.operator, conditions: value.parts.map(guardPredicateValue) };
  }
}
/** Whole-day invariance is a compositional predicate type, not a text test. */
function guardExpressionHasDayDomain(value: HpsgGuardExpression): boolean {
  if (value.kind === "predicate") return value.dayInvariant === true;
  if (value.kind === "negation") return guardExpressionHasDayDomain(value.operand);
  return value.kind === "coordination" && value.parts.length > 0 &&
    value.parts.every(guardExpressionHasDayDomain);
}

function guardHasMeasurement(value: MedicationCondition): boolean {
  return value.kind === "measurement" ||
    (value.kind === "all" || value.kind === "any") && value.conditions.some(guardHasMeasurement) ||
    value.kind === "not" && guardHasMeasurement(value.condition);
}

/** Create a binary feature-structure derivation from already licensed daughters. */
function guardMother(
  left: HpsgSign, right: HpsgSign, type: HpsgType,
  synsem: HpsgSynsem, rule: string, headSide?: "left" | "right"
): HpsgSign | undefined {
  const fs = combineSignFeatureStructures(left.fs, right.fs, type, headSide, synsem);
  if (!fs) return undefined;
  const seen = new Set<number>();
  const tokens = [...left.tokens, ...right.tokens].filter(token => {
    if (seen.has(token.index)) return false;
    seen.add(token.index); return true;
  }).sort((a, b) => a.index - b.index);
  const consumedTokenIndices = tokens.map(token => token.index);
  return { type, synsem, fs, tokens,
    span: { start: Math.min(left.span.start, right.span.start), end: Math.max(left.span.end, right.span.end) },
    construction: { kind: type === "guard-predicate-phrase" ? "coordination" :
        type === "guard-coordination-tail" || type === "guard-negation-phrase" ? "head-complement" : "head-marker",
      operation: "unify", headSide, leftType: left.type, rightType: right.type },
    consumedTokenIndices,
    evidence: [...left.evidence, ...right.evidence, { rule, tokenIndices: consumedTokenIndices }],
    score: left.score + right.score + 1 };
}

/** A Boolean coordinator selects a predicate complement, never a dosage. */
const GUARD_COORDINATOR_COMPLEMENT: HpsgPhraseRule<GuardConstituentContext> = {
  id: "hpsg.cx.guard.coordinator-complement",
  combine(_context, left, right) {
    const operator = left.synsem.cont.guard?.operator;
    const predicate = right.synsem.cont.guard;
    if ((operator !== "all" && operator !== "any") || !predicate?.expression) return undefined;
    return guardMother(left, right, "guard-coordination-tail", {
      head: {}, valence: {}, cont: { guard: { ...predicate, operator } }
    }, this.id, "left");
  }
};

/** A lexical negator selects exactly one predicate daughter. */
const GUARD_NEGATED_PREDICATE: HpsgPhraseRule<GuardConstituentContext> = {
  id: "hpsg.cx.guard.negated-predicate",
  combine(_context, left, right) {
    const predicate = right.synsem.cont.guard;
    if (left.synsem.cont.guard?.operator !== "not" || !predicate?.expression) return undefined;
    return guardMother(left, right, "guard-negation-phrase", {
      head: {}, valence: {}, cont: { guard: {
        expression: { kind: "negation", operand: predicate.expression },
        ...(predicate.licensesBareIf ? { licensesBareIf: true as const } : {})
      } }
    }, this.id, "left");
  }
};

/** Boolean coordination and measurement-head ellipsis share this construction. */
const GUARD_PREDICATE_COORDINATION: HpsgPhraseRule<GuardConstituentContext> = {
  id: "hpsg.cx.guard.predicate-coordination",
  combine(_context, left, right) {
    const first = left.synsem.cont.guard, tail = right.synsem.cont.guard;
    if (!first?.expression || !tail?.expression || (tail.operator !== "all" && tail.operator !== "any")) return undefined;
    const last = bindGuardMeasurementHead(tail.expression, guardMeasurementHead(first.expression));
    const parts = first.expression.kind === "coordination" && first.expression.operator === tail.operator
      ? [...first.expression.parts, last] : [first.expression, last];
    return guardMother(left, right, "guard-predicate-phrase", {
      head: {}, valence: {}, cont: { guard: {
        expression: { kind: "coordination", operator: tail.operator, parts },
        ...(first.licensesBareIf || tail.licensesBareIf ? { licensesBareIf: true as const } : {})
      } }
    }, this.id);
  }
};

/** IF/UNLESS selects a complete predicate; bare symptom IF remains PRN syntax. */
const MEDICATION_GUARD_HEAD: HpsgPhraseRule<GuardConstituentContext> = {
  id: "hpsg.cx.guard.head-predicate",
  combine(context, left, right) {
    const marker = left.synsem.cont.guard?.marker, predicate = right.synsem.cont.guard;
    if (!marker || !predicate?.expression) return undefined;
    const positive = guardPredicateValue(predicate.expression);
    if (marker === "if" && !predicate.licensesBareIf && !guardHasMeasurement(positive) &&
        !context.withholdingConsequent) return undefined;
    const condition: MedicationCondition = marker === "unless" ? { kind: "not", condition: positive } : positive;
    const result = guardMother(left, right, "medication-guard-phrase", {
      head: {}, valence: {}, cont: { clauseKind: "administration", clinicalAdjunct: {
        condition, localRanges: [context.range],
        ...(guardExpressionHasDayDomain(predicate.expression) ? { calendarDayCondition: condition } : {}),
        evidence: [{ rule: this.id, kind: "condition", ranges: [context.range] }]
      } }
    }, this.id, "left");
    if (result) result.score = 56 + result.consumedTokenIndices.length;
    return result;
  }
};

/** Attach already typed procedural withholding/target scope to the same guard
 * derivation. This retains the predicate daughters in the clause feature graph.
 * @param guard Selected conditional head/predicate analysis.
 * @param scope Existing clinical scope sign (including otherwise-hold ownership).
 */
export function scopeMedicationGuardSign(guard: ParsedMedicationGuard, scope: HpsgSign): HpsgSign {
  const dayPredicate = guard.sign.synsem.cont.clinicalAdjunct?.calendarDayCondition;
  const adjunct = scope.synsem.cont.clinicalAdjunct;
  const condition = adjunct?.condition;
  // A scoped HOLD can negate the guard. Invariance survives that operator,
  // but never transfers to a distinct or newly mixed clinical predicate.
  const retainsDayDomain = dayPredicate && condition && (
    equalStructuredValues(condition, dayPredicate) ||
    condition.kind === "not" && equalStructuredValues(condition.condition, dayPredicate) ||
    dayPredicate.kind === "not" && equalStructuredValues(dayPredicate.condition, condition));
  const synsem = retainsDayDomain ? { ...scope.synsem, cont: { ...scope.synsem.cont,
    clinicalAdjunct: { ...adjunct!, calendarDayCondition: condition } } } : scope.synsem;
  const result = guardMother(guard.sign, scope, "medication-guard-phrase", synsem,
    "hpsg.cx.guard.administration-scope", "left");
  if (!result) return scope;
  // Scope realization does not gain extra ranking weight merely for having
  // retained its derivation: candidate ranking remains source-meaning based.
  result.score = scope.score;
  return result;
}

/** Bounded predicate grammar driver. AND closes before OR; actual meanings and
 * ellipsis are contributed only by the typed phrase rules above. */
function guardPredicateConstituent(
  context: GuardConstituentContext, tokens: Token[], start: number, end: number
): HpsgSign | undefined {
  const tokenRange = (from: number, to: number) => tokens.filter(token => token.sourceStart < to && from < token.sourceEnd);
  const atom = (from: number, to: number): HpsgSign | undefined => {
    const members = tokenRange(from, to);
    if (!members.length) return undefined;
    const prefixLength = conditionNegationPrefixLength(context.source.slice(from, to));
    if (prefixLength !== undefined) {
      const negatorTokens = tokenRange(from, from + prefixLength);
      const complement = atom(from + prefixLength, to);
      if (negatorTokens.length && complement) {
        const negator = lexicalSign({ type: "guard-operator-sign", rule: "hpsg.lex.guard.predicate-negation",
          tokens: negatorTokens, synsem: { head: {}, valence: {}, cont: { guard: { operator: "not" } } }, score: 1 });
        return GUARD_NEGATED_PREDICATE.combine(context, negator, complement);
      }
    }
    return lexicalSign({ type: "guard-predicate-sign", rule: "hpsg.lex.guard.predicate-atom", tokens: members,
      synsem: { head: {}, valence: {}, cont: { guard: medicationConditionAtomLexeme(context.source.slice(from, to)) } }, score: members.length });
  };
  const whole = medicationConditionAtomLexeme(context.source.slice(start, end));
  if (whole.licensesBareIf && whole.expression?.kind === "predicate" &&
      whole.expression.value.kind === "text" && !whole.expression.dayInvariant) return atom(start, end);
  const nodes: HpsgSign[] = [], operators: HpsgSign[] = [];
  const reduce = (): boolean => {
    const operator = operators.pop(), right = nodes.pop(), left = nodes.pop();
    if (!operator || !right || !left) return false;
    const tail = GUARD_COORDINATOR_COMPLEMENT.combine(context, operator, right);
    const mother = tail && GUARD_PREDICATE_COORDINATION.combine(context, left, tail);
    if (!mother) return false;
    nodes.push(mother); return true;
  };
  for (const term of conditionSourceLexemes(context.source, start, end)) {
    if (!term.operator) {
      const sign = atom(term.start, term.end);
      if (!sign) return undefined;
      nodes.push(sign);
    } else {
      const members = tokenRange(term.start, term.end);
      if (!members.length || !nodes.length) return atom(start, end);
      while (operators.length && (operators[operators.length - 1].synsem.cont.guard?.operator === "all" || term.operator === "any")) {
        if (!reduce()) return atom(start, end);
      }
      operators.push(lexicalSign({ type: "guard-operator-sign", rule: "hpsg.lex.guard.boolean-operator", tokens: members,
        synsem: { head: {}, valence: {}, cont: { guard: { operator: term.operator } } }, score: 1 }));
    }
  }
  while (operators.length) if (!reduce()) return atom(start, end);
  return nodes.length === 1 ? nodes[0] : atom(start, end);
}

/** Single source of medication-guard meaning: lexical daughters compose via
 * HPSG predicate/coordination/head constructions, reused by planner and chart.
 * @param source Exact clinician text.
 * @param existingTokens Already-lexed tokens when the caller has a source context.
 * @param withholdingConsequent License supplied only by a typed medication-withholding action daughter.
 */
export function parseMedicationGuard(
  source: string, existingTokens?: Token[], withholdingConsequent?: true
): ParsedMedicationGuard | undefined {
  const lead = medicationGuardLeadLexeme(source, withholdingConsequent);
  if (!lead) return undefined;
  let tail = source.slice(lead.end), end = source.length;
  const alternateCue = MEDICATION_GUARD_BOUNDARIES.alternative.exec(tail);
  const alternative = alternateCue ? { start: lead.end + alternateCue.index,
    end: lead.end + alternateCue.index + alternateCue[0].length } : undefined;
  const noDose = MEDICATION_GUARD_BOUNDARIES.noDoseConsequent.exec(tail);
  const otherwise = noDose ? { start: lead.end + noDose.index,
    end: lead.end + noDose.index + noDose[0].length } : undefined;
  if (otherwise || alternative) {
    end = (otherwise ?? alternative)!.start;
    tail = source.slice(lead.end, end);
  }
  const prefix = source.slice(0, lead.start).trim();
  if (!prefix || /[.;!?]$/u.test(prefix)) {
    const comma = tail.search(/[,;:]/u), action = MEDICATION_GUARD_BOUNDARIES.administrationHead.exec(tail);
    end = Math.min(end, lead.end + Math.min(comma >= 0 ? comma : tail.length, action?.index ?? tail.length));
  } else end = Math.min(end, lead.end + medicationGuardClauseBoundary(tail));
  let predicateStart = lead.end, predicateEnd = end;
  while (predicateStart < predicateEnd && /\s/u.test(source[predicateStart])) predicateStart++;
  while (predicateEnd > predicateStart && /[\s.!?;,]/u.test(source[predicateEnd - 1])) predicateEnd--;
  if (predicateStart >= predicateEnd) return undefined;
  const tokens = existingTokens ?? annotateLexTokens(lexInput(source));
  const markerTokens = tokens.filter(token => token.sourceStart < lead.end && lead.start < token.sourceEnd);
  if (!markerTokens.length) return undefined;
  const context: GuardConstituentContext = { source, range: { start: lead.start, end },
    ...(withholdingConsequent ? { withholdingConsequent } : {}) };
  const marker = lexicalSign({ type: "guard-marker-sign", rule: "hpsg.lex.guard.marker", tokens: markerTokens,
    synsem: { head: {}, valence: {}, cont: { guard: { marker: lead.marker } } }, score: 1 });
  const predicate = guardPredicateConstituent(context, tokens, predicateStart, predicateEnd);
  const sign = predicate && MEDICATION_GUARD_HEAD.combine(context, marker, predicate);
  const condition = sign?.synsem.cont.clinicalAdjunct?.condition;
  return sign && condition ? { condition, start: lead.start, markerEnd: lead.end, end, text: source.slice(lead.start, end),
    otherwiseHold: Boolean(otherwise), ...(otherwise ? { otherwise } : {}),
    ...(alternative ? { alternative } : {}), sign } : undefined;
}

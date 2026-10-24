import { AdviceArgumentRole, AdviceForce, AdvicePolarity, type AdviceFrame } from "../types";
import type {
  HpsgConstruction,
  HpsgConstructionKind,
  HpsgConstructionOperation,
  HpsgSign,
  HpsgType
} from "./signature";
import { grammaticalCoordinationScopes } from "../regimen/grammar";
import type {
  BoundaryRelation,
  CoordinationScopeFacts,
  RegimenSemanticSelection
} from "../regimen/types";

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
}

export interface HpsgTimingAnchorCoordinationSelection
  extends HpsgConstructionSelection {
  id: "hpsg.cx.regimen.coordinated-timing-anchors";
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
    range.start <= condition.targetStart && range.end >= condition.targetEnd
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
          operation === "inherit-administration-head"
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
  if (!relationLicensed || !facts.adjacent ||
      !facts.leftComplete || !facts.rightComplete ||
      !facts.sameAdministration || !facts.compatibleMethod ||
      !facts.leftAnchorOnly || !facts.rightAnchorOnly ||
      !facts.sameScheduleContext || !facts.addsAnchor) {
    return undefined;
  }

  return {
    id: "hpsg.cx.regimen.coordinated-timing-anchors",
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

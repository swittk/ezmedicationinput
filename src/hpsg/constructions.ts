import type {
  HpsgConstruction,
  HpsgConstructionKind,
  HpsgConstructionOperation,
  HpsgSign,
  HpsgType
} from "./signature";

export interface HpsgConstructionSelection {
  motherType: HpsgType;
  construction: HpsgConstruction;
}

type SignTrait =
  | "any"
  | "condition"
  | "marker"
  | "administration-head"
  | "method-specialization"
  | "complement"
  | "adjunct"
  | "procedure"
  | "scope-target"
  | "marked";

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
  if (sign.synsem.head.method) {
    traits.add("administration-head");
    if (sign.synsem.head.method.text) traits.add("method-specialization");
    if (sign.synsem.head.method.headClass === "procedure") traits.add("procedure");
  }
  if (sign.synsem.head.route || sign.synsem.head.dose || sign.synsem.valence.site) traits.add("complement");
  if (
    sign.synsem.head.schedule ||
    sign.synsem.valence.prn ||
    sign.synsem.valence.instructions?.length ||
    sign.type === "adjustment-sign"
  ) traits.add("adjunct");
  if (sign.synsem.valence.patientInstruction || sign.construction?.kind === "procedure-sequence") {
    traits.add("procedure");
  }
  if (sign.synsem.valence.patientInstruction || sign.synsem.valence.instructions?.length) {
    traits.add("scope-target");
  }
  if (sign.construction?.kind === "head-marker") traits.add("marked");
  return traits;
}

const CONSTRUCTION_SCHEMAS: readonly ConstructionSchema[] = [
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
    headFrom: "non-marker"
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
    motherType: "coordination-phrase",
    kind: "coordination",
    left: ["marked"],
    right: ["any"],
    symmetric: true,
    headFrom: "administration-head",
    forbidLeft: ["condition"],
    forbidRight: ["condition"]
  },
  {
    motherType: "administration-clause",
    kind: "administration-clause",
    left: ["administration-head"],
    right: ["any"],
    symmetric: true,
    headFrom: "administration-head",
    forbidLeft: ["condition"],
    forbidRight: ["condition"]
  },
  {
    motherType: "clause-sign",
    kind: "generic",
    left: ["any"],
    right: ["any"],
    headFrom: "none",
    forbidLeft: ["condition"],
    forbidRight: ["condition"]
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
): { swapped: boolean } | undefined {
  const directAllowed = !forbidden(leftTraits, schema.forbidLeft) && !forbidden(rightTraits, schema.forbidRight);
  if (directAllowed && hasAll(leftTraits, schema.left) && hasAll(rightTraits, schema.right)) return { swapped: false };
  const swappedAllowed = !forbidden(leftTraits, schema.forbidRight) && !forbidden(rightTraits, schema.forbidLeft);
  if (schema.symmetric && swappedAllowed && hasAll(leftTraits, schema.right) && hasAll(rightTraits, schema.left)) return { swapped: true };
  return undefined;
}

function resolveHeadSide(
  source: HeadSource | undefined,
  leftTraits: Set<SignTrait>,
  rightTraits: Set<SignTrait>
): "left" | "right" | undefined {
  if (!source || source === "none") return undefined;
  if (source === "left" || source === "right") return source;
  if (source === "non-marker") return leftTraits.has("marker") ? "right" : "left";
  if (source === "administration-head") {
    if (leftTraits.has("administration-head") && !rightTraits.has("administration-head")) return "left";
    if (rightTraits.has("administration-head") && !leftTraits.has("administration-head")) return "right";
  }
  if (source === "method-specialization") {
    if (leftTraits.has("method-specialization") && !rightTraits.has("method-specialization")) return "left";
    if (rightTraits.has("method-specialization") && !leftTraits.has("method-specialization")) return "right";
  }
  if (source === "scope-target") {
    if (leftTraits.has("scope-target") && !leftTraits.has("condition")) return "left";
    if (rightTraits.has("scope-target") && !rightTraits.has("condition")) return "right";
  }
  return undefined;
}

export function selectHpsgConstruction(left: HpsgSign, right: HpsgSign): HpsgConstructionSelection | undefined {
  const leftTraits = signTraits(left);
  const rightTraits = signTraits(right);
  for (const schema of CONSTRUCTION_SCHEMAS) {
    if (!schemaMatches(schema, leftTraits, rightTraits)) continue;
    if (schema.operation === "scope" && !scopeRequirementSatisfied(left, right)) continue;
    return {
      motherType: schema.motherType,
      construction: {
        kind: schema.kind,
        operation: schema.operation ?? "unify",
        headSide: resolveHeadSide(schema.headFrom, leftTraits, rightTraits),
        leftType: left.type,
        rightType: right.type
      }
    };
  }
  return undefined;
}

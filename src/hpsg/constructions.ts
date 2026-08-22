import type {
  HpsgConstruction,
  HpsgConstructionKind,
  HpsgSign,
  HpsgType
} from "./signature";
import { HPSG_TYPE_SYSTEM } from "./type-system";

export interface HpsgConstructionSelection {
  motherType: HpsgType;
  construction: HpsgConstruction;
}

function hasMethod(sign: HpsgSign): boolean {
  return Boolean(sign.synsem.head.method);
}

function hasComplementSemantics(sign: HpsgSign): boolean {
  return Boolean(
    sign.synsem.head.route ||
    sign.synsem.head.dose ||
    sign.synsem.valence.site
  );
}

function hasAdjunctSemantics(sign: HpsgSign): boolean {
  return Boolean(
    sign.synsem.head.schedule ||
    sign.synsem.valence.prn ||
    sign.synsem.valence.instructions?.length
  );
}

function hasProcedureSemantics(sign: HpsgSign): boolean {
  return Boolean(
    sign.synsem.valence.patientInstruction ||
    sign.construction?.kind === "procedure-sequence"
  );
}

function isConditional(sign: HpsgSign): boolean {
  return sign.type === "conditional-sign" ||
    sign.construction?.kind === "conditional-instruction";
}

function isMarker(sign: HpsgSign): boolean {
  return sign.type === "connector-sign";
}

function headSide(left: HpsgSign, right: HpsgSign): "left" | "right" | undefined {
  if (hasMethod(left) && !hasMethod(right)) return "left";
  if (hasMethod(right) && !hasMethod(left)) return "right";
  if (HPSG_TYPE_SYSTEM.isSubtype(left.type, "headed-phrase") && !HPSG_TYPE_SYSTEM.isSubtype(right.type, "headed-phrase")) {
    return "left";
  }
  if (HPSG_TYPE_SYSTEM.isSubtype(right.type, "headed-phrase") && !HPSG_TYPE_SYSTEM.isSubtype(left.type, "headed-phrase")) {
    return "right";
  }
  return undefined;
}

function selection(
  motherType: HpsgType,
  kind: HpsgConstructionKind,
  left: HpsgSign,
  right: HpsgSign,
  head?: "left" | "right"
): HpsgConstructionSelection {
  return {
    motherType,
    construction: {
      kind,
      headSide: head,
      leftType: left.type,
      rightType: right.type
    }
  };
}

export function selectHpsgConstruction(
  left: HpsgSign,
  right: HpsgSign
): HpsgConstructionSelection {
  if (isConditional(left) || isConditional(right)) {
    const head = headSide(left, right);
    return selection("conditional-instruction-phrase", "conditional-instruction", left, right, head);
  }

  if (isMarker(left) || isMarker(right)) {
    const head = isMarker(left) ? "right" : "left";
    return selection("head-marker-phrase", "head-marker", left, right, head);
  }

  if (hasProcedureSemantics(left) && hasProcedureSemantics(right)) {
    return selection("procedure-sequence-phrase", "procedure-sequence", left, right);
  }

  const head = headSide(left, right);
  if (head) {
    const dependent = head === "left" ? right : left;
    if (hasComplementSemantics(dependent)) {
      return selection("head-complement-phrase", "head-complement", left, right, head);
    }
    if (hasAdjunctSemantics(dependent) || dependent.type === "adjustment-sign") {
      return selection("head-adjunct-phrase", "head-adjunct", left, right, head);
    }
    if (hasProcedureSemantics(dependent)) {
      return selection("administration-clause", "administration-clause", left, right, head);
    }
  }

  const leftMarker = left.construction?.kind === "head-marker";
  const rightMarker = right.construction?.kind === "head-marker";
  if (leftMarker || rightMarker) {
    return selection("coordination-phrase", "coordination", left, right, headSide(left, right));
  }

  if (hasMethod(left) || hasMethod(right)) {
    return selection("administration-clause", "administration-clause", left, right, headSide(left, right));
  }

  return selection("clause-sign", "generic", left, right);
}

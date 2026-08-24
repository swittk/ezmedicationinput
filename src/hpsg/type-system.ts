export interface HpsgAppropriateFeature {
  valueType: string;
  required?: boolean;
}

export interface HpsgTypeDefinition {
  name: string;
  parents?: string[];
  features?: Record<string, HpsgAppropriateFeature>;
}

export type HpsgFeatureValue = HpsgFeatureNode | HpsgFeatureAtom;

export interface HpsgFeatureNode {
  kind: "node";
  type: string;
  features: Record<string, HpsgFeatureValue>;
}

export interface HpsgFeatureAtom {
  kind: "atom";
  type: "atom" | "string" | "number" | "boolean" | "json";
  value: unknown;
}

export interface HpsgFeatureValidationIssue {
  path: string;
  message: string;
}

export interface HpsgUnificationResult {
  value?: HpsgFeatureValue;
  issues: HpsgFeatureValidationIssue[];
}

export class HpsgTypeSystem {
  private readonly definitions = new Map<string, HpsgTypeDefinition>();
  private readonly subtypeCache = new Map<string, boolean>();
  private readonly appropriateCache = new Map<string, Record<string, HpsgAppropriateFeature>>();
  private readonly compatibleTypeCache = new Map<string, string | null>();

  constructor(definitions: HpsgTypeDefinition[] = []) {
    for (const definition of definitions) this.addType(definition);
  }

  addType(definition: HpsgTypeDefinition): void {
    if (!definition.name) throw new Error("HPSG type name cannot be empty.");
    this.subtypeCache.clear();
    this.appropriateCache.clear();
    this.compatibleTypeCache.clear();
    this.definitions.set(definition.name, {
      name: definition.name,
      parents: (definition.parents ?? []).slice(),
      features: definition.features ? { ...definition.features } : undefined
    });
  }

  hasType(type: string): boolean {
    return this.definitions.has(type);
  }

  definition(type: string): HpsgTypeDefinition | undefined {
    return this.definitions.get(type);
  }

  isSubtype(actual: string, expected: string): boolean {
    if (actual === expected) return true;
    const cacheKey = `${actual}\u0000${expected}`;
    const cached = this.subtypeCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const visited = new Set<string>();
    const agenda = [actual];
    let result = false;
    while (agenda.length) {
      const current = agenda.pop() as string;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const parent of this.definitions.get(current)?.parents ?? []) {
        if (parent === expected) {
          result = true;
          agenda.length = 0;
          break;
        }
        agenda.push(parent);
      }
    }
    this.subtypeCache.set(cacheKey, result);
    return result;
  }

  mostSpecificCompatibleType(left: string, right: string): string | undefined {
    const cacheKey = left <= right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
    const cached = this.compatibleTypeCache.get(cacheKey);
    if (cached !== undefined) return cached ?? undefined;
    if (this.isSubtype(left, right)) { this.compatibleTypeCache.set(cacheKey, left); return left; }
    if (this.isSubtype(right, left)) { this.compatibleTypeCache.set(cacheKey, right); return right; }
    const candidates = Array.from(this.definitions.keys()).filter((candidate) =>
      this.isSubtype(candidate, left) && this.isSubtype(candidate, right)
    );
    if (!candidates.length) { this.compatibleTypeCache.set(cacheKey, null); return undefined; }
    candidates.sort((a, b) => {
      if (this.isSubtype(a, b) && !this.isSubtype(b, a)) return -1;
      if (this.isSubtype(b, a) && !this.isSubtype(a, b)) return 1;
      return a.localeCompare(b);
    });
    const result = candidates[0];
    this.compatibleTypeCache.set(cacheKey, result);
    return result;
  }

  appropriateFeatures(type: string): Record<string, HpsgAppropriateFeature> {
    const cached = this.appropriateCache.get(type);
    if (cached) return cached;
    const result: Record<string, HpsgAppropriateFeature> = {};
    const visited = new Set<string>();
    const apply = (current: string) => {
      if (visited.has(current)) return;
      visited.add(current);
      const definition = this.definitions.get(current);
      for (const parent of definition?.parents ?? []) apply(parent);
      for (const key of Object.keys(definition?.features ?? {})) {
        result[key] = (definition?.features as Record<string, HpsgAppropriateFeature>)[key];
      }
    };
    apply(type);
    this.appropriateCache.set(type, result);
    return result;
  }
}

export function featureNode(type: string, features: Record<string, HpsgFeatureValue> = {}): HpsgFeatureNode {
  return { kind: "node", type, features };
}

export function featureAtom(value: unknown, type?: HpsgFeatureAtom["type"]): HpsgFeatureAtom {
  const inferred = type ?? (
    typeof value === "string" ? "string" :
    typeof value === "number" ? "number" :
    typeof value === "boolean" ? "boolean" :
    "json"
  );
  return { kind: "atom", type: inferred, value };
}


export function validateFeatureStructureShallow(
  value: HpsgFeatureNode,
  typeSystem: HpsgTypeSystem,
  path = "$"
): HpsgFeatureValidationIssue[] {
  const definition = typeSystem.definition(value.type);
  if (!definition) return [{ path, message: `Unknown feature-structure type ${value.type}.` }];
  const appropriate = typeSystem.appropriateFeatures(value.type);
  const issues: HpsgFeatureValidationIssue[] = [];
  for (const feature of Object.keys(value.features)) {
    const spec = appropriate[feature];
    if (!spec) {
      issues.push({ path: `${path}.${feature}`, message: `Feature ${feature} is not appropriate for type ${value.type}.` });
      continue;
    }
    const child = value.features[feature];
    if (!typeSystem.isSubtype(child.type, spec.valueType)) {
      issues.push({ path: `${path}.${feature}`, message: `Feature ${feature} expects ${spec.valueType}, got ${child.type}.` });
    }
  }
  for (const feature of Object.keys(appropriate)) {
    if (appropriate[feature].required && value.features[feature] === undefined) {
      issues.push({ path, message: `Required feature ${feature} is missing from type ${value.type}.` });
    }
  }
  return issues;
}

export function validateFeatureStructure(
  value: HpsgFeatureValue,
  typeSystem: HpsgTypeSystem,
  path = "$",
  visited = new Set<HpsgFeatureNode>()
): HpsgFeatureValidationIssue[] {
  if (value.kind === "atom") {
    return typeSystem.hasType(value.type)
      ? []
      : [{ path, message: `Unknown atom type ${value.type}.` }];
  }
  if (visited.has(value)) return [];
  visited.add(value);
  const definition = typeSystem.definition(value.type);
  if (!definition) return [{ path, message: `Unknown feature-structure type ${value.type}.` }];
  const appropriate = typeSystem.appropriateFeatures(value.type);
  const issues: HpsgFeatureValidationIssue[] = [];
  for (const feature of Object.keys(value.features)) {
    const spec = appropriate[feature];
    if (!spec) {
      issues.push({ path: `${path}.${feature}`, message: `Feature ${feature} is not appropriate for type ${value.type}.` });
      continue;
    }
    const child = value.features[feature];
    if (!typeSystem.isSubtype(child.type, spec.valueType)) {
      issues.push({ path: `${path}.${feature}`, message: `Feature ${feature} expects ${spec.valueType}, got ${child.type}.` });
    }
    issues.push(...validateFeatureStructure(child, typeSystem, `${path}.${feature}`, visited));
  }
  for (const feature of Object.keys(appropriate)) {
    if (appropriate[feature].required && value.features[feature] === undefined) {
      issues.push({ path, message: `Required feature ${feature} is missing from type ${value.type}.` });
    }
  }
  return issues;
}

function atomValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function unifyFeatureStructures(
  left: HpsgFeatureValue,
  right: HpsgFeatureValue,
  typeSystem: HpsgTypeSystem
): HpsgUnificationResult {
  const pairMemo = new Map<HpsgFeatureNode, Map<HpsgFeatureNode, HpsgFeatureNode>>();
  const cloneMemo = new Map<HpsgFeatureNode, HpsgFeatureNode>();
  const issues: HpsgFeatureValidationIssue[] = [];

  const cloneValue = (value: HpsgFeatureValue): HpsgFeatureValue => {
    if (value.kind === "atom") return { ...value };
    const cached = cloneMemo.get(value);
    if (cached) return cached;
    const clone = featureNode(value.type);
    cloneMemo.set(value, clone);
    for (const key of Object.keys(value.features)) clone.features[key] = cloneValue(value.features[key]);
    return clone;
  };

  const unify = (a: HpsgFeatureValue, b: HpsgFeatureValue, path: string): HpsgFeatureValue | undefined => {
    const unifiedType = typeSystem.mostSpecificCompatibleType(a.type, b.type);
    if (!unifiedType) {
      issues.push({ path, message: `Incompatible types ${a.type} and ${b.type}.` });
      return undefined;
    }
    if (a.kind === "atom" || b.kind === "atom") {
      if (a.kind !== "atom" || b.kind !== "atom" || !atomValuesEqual(a.value, b.value)) {
        issues.push({ path, message: "Feature atom values conflict." });
        return undefined;
      }
      return featureAtom(a.value, unifiedType as HpsgFeatureAtom["type"]);
    }
    const byRight = pairMemo.get(a);
    const memoized = byRight?.get(b);
    if (memoized) return memoized;
    const result = featureNode(unifiedType);
    if (byRight) byRight.set(b, result);
    else pairMemo.set(a, new Map([[b, result]]));
    const keys = new Set([...Object.keys(a.features), ...Object.keys(b.features)]);
    for (const key of Array.from(keys)) {
      const av = a.features[key];
      const bv = b.features[key];
      if (av && bv) {
        const merged = unify(av, bv, `${path}.${key}`);
        if (!merged) return undefined;
        result.features[key] = merged;
      } else if (av) result.features[key] = cloneValue(av);
      else if (bv) result.features[key] = cloneValue(bv);
    }
    return result;
  };

  const value = unify(left, right, "$HPSG");
  if (!value) return { issues };
  const validation = validateFeatureStructure(value, typeSystem);
  if (validation.length) return { issues: [...issues, ...validation] };
  return { value, issues };
}

export function canonicalFeatureStructure(value: HpsgFeatureValue): string {
  const ids = new Map<HpsgFeatureNode, number>();
  let nextId = 1;
  const encode = (current: HpsgFeatureValue): unknown => {
    if (current.kind === "atom") return { atom: current.type, value: current.value };
    const existing = ids.get(current);
    if (existing) return { ref: existing };
    const id = nextId++;
    ids.set(current, id);
    const features: Record<string, unknown> = {};
    for (const key of Object.keys(current.features).sort()) features[key] = encode(current.features[key]);
    return { id, type: current.type, features };
  };
  return JSON.stringify(encode(value));
}


const SIGN_TYPES = [
  "method-sign", "route-sign", "site-sign", "dose-sign", "schedule-sign",
  "prn-sign", "instruction-sign", "conditional-sign", "adjustment-sign", "connector-sign"
];

export const HPSG_TYPE_SYSTEM = new HpsgTypeSystem([
  { name: "top" },
  { name: "atom", parents: ["top"] },
  { name: "string", parents: ["atom"] },
  { name: "number", parents: ["atom"] },
  { name: "boolean", parents: ["atom"] },
  { name: "json", parents: ["atom"] },
  { name: "sign", parents: ["top"], features: { SYNSEM: { valueType: "synsem", required: true } } },
  { name: "word-sign", parents: ["sign"] },
  {
    name: "phrase-sign",
    parents: ["sign"],
    features: {
      LEFT_DTR: { valueType: "sign" },
      RIGHT_DTR: { valueType: "sign" }
    }
  },
  {
    name: "headed-phrase",
    parents: ["phrase-sign"],
    features: {
      HEAD_DTR: { valueType: "sign", required: true },
      NON_HEAD_DTR: { valueType: "sign", required: true }
    }
  },
  { name: "head-complement-phrase", parents: ["headed-phrase"] },
  { name: "head-adjunct-phrase", parents: ["headed-phrase"] },
  { name: "head-marker-phrase", parents: ["headed-phrase"] },
  { name: "procedure-sequence-phrase", parents: ["phrase-sign"] },
  { name: "conditional-instruction-phrase", parents: ["phrase-sign"] },
  { name: "coordination-phrase", parents: ["phrase-sign"] },
  { name: "clause-sign", parents: ["phrase-sign"] },
  { name: "administration-clause", parents: ["clause-sign", "headed-phrase"] },
  ...SIGN_TYPES.map((name) => ({ name, parents: ["word-sign"] })),
  {
    name: "synsem",
    parents: ["top"],
    features: {
      HEAD: { valueType: "head", required: true },
      VALENCE: { valueType: "valence", required: true },
      CONT: { valueType: "content", required: true },
      NONLOC: { valueType: "nonlocal", required: true }
    }
  },
  {
    name: "head",
    parents: ["top"],
    features: {
      METHOD: { valueType: "method-feature" },
      ROUTE: { valueType: "route-feature" },
      DOSE: { valueType: "dose-feature" },
      SCHEDULE: { valueType: "schedule-feature" }
    }
  },
  {
    name: "valence",
    parents: ["top"],
    features: {
      SITE: { valueType: "site-feature" },
      PRN: { valueType: "prn-feature" },
      INSTRUCTIONS: { valueType: "instruction-feature" },
      PATIENT_INSTRUCTION: { valueType: "patient-instruction-feature" }
    }
  },
  {
    name: "content",
    parents: ["top"],
    features: {
      CLAUSE_KIND: { valueType: "string" },
      CONDITION: { valueType: "condition-feature" },
      SCOPED_ADMINISTRATION: { valueType: "scoped-administration-feature" },
      SCOPE_CLOSED: { valueType: "boolean" }
    }
  },
  { name: "method-feature", parents: ["top"] },
  { name: "route-feature", parents: ["top"] },
  { name: "dose-feature", parents: ["top"] },
  { name: "schedule-feature", parents: ["top"] },
  { name: "site-feature", parents: ["top"] },
  { name: "prn-feature", parents: ["top"] },
  { name: "instruction-feature", parents: ["top"] },
  { name: "patient-instruction-feature", parents: ["top"] },
  { name: "condition-feature", parents: ["top"] },
  { name: "scoped-administration-feature", parents: ["top"] },
  {
    name: "nonlocal",
    parents: ["top"],
    features: { SCOPE_REQUIREMENT: { valueType: "scope-requirement-feature" } }
  },
  { name: "scope-requirement-feature", parents: ["top"] }
]);

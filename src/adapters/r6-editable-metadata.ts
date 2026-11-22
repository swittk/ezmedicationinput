/**
 * R6-only serialization of editable information that has no active core slot.
 * These annotations contain current FHIR fragments, never a persisted native
 * model. Draft steps remain source data; a one-step safety projection records
 * its original scope so an unchanged export can be reopened for editing.
 */
import type {
  FhirExtension, FhirR6DosageInstruction, FhirR6DosageInstructionInput,
  FhirR6DosageSafety, FhirR6DosageStep, FhirR6DoseLimit, FhirR6Ratio,
} from "../types";
import { equalStructuredValues, hashStructuredValue } from "../stable-structure";
import { getQuantityComparator, quantityForR5 as generalQuantityForR5, simpleQuantityForR5 } from "../fhir-quantity-operator";
import { encodeR6SourceMetadata, decodeR6SourceMetadata, compactProjectionFingerprint, DOSAGE_RECONCILIATION_SOURCE_URL } from "../dosage-course";

export const R6_DRAFT_STEPS_SOURCE_URL = "urn:ezmedicationinput:r6-draft-steps-source";
export const R6_SINGLE_STEP_SAFETY_SOURCE_URL = "urn:ezmedicationinput:r6-single-step-safety-source";
export const R6_SCOPED_SAFETY_MODIFIER_URL = "urn:ezmedicationinput:r6-scoped-safety-policy";

function replaceSource(owner: { extension?: FhirExtension[] }, url: string, value: object | undefined): void {
  const extensions = owner.extension?.filter(item => item.url !== url) ?? [];
  const prior = owner.extension?.filter(item => item.url === url) ?? [];
  if (value !== undefined) {
    const kind = url === R6_DRAFT_STEPS_SOURCE_URL ? "drafts" : "safety";
    let retained: Record<string, unknown> | undefined;
    if (prior[0]) {
      try { retained = decodeR6SourceMetadata(prior[0], kind); }
      catch { /* Unreadable external source is retained below, never executed. */ }
    }
    // Current known fields overwrite the snapshot; decoded unfamiliar children
    // and the marker's own Element metadata remain recoverable source data.
    const next = { ...retained, ...value };
    // An unchanged snapshot still owns its exact typed child wrappers, including
    // authored Element IDs. Rebuilding it would erase that external metadata.
    const unchanged = retained !== undefined && equalStructuredValues(retained, next);
    const retired = prior.slice(unchanged ? 1 : 0);
    if (retired.length) extensions.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: retired });
    extensions.push(unchanged ? prior[0] : encodeR6SourceMetadata(url, next, kind));
  }
  if (extensions.length) owner.extension = extensions;
  else delete owner.extension;
}

/** Retired external source remains inert and recoverable. It must no longer
 * supply hidden timing/safety after a live wire edit, but must not disappear. */
function retireSource(owner: { extension?: FhirExtension[] }, url: string): void {
  const markers = owner.extension?.filter(item => item.url === url);
  if (!markers?.length) return;
  const kept = owner.extension!.filter(item => item.url !== url);
  kept.push({ url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: markers });
  owner.extension = kept;
}

export function retainDraftSteps(
  output: FhirR6DosageInstruction,
  drafts: Array<{ index: number; step: Omit<FhirR6DosageStep, "component"> }> | undefined,
  synthesizedStarts?: number[]
): void {
  if (drafts?.length)
    replaceSource(output, R6_DRAFT_STEPS_SOURCE_URL, { drafts, synthesizedStarts, projected: output.step ?? [] });
  else if (output.extension?.some(item => item.url === R6_DRAFT_STEPS_SOURCE_URL))
    retireSource(output, R6_DRAFT_STEPS_SOURCE_URL);
}

/** A pause belongs to the ordered phase boundaries, not its successor's dose.
 * Changed anonymous stages need a unique boundary identity; position alone
 * cannot prove which stage survived a deletion, replacement or reordering. */
function sameDraftStageOwnership(active: FhirR6DosageStep[], saved: FhirR6DosageStep[], firstIsTreatmentOrigin: boolean): boolean {
  if (!Array.isArray(saved) || active.length !== saved.length) return false;
  // Unchanged projections need no identity index or boundary hashes. Remember
  // the compared prefix so reconciliation never deep-walks those stages twice.
  let firstChanged = 0;
  while (firstChanged < saved.length && equalStructuredValues(saved[firstChanged], active[firstChanged]))
    firstChanged++;
  if (firstChanged === saved.length) return true;
  const identities = new Map<string, number>();
  const changed: string[] = [];
  for (let index = 0; index < saved.length; index++) {
    const prior = saved[index], current = active[index];
    const identity = prior.id !== undefined ? "id:" + prior.id :
      prior.start || prior.end ? "boundary:" + compactProjectionFingerprint({
        start: prior.start, end: prior.end, count: prior.count,
      }) : index === 0 && firstIsTreatmentOrigin ? "treatment-origin" : undefined;
    if (identity !== undefined) identities.set(identity, (identities.get(identity) ?? 0) + 1);
    if (index < firstChanged || index > firstChanged && equalStructuredValues(prior, current)) continue;
    if (identity === undefined || prior.id !== current.id || prior.count !== current.count ||
        !equalStructuredValues(prior.start, current.start) ||
        !equalStructuredValues(prior.end, current.end) ||
        prior.component.length !== current.component.length) return false;
    // A phase can finish through its member timing (count, duration or bounds)
    // without an explicit step.end. Dose edits leave that declared completion.
    for (let member = 0; member < prior.component.length; member++)
      if (prior.component[member].id !== current.component[member].id ||
          !prior.end && !equalStructuredValues(prior.component[member].timing, current.component[member].timing))
        return false;
    changed.push(identity);
  }
  for (const identity of changed) if (identities.get(identity) !== 1) return false;
  return true;
}

/** Restore inactive editable stages while their active phase owners and
 * boundaries still agree. Current doses and other live fields stay current. */
export function editableCourseSteps(input: FhirR6DosageInstructionInput): FhirR6DosageStep[] {
  const active = input.step ?? [];
  const marker = input.extension?.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL);
  if (!marker) return active;
  try {
    const saved = decodeR6SourceMetadata(marker, "drafts") as {
      drafts: Array<{ index: number; step: Omit<FhirR6DosageStep, "component"> }>;
      projected: FhirR6DosageStep[];
      synthesizedStarts?: number[];
    } | undefined;
    if (!saved || !Array.isArray(saved.drafts) || !sameDraftStageOwnership(active, saved.projected, saved.drafts[0]?.index !== 0)) return active;
    const restored: FhirR6DosageStep[] = [];
    const inferred = new Set(saved.synthesizedStarts ?? []);
    let draft = 0, member = 0;
    for (let index = 0; index < active.length + saved.drafts.length; index++) {
      const next = saved.drafts[draft];
      if (next?.index === index) {
        restored.push({ ...next.step, component: [] });
        draft++;
      } else if (member < active.length) {
        if (inferred.has(member)) {
          const step = { ...active[member] };
          delete step.start;
          restored.push(step);
        } else restored.push(active[member]);
        member++;
      }
    }
    return restored;
  } catch { return active; }
}

/** Indices from the current external draft source, for R5 membership edits. */
export function retainedDraftStepIndices(input: { extension?: FhirExtension[] }): readonly number[] | undefined {
  const marker = input.extension?.find(item => item.url === R6_DRAFT_STEPS_SOURCE_URL);
  if (!marker) return undefined;
  const saved = decodeR6SourceMetadata(marker, "drafts");
  return Array.isArray(saved?.drafts)
    ? (saved.drafts as Array<{ index: number }>).map(draft => draft.index) : undefined;
}

interface LiftedSafety {
  course?: FhirR6DosageSafety;
  step: FhirR6DosageSafety;
  projected: FhirR6DosageSafety;
  ownerId?: string;
  ownerComponentIds?: string[];
  ownerFingerprint?: string;
  /** Resolved current wire owner; never part of the serialized source record. */
  owner?: FhirR6DosageStep;
}

function stepOwnerFingerprint(step: FhirR6DosageStep): string {
  if (!step.safety) return compactProjectionFingerprint(step);
  const { safety: _policy, ...projected } = step;
  return compactProjectionFingerprint(projected);
}

/** Only a matching live policy can reuse its saved scope. A later wire edit
 * replaces that authority rather than reviving an old safety instruction. */
export function retainedSingleStepSafety(input: FhirR6DosageInstructionInput): LiftedSafety | undefined {
  const marker = input.extension?.find(item => item.url === R6_SINGLE_STEP_SAFETY_SOURCE_URL);
  if (!marker) return undefined;
  try {
    const saved = decodeR6SourceMetadata(marker, "safety") as unknown as LiftedSafety | undefined;
    const current = input.safety;
    if (!saved?.step || !current || current.ifExceeded !== saved.projected.ifExceeded ||
        !equalStructuredValues(current.doseLimit, saved.projected.doseLimit) ||
        !equalStructuredValues(current.modifierExtension, saved.projected.modifierExtension)) return undefined;
    // Header Element metadata follows the policy that supplied the projection.
    // Changing its ID or ordinary annotations does not widen a phase's limits.
    let course = saved.course, step = saved.step;
    if (course) {
      const { doseLimit: _limits, ifExceeded: _action, modifierExtension: _modifiers, ...metadata } = current;
      course = { ...metadata,
        ...(course.doseLimit !== undefined ? { doseLimit: course.doseLimit } : {}),
        ...(course.ifExceeded !== undefined ? { ifExceeded: course.ifExceeded } : {}),
        ...(course.modifierExtension !== undefined ? { modifierExtension: course.modifierExtension } : {}) };
    } else step = current;
    const retained = { ...saved, course, step };
    let owner: FhirR6DosageStep | undefined;
    const componentIds = saved.ownerComponentIds?.length ? new Set(saved.ownerComponentIds) : undefined;
    if (saved.ownerId === undefined && !componentIds && saved.ownerFingerprint === undefined) {
      // Unidentified source records retain their existing single-step meaning.
      if (input.step?.length === 1) owner = input.step[0];
    } else for (const candidate of input.step ?? []) {
      const matches = saved.ownerId !== undefined ? candidate.id === saved.ownerId
        : componentIds ? candidate.id === undefined && candidate.component.some(member => member.id !== undefined && componentIds.has(member.id))
        : stepOwnerFingerprint(candidate) === saved.ownerFingerprint;
      if (!matches) continue;
      if (owner) return retained;
      owner = candidate;
    }
    // The unchanged header is still only a projection when its step vanishes.
    // Keep the authored course policy, and retain the retired step policy in
    // its source record; it must never be promoted into course authority.
    return { ...retained, owner };
  } catch { return undefined; }
}

/** A live edit to lifted safety also owns the active scoped modifier. Keep
 * qualifiers attached to surviving limits, never to a superseded snapshot. */
function reconcileScopedSafety(safety: FhirR6DosageSafety | undefined): void {
  if (!safety?.modifierExtension?.length) return;
  const current = safety.doseLimit ?? [];
  let modifiers: FhirExtension[] | undefined;
  let retired: FhirExtension[] | undefined;
  for (let index = 0; index < safety.modifierExtension.length; index++) {
    const marker = safety.modifierExtension[index];
    let replacement = marker;
    if (marker.url === R6_SCOPED_SAFETY_MODIFIER_URL) {
      const saved = decodeR6SourceMetadata(marker, "safety") as {
        course?: FhirR6DosageSafety; step?: FhirR6DosageSafety;
      } | undefined;
      if (saved) {
        const courseAction = saved.course?.ifExceeded, stepAction = saved.step?.ifExceeded;
        const combinedAction = stepAction && stepAction !== courseAction
          ? courseAction ? courseAction + "\n" + stepAction : stepAction : courseAction;
        const sameShape = (left: FhirR6DoseLimit, right: FhirR6DoseLimit): boolean => {
          const a = left.valueQuantity, b = right.valueQuantity, ap = left.period, bp = right.period;
          return left.scope === right.scope && (a !== undefined) === (b !== undefined) &&
            (left.valueInteger !== undefined) === (right.valueInteger !== undefined) &&
            (left.valueExpression !== undefined) === (right.valueExpression !== undefined) &&
            a?.system === b?.system && a?.code === b?.code &&
            (a?.system && a.code ? true : a?.unit === b?.unit) &&
            ap?.value === bp?.value && ap?.system === bp?.system && ap?.code === bp?.code &&
            (ap?.system && ap.code ? true : ap?.unit === bp?.unit) &&
            getQuantityComparator(ap) === getQuantityComparator(bp);
        };
        const claimed = new Set<FhirR6DoseLimit>();
        const matches = new Map<FhirR6DoseLimit, FhirR6DoseLimit>();
        const shapeMatch = (limit: FhirR6DoseLimit): FhirR6DoseLimit | undefined => {
          // Only unmatched anonymous edits need this short clinical comparison.
          // No object serialization or opaque metadata participates in identity.
          let replacement: FhirR6DoseLimit | undefined;
          for (const item of current) if (!claimed.has(item) && sameShape(limit, item) &&
              (!item.id || !sourceIds.has(item.id) &&
                item.valueQuantity?.value === limit.valueQuantity?.value &&
                getQuantityComparator(item.valueQuantity) === getQuantityComparator(limit.valueQuantity) &&
                item.valueInteger === limit.valueInteger &&
                equalStructuredValues(item.valueExpression, limit.valueExpression))) {
            if (replacement) return undefined;
            replacement = item;
          }
          if (!replacement) return undefined;
          let sourceCount = 0;
          for (const item of sourceGroups.keys())
            if (sameShape(limit, item) && ++sourceCount > 1) return undefined;
          return sourceCount === 1 ? replacement : undefined;
        };
        // Exact-equal anonymous limits still have distinct scope ownership.
        // Count each equality bucket once on both sides before assigning it;
        // one surviving copy cannot inherit two independent policy qualifiers.
        type ExactLimits = { sample: FhirR6DoseLimit; sourceCount: number;
          live: FhirR6DoseLimit[]; cursor: number };
        const exactBuckets = new Map<number, ExactLimits[]>();
        const sourceGroups = new Map<FhirR6DoseLimit, ExactLimits>();
        const exactGroup = (limit: FhirR6DoseLimit): ExactLimits => {
          const key = hashStructuredValue(limit);
          let bucket = exactBuckets.get(key);
          if (!bucket) exactBuckets.set(key, bucket = []);
          for (const group of bucket) if (equalStructuredValues(group.sample, limit)) return group;
          const group = { sample: limit, sourceCount: 0, live: [], cursor: 0 };
          bucket.push(group);
          return group;
        };
        const liveIds = new Map<string, FhirR6DoseLimit | undefined>();
        const sourceIds = new Map<string, number>();
        for (const limit of current) {
          exactGroup(limit).live.push(limit);
          if (limit.id) liveIds.set(limit.id, liveIds.has(limit.id) ? undefined : limit);
        }
        for (const policy of [saved.course, saved.step])
          for (const limit of policy?.doseLimit ?? []) {
            const group = exactGroup(limit);
            group.sourceCount++;
            sourceGroups.set(limit, group);
            if (limit.id) sourceIds.set(limit.id, (sourceIds.get(limit.id) ?? 0) + 1);
          }
        // Reserve exact survivors and unique declared identities across BOTH
        // policies before any anonymous edit can claim a live clinical shape.
        for (const [limit, group] of sourceGroups) {
          const exact = group.sourceCount === group.live.length ? group.live[group.cursor++] : undefined;
          const replacement = exact ?? (group.live.length === 0 && limit.id && sourceIds.get(limit.id) === 1
            ? liveIds.get(limit.id) : undefined);
          if (replacement && !claimed.has(replacement)) {
            matches.set(limit, replacement);
            claimed.add(replacement);
          }
        }
        const reconcile = (policy: FhirR6DosageSafety | undefined) => {
          if (!policy) return policy;
          let changed = false;
          const limits: FhirR6DoseLimit[] = [];
          for (const limit of policy.doseLimit ?? []) {
            const group = sourceGroups.get(limit)!;
            const assigned = matches.get(limit);
            if (assigned) {
              limits.push(assigned);
              if (group.sourceCount !== group.live.length) changed = true;
              continue;
            }
            changed = true;
            // A changed multiplicity is not an amount edit. Neither an ID
            // fallback nor shape matching can prove which identical copy won.
            if (group.live.length || limit.id) continue;
            const replacement = shapeMatch(limit);
            if (replacement) {
              limits.push(replacement);
              matches.set(limit, replacement);
              claimed.add(replacement);
            }
          }
          const action = policy.ifExceeded;
          const keepAction = action === undefined || safety.ifExceeded === action ||
            safety.ifExceeded === combinedAction;
          if (!changed && keepAction) return policy;
          const next = { ...policy };
          if (limits.length) next.doseLimit = limits;
          else delete next.doseLimit;
          if (!keepAction) delete next.ifExceeded;
          return next;
        };
        const course = reconcile(saved.course), step = reconcile(saved.step);
        if (course !== saved.course || step !== saved.step) {
          const generated = encodeR6SourceMetadata(R6_SCOPED_SAFETY_MODIFIER_URL,
            { ...saved, course, step }, "safety");
          replacement = { ...marker, extension: marker.extension?.map(child => {
            if ((child.url !== "course" && child.url !== "step") ||
                (child.url === "course" && course === saved.course) ||
                (child.url === "step" && step === saved.step)) return child;
            const updated = generated.extension?.find(value => value.url === child.url);
            return updated ? { ...child, ...updated } : child;
          }) };
          (retired ??= []).push(marker);
        }
      }
    }
    if (replacement !== marker && !modifiers) modifiers = safety.modifierExtension.slice(0, index);
    modifiers?.push(replacement);
  }
  if (modifiers) safety.modifierExtension = modifiers;
  if (retired?.length) safety.extension = [...(safety.extension ?? []),
    { url: DOSAGE_RECONCILIATION_SOURCE_URL, extension: retired }];
}

export function liftSingleStepSafety(output: FhirR6DosageInstruction): void {
  const step = output.step?.length === 1 ? output.step[0] : undefined;
  const policy = step?.safety;
  if (!policy) {
    reconcileScopedSafety(output.safety);
    if (output.extension?.some(item => item.url === R6_SINGLE_STEP_SAFETY_SOURCE_URL))
      retireSource(output, R6_SINGLE_STEP_SAFETY_SOURCE_URL);
    return;
  }
  const course = output.safety;
  let projected = policy;
  if (course) {
    projected = { ...course };
    if (course.doseLimit || policy.doseLimit)
      projected.doseLimit = [...(course.doseLimit ?? []), ...(policy.doseLimit ?? [])];
    if (policy.ifExceeded && policy.ifExceeded !== course.ifExceeded)
      projected.ifExceeded = course.ifExceeded ? course.ifExceeded + "\n" + policy.ifExceeded : policy.ifExceeded;
    if (course.modifierExtension?.length || policy.modifierExtension?.length) {
      // R6 cannot carry sole-step safety. A must-understand wrapper keeps
      // each policy's modifiers scoped to its own limits/actions; flattening
      // either modifier list would qualify unrelated limits in the merge.
      projected.modifierExtension = [encodeR6SourceMetadata(R6_SCOPED_SAFETY_MODIFIER_URL,
        { course, step: policy }, "safety")];
    }
    // Distinct source IDs/annotations stay in the source record below. The
    // active policy includes every known limit and both authored actions.
  }
  let ownerComponentIds: string[] | undefined;
  if (step!.id === undefined) for (const member of step!.component)
    if (member.id !== undefined) (ownerComponentIds ??= []).push(member.id);
  // A lifted policy needs an identity that survives ordinary dose/timing edits.
  // Author-provided phase/component IDs remain authoritative. Only an otherwise
  // anonymous sole phase receives a wire Element.id; duplicate IDs stay ambiguous.
  if (step!.id === undefined && !ownerComponentIds)
    step!.id = "phase-" + stepOwnerFingerprint(step!);
  replaceSource(output, R6_SINGLE_STEP_SAFETY_SOURCE_URL, { course, step: policy, projected,
    ownerId: step!.id, ownerComponentIds });
  output.safety = projected;
  delete step!.safety;
}


/** Conflicting externally edited choices have no single active clinical meaning.
 * Keep every submitted value in typed source data, leaving the independent
 * dose/rate dimension available without inventing a winner for the conflict. */
export function retainConflictingAmountChoices(
  amount: Record<string, unknown>, doseConflict: boolean, rateConflict: boolean
): void {
  const retain = (kind: "dose" | "rate", fields: readonly (readonly [string, string])[]) => {
    const source: FhirExtension[] = [];
    for (const [field, valueKey] of fields) {
      if (amount[field] === undefined) continue;
      let value = amount[field];
      if (field === "rateRatio") {
        const ratio = value as FhirR6Ratio;
        value = { ...ratio,
          ...(ratio.numerator ? { numerator: generalQuantityForR5(ratio.numerator) } : {}),
          ...(ratio.denominator ? { denominator: simpleQuantityForR5(ratio.denominator) } : {}),
        };
      }
      source.push({ url: field, [valueKey]: value } as FhirExtension);
      delete amount[field];
    }
    amount.extension = [
      ...((amount.extension as FhirExtension[] | undefined) ?? []),
      { url: `urn:ezmedicationinput:r6-unresolved-${kind}-source`, extension: source },
    ];
  };
  if (doseConflict) retain("dose", [
    ["doseQuantity", "valueQuantity"], ["doseRange", "valueRange"], ["doseExpression", "valueExpression"],
  ]);
  if (rateConflict) retain("rate", [
    ["rateQuantity", "valueQuantity"], ["rateRange", "valueRange"],
    ["rateRatio", "valueRatio"], ["rateExpression", "valueExpression"],
  ]);
}

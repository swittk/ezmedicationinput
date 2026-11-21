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
import { equalStructuredValues } from "../stable-structure";
import { getQuantityComparator, quantityForR5 as generalQuantityForR5, simpleQuantityForR5 } from "../fhir-quantity-operator";
import { encodeR6SourceMetadata, decodeR6SourceMetadata, DOSAGE_RECONCILIATION_SOURCE_URL } from "../dosage-course";

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

/** Restore inactive editable stages only while the exported active course
 * still matches. Wire edits never acquire an old hidden stage boundary. */
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
    if (!saved || !Array.isArray(saved.drafts) || !equalStructuredValues(active, saved.projected)) return active;
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
}

/** Only a matching live policy can reuse its saved scope. A later wire edit
 * replaces that authority rather than reviving an old safety instruction. */
export function retainedSingleStepSafety(input: FhirR6DosageInstructionInput): LiftedSafety | undefined {
  if (input.step?.length !== 1) return undefined;
  const marker = input.extension?.find(item => item.url === R6_SINGLE_STEP_SAFETY_SOURCE_URL);
  if (!marker) return undefined;
  try {
    const saved = decodeR6SourceMetadata(marker, "safety") as unknown as LiftedSafety | undefined;
    return saved?.step && equalStructuredValues(input.safety, saved.projected) ? saved : undefined;
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
        const shapeMatch = (limit: FhirR6DoseLimit): FhirR6DoseLimit | undefined => {
          // Only unmatched anonymous edits need this short clinical comparison.
          // No object serialization or opaque metadata participates in identity.
          let replacement: FhirR6DoseLimit | undefined;
          for (const item of current) if (sameShape(limit, item)) {
            if (replacement) return undefined;
            replacement = item;
          }
          if (!replacement) return undefined;
          let sourceCount = 0;
          for (const item of saved.course?.doseLimit ?? [])
            if (sameShape(limit, item) && ++sourceCount > 1) return undefined;
          for (const item of saved.step?.doseLimit ?? [])
            if (sameShape(limit, item) && ++sourceCount > 1) return undefined;
          return sourceCount === 1 ? replacement : undefined;
        };
        const reconcile = (policy: FhirR6DosageSafety | undefined) => {
          if (!policy) return policy;
          let changed = false;
          const limits: FhirR6DoseLimit[] = [];
          for (const limit of policy.doseLimit ?? []) {
            // Exact unchanged values are unambiguous without IDs. An external
            // ID keeps its policy association when its live value is edited.
            const unchanged = current.find(value => equalStructuredValues(value, limit));
            if (unchanged) { limits.push(unchanged); continue; }
            changed = true;
            if (limit.id) {
              const matches = current.filter(value => value.id === limit.id);
              if (matches.length === 1) limits.push(matches[0]);
            } else {
              const replacement = shapeMatch(limit);
              if (replacement) limits.push(replacement);
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
  replaceSource(output, R6_SINGLE_STEP_SAFETY_SOURCE_URL, { course, step: policy, projected });
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

/**
 * R6-only serialization of editable information that has no active core slot.
 * These annotations contain current FHIR fragments, never a persisted native
 * model. Draft steps remain source data; a one-step safety projection records
 * its original scope so an unchanged export can be reopened for editing.
 */
import type {
  FhirExtension, FhirR6DosageInstruction, FhirR6DosageInstructionInput,
  FhirR6DosageSafety, FhirR6DosageStep,
} from "../types";
import { equalStructuredValues } from "../stable-structure";
import { encodeR6SourceMetadata, decodeR6SourceMetadata } from "../dosage-course";

export const R6_DRAFT_STEPS_SOURCE_URL = "urn:ezmedicationinput:r6-draft-steps-source";
export const R6_SINGLE_STEP_SAFETY_SOURCE_URL = "urn:ezmedicationinput:r6-single-step-safety-source";

function replaceSource(owner: { extension?: FhirExtension[] }, url: string, value: object | undefined): void {
  const extensions = owner.extension?.filter(item => item.url !== url) ?? [];
  if (value !== undefined) extensions.push(encodeR6SourceMetadata(url, value, url === R6_DRAFT_STEPS_SOURCE_URL ? "drafts" : "safety"));
  if (extensions.length) owner.extension = extensions;
  else delete owner.extension;
}

export function retainDraftSteps(
  output: FhirR6DosageInstruction,
  drafts: Array<{ index: number; step: Omit<FhirR6DosageStep, "component"> }> | undefined,
  synthesizedStarts?: number[]
): void {
  if (drafts?.length)
    replaceSource(output, R6_DRAFT_STEPS_SOURCE_URL, { drafts, synthesizedStarts, projected: output.step });
  else if (output.extension?.some(item => item.url === R6_DRAFT_STEPS_SOURCE_URL))
    replaceSource(output, R6_DRAFT_STEPS_SOURCE_URL, undefined);
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

export function liftSingleStepSafety(output: FhirR6DosageInstruction): void {
  const step = output.step.length === 1 ? output.step[0] : undefined;
  const policy = step?.safety;
  if (!policy) {
    if (output.extension?.some(item => item.url === R6_SINGLE_STEP_SAFETY_SOURCE_URL))
      replaceSource(output, R6_SINGLE_STEP_SAFETY_SOURCE_URL, undefined);
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
    // Distinct source IDs/annotations stay in the source record below. The
    // active policy includes every known limit and both authored actions.
  }
  replaceSource(output, R6_SINGLE_STEP_SAFETY_SOURCE_URL, { course, step: policy, projected });
  output.safety = projected;
  delete step!.safety;
}


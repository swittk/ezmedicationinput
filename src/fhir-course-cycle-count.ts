/** The finite repetition count belongs to the complete treatment course.
 * R6 step.count repeats one step; neither R5 nor R6 has a core course-count
 * slot, so both boundary adapters share this narrow modifier extension. */
import type { FhirExtension } from "./types";

export const COURSE_CYCLE_COUNT_EXTENSION_URL =
  "urn:ezmedicationinput:StructureDefinition:medication-course-cycle-count";

type CourseCountOwner = { modifierExtension?: FhirExtension[] };
function countValue(item: FhirExtension): number | undefined {
  return item.url === COURSE_CYCLE_COUNT_EXTENSION_URL &&
    Number.isInteger(item.valueInteger) && item.valueInteger! > 0
    ? item.valueInteger : undefined;
}

export function getCourseCycleCount(owner: CourseCountOwner): number | undefined {
  for (const item of owner.modifierExtension ?? []) {
    const count = countValue(item);
    if (count !== undefined) return count;
  }
  return undefined;
}

/** Write the current typed count while preserving unrelated modifiers and
 * metadata on an existing recognized count annotation. Output owns writes. */
export function setCourseCycleCount(owner: CourseCountOwner, count: number | undefined): void {
  const original = owner.modifierExtension;
  let found = false, changed: FhirExtension[] | undefined;
  for (let index = 0; index < (original?.length ?? 0); index++) {
    const item = original![index];
    if (countValue(item) === undefined) {
      changed?.push(item);
      continue;
    }
    found = true;
    if (count === item.valueInteger) changed?.push(item);
    else {
      changed ??= original!.slice(0, index);
      if (count !== undefined) changed.push({ ...item, valueInteger: count });
    }
  }
  if (!found && count !== undefined) {
    changed ??= original?.slice() ?? [];
    changed.push({ url: COURSE_CYCLE_COUNT_EXTENSION_URL, valueInteger: count });
  }
  if (changed) {
    if (changed.length) owner.modifierExtension = changed;
    else delete owner.modifierExtension;
  }
}

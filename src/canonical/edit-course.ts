/**
 * A clinician edit creates a new authoritative native course. Source grammar
 * and imported wire provenance are kept intact; automatically derived display
 * text must not overrule changed clinical fields. This operation runs ONLY
 * when explicitly requested, never on every parse or schedule query.
 */
import type { CanonicalCourse, CanonicalStage, CanonicalAdministration } from "./course";
import { cloneStructuredValue, equalStructuredValues } from "../stable-structure";

function clinicalAdministration(value: CanonicalAdministration): object {
  const { text: _text, syntax: _syntax, provenance: _source, ...facts } = value;
  return facts;
}
function clinicalStage(value: CanonicalStage): object {
  const { administrations: _members, provenance: _source, ...facts } = value;
  return facts;
}

/** Apply edits without changing the supplied course. Identity bindings are
 * created in one pass before the callback, so moving/deleting a draft member
 * does not accidentally attach another administration's display/provenance.
 * Explicitly replacing a text field is honored; only unchanged stale text
 * is cleared after a clinical edit. */
export function editCanonicalCourse(
  source: CanonicalCourse,
  edit: (draft: CanonicalCourse) => void
): CanonicalCourse {
  const draft = cloneStructuredValue(source);
  const stages = new Map<CanonicalStage, CanonicalStage>();
  const members = new Map<CanonicalAdministration, CanonicalAdministration>();
  for (let i = 0; i < draft.stages.length; i++) {
    stages.set(draft.stages[i], source.stages[i]);
    for (let j = 0; j < draft.stages[i].administrations.length; j++)
      members.set(draft.stages[i].administrations[j], source.stages[i].administrations[j]);
  }
  edit(draft);
  let changed =
    draft.stages.length !== source.stages.length ||
    !equalStructuredValues(draft.cycleInterval, source.cycleInterval) ||
    !equalStructuredValues(draft.constraints, source.constraints);
  for (let i = 0; i < draft.stages.length; i++) {
    const stage = draft.stages[i],
      before = stages.get(stage);
    if (
      !before ||
      before !== source.stages[i] ||
      stage.administrations.length !== before.administrations.length ||
      !equalStructuredValues(clinicalStage(stage), clinicalStage(before))
    )
      changed = true;
    for (let j = 0; j < stage.administrations.length; j++) {
      const a = stage.administrations[j],
        old = members.get(a);
      if (!old || old !== before?.administrations[j]) changed = true;
      if (old && !equalStructuredValues(clinicalAdministration(a), clinicalAdministration(old))) {
        changed = true;
        if (a.text === old.text) delete a.text;
      }
    }
  }
  if (changed && draft.instruction === source.instruction) delete draft.instruction;
  return draft;
}

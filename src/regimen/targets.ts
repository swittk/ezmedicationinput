import type {
  CanonicalAdministrationTargetGroup,
  CanonicalSigClause,
  CanonicalSiteExpr
} from "../types";

function cloneSite(site: CanonicalSiteExpr): CanonicalSiteExpr {
  return {
    ...site,
    i18n: site.i18n ? { ...site.i18n } : undefined,
    coding: site.coding ? {
      ...site.coding,
      i18n: site.coding.i18n ? { ...site.coding.i18n } : undefined
    } : undefined,
    spatialRelation: site.spatialRelation ? { ...site.spatialRelation } : undefined,
    ...(site.restrictions?.length ? {
      restrictions: site.restrictions.map(restriction => ({
        ...restriction,
        range: restriction.range ? { ...restriction.range } : undefined,
        markerRange: restriction.markerRange ? { ...restriction.markerRange } : undefined,
        predicate: {
          ...restriction.predicate,
          range: restriction.predicate.range ? { ...restriction.predicate.range } : undefined
        }
      }))
    } : {}),
    evidence: site.evidence?.map((item) => ({
      ...item,
      spans: item.spans.map((span) => ({ ...span }))
    })),
    range: site.range ? { ...site.range } : undefined
  };
}

function cloneGroup(
  group: CanonicalAdministrationTargetGroup
): CanonicalAdministrationTargetGroup {
  return {
    coordination: group.coordination,
    sourceText: group.sourceText,
    range: group.range ? { ...group.range } : undefined,
    targets: group.targets.map(cloneSite)
  };
}

/**
 * Return the FHIR projection alternatives licensed by the typed HPSG site
 * coordination. A disjunction is deliberately one retained canonical clause;
 * it is never converted into simultaneous administrations.
 */
export function administrationTargetProjections(
  clauses: readonly CanonicalSigClause[]
): Array<CanonicalSiteExpr | undefined> {
  const group = clauses.find((clause) => clause.administrationTargetGroup)
    ?.administrationTargetGroup;
  if (!group || group.coordination !== "conjunction" || group.targets.length < 2) {
    return [undefined];
  }
  return group.targets.map(cloneSite);
}

/** Pure pre-FHIR projection from one typed conjunction to one singular site. */
export function projectAdministrationTargetClauses(
  clauses: readonly CanonicalSigClause[],
  target: CanonicalSiteExpr | undefined
): CanonicalSigClause[] {
  if (!target) return clauses.slice();
  return clauses.map((clause) => {
    const group = clause.administrationTargetGroup;
    if (!group || group.coordination !== "conjunction") return clause;
    return {
      ...clause,
      site: cloneSite(target),
      administrationTargetGroup: cloneGroup(group)
    };
  });
}

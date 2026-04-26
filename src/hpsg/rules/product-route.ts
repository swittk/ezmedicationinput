import {
  KNOWN_TMT_DOSAGE_FORM_TO_SNOMED_ROUTE,
  PRODUCT_FORM_HINTS,
  ROUTE_BY_SNOMED
} from "../../maps";
import { RouteCode } from "../../types";

export function productRouteHint(phrase: string | undefined): RouteCode | undefined {
  const key = (phrase ?? "").trim().toLowerCase();
  if (!key) {
    return undefined;
  }
  const direct = PRODUCT_FORM_HINTS[key]?.routeHint;
  if (direct) {
    return direct;
  }
  const snomed = KNOWN_TMT_DOSAGE_FORM_TO_SNOMED_ROUTE[key];
  return snomed ? ROUTE_BY_SNOMED[snomed] : undefined;
}

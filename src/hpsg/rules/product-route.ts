import {
  KNOWN_TMT_DOSAGE_FORM_TO_SNOMED_ROUTE,
  PRODUCT_FORM_HINTS,
  ROUTE_BY_SNOMED
} from "../../maps";
import { RouteCode } from "../../types";

export function productRouteHint(phrase: string): RouteCode | undefined {
  const direct = PRODUCT_FORM_HINTS[phrase]?.routeHint;
  if (direct) {
    return direct;
  }
  const snomed = KNOWN_TMT_DOSAGE_FORM_TO_SNOMED_ROUTE[phrase];
  return snomed ? ROUTE_BY_SNOMED[snomed] : undefined;
}

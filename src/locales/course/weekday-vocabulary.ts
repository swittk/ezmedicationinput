/** Dependency-free weekday and list vocabulary shared by clause realization
 * and the course-language facet. Language packs must not import the central
 * registry or a complete clinical formatter merely to get these words.
 *
 * Historical entrypoints re-export the same object, without clone or freeze.
 */
export const ENGLISH_DAY_NAMES: Record<string, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
export const THAI_DAY_NAMES: Record<string, string> = {
  mon: "วันจันทร์",
  tue: "วันอังคาร",
  wed: "วันพุธ",
  thu: "วันพฤหัสบดี",
  fri: "วันศุกร์",
  sat: "วันเสาร์",
  sun: "วันอาทิตย์",
};
/** Single-pass list join with historical comma/conjunction placement.
 * No slice() plus join() array allocation. */
export function joinLocalizedList(parts: readonly string[], conjunction: string): string {
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  let text = parts[0];
  for (let index = 1; index < parts.length - 1; index++) text += ", " + parts[index];
  return text + " " + conjunction + " " + parts[parts.length - 1];
}

import { getMedicationInstructionAction, medicationInstructionActionLocaleRealizerConfig } from "./instruction-action-terminology";
import { INSTRUCTION_QUANTITY_UNIT_LABELS } from "./hpsg/lexical-classes";
import lexicalClasses from "./hpsg/lexical-classes.json";
import {
  getAdviceRelationDefinition,
  getUniqueAdviceRelationByGrammarFeature,
  localizeAdviceRelation,
  relationHasGrammarFeature,
  relationHasSemanticClass
} from "./relation-terminology";
import { baseLanguageTag, localizedValue } from "./localization";
import { inferMedicationLocale } from "./locale-detection";
import { joinLocalizedTokens, localizedTimeArgument } from "./locale-realization";
import { resolveMedicationInstructionConcept } from "./instruction-concept-terminology";
import { ENGLISH_COURSE, ENGLISH_DAY_NAMES } from "./locales/course/en";
import { THAI_COURSE, THAI_DAY_NAMES } from "./locales/course/th";
import {
  AdviceArgument,
  AdviceArgumentRole,
  AdviceFrame,
  AdviceModality,
  AdvicePolarity,
  AdviceRelation,
  MedicationInstructionActionDefinition,
  MedicationInstructionActionRealizer
} from "./types";

export interface InstructionActionRealizationInput {
  frame: AdviceFrame;
  locale: string;
  label: string;
  amount?: string;
  theme?: string;
  container?: string;
  destination?: string;
  site?: string;
  substance?: string;
  result?: string;
  activity?: string;
  time?: string;
  /** Selected Time's explicit or licensed inherited relation. */
  timeRelation?: AdviceRelation;
  /** Optional output evidence requested by action composition. Set only
   * at the branch that actually includes the selected Time in its wording. */
  timeWasRendered?: boolean;
  duration?: string;
  material?: string;
  manner?: string;
  realizerConfig?: MedicationInstructionActionDefinition["realizerConfig"];
  definition?: MedicationInstructionActionDefinition;
  translateArgumentConcept: (arg: AdviceArgument) => string;
  translateQuantity: (quantity: NonNullable<AdviceArgument["quantity"]>) => string;
}

export interface InstructionActionLocaleAdapter {
  locale: string;
  // A language can select its verb form from an already typed complement.
  selectLexicalRealization?(input: InstructionActionRealizationInput): InstructionActionRealizationInput;
  render(realizer: MedicationInstructionActionRealizer, input: InstructionActionRealizationInput): string | undefined;
  renderNegated(input: InstructionActionRealizationInput, completeAction?: string): string;
  applyPositiveModality(text: string, frame: AdviceFrame): string;
  parseConditionPersistence(body: string): { body: string; persists: boolean };
  renderConditionBody(base: string, conditionForm: string | undefined, persists: boolean): string;
  joinConditionLead(lead: string, body: string): string;
  conditionalContinuation(text: string, imperative: boolean): string;
  postposedCondition(text: string): string;
  sequenceSeparator(): string;
  continuationText(text: string, understood: boolean): string;
  withAuthoredDirections?(current: string, source: string): string;
  directTime?(time: string): string;
}

const ADAPTERS = new Map<string, InstructionActionLocaleAdapter>();

export function registerInstructionActionLocaleAdapter(adapter: InstructionActionLocaleAdapter): void {
  ADAPTERS.set(baseLanguageTag(adapter.locale) ?? adapter.locale.toLowerCase(), adapter);
}

export function getInstructionActionLocaleAdapter(locale: string): InstructionActionLocaleAdapter {
  // Standard calls already carry a normalized language key. Avoid regex/tag
  // normalization when the registered locale is an exact match; region and
  // mixed-case fallback semantics remain unchanged for other callers.
  const exact=ADAPTERS.get(locale);
  if(exact)return exact;
  const key=baseLanguageTag(locale)??locale.toLowerCase();
  return ADAPTERS.get(key)??ADAPTERS.get("en")!;
}

function lowerInitial(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function suppressSite(input: InstructionActionRealizationInput): boolean {
  const arg = input.frame.args.find((candidate) => candidate.role === AdviceArgumentRole.Site);
  return Boolean(arg?.conceptId &&
    (medicationInstructionActionLocaleRealizerConfig(input.realizerConfig, input.locale)
      ?.suppressSiteConcepts?.indexOf(arg.conceptId) ?? -1) !== -1);
}

function suppressActivity(input: InstructionActionRealizationInput): boolean {
  const arg = input.frame.args.find((candidate) => candidate.role === AdviceArgumentRole.Activity);
  return Boolean(arg?.conceptId &&
    (medicationInstructionActionLocaleRealizerConfig(input.realizerConfig, input.locale)
      ?.suppressActivityConcepts?.indexOf(arg.conceptId) ?? -1) !== -1);
}

export function instructionActionDefinitionForRealization(frame: AdviceFrame): MedicationInstructionActionDefinition | undefined {
  const fallback = getMedicationInstructionAction(frame.predicate.lemma);
  // A persisted custom realizer owns its attachment and configuration.
  // Without that override, recognized identity owns valence independently
  // of the author's display wording.
  return !frame.predicate.realizer || !frame.predicate.display ||
    frame.predicate.display === fallback?.display ? fallback : undefined;
}

/** The selected valence determines which daughter owns the frame relation. */
export function instructionFrameRelationOwnsTemporalArgument(frame: AdviceFrame, arg: AdviceArgument): boolean {
  if (!frame.relation) return false;
  const realizer = frame.predicate.realizer ?? instructionActionDefinitionForRealization(frame)?.realizer;
  if (realizer === "site-relation" && relationHasGrammarFeature(frame.relation, "rinseTimeComplement")) {
    return (arg.role === AdviceArgumentRole.Time || arg.role === AdviceArgumentRole.Activity) &&
      (!arg.relation || arg.relation === frame.relation);
  }
  return arg.role === AdviceArgumentRole.Time && !arg.relation &&
    relationHasGrammarFeature(frame.relation, "timeComplement");
}

/** Resolve Site attachment before locale realization or Time consumption. */
export function instructionFrameSiteRelation(frame: AdviceFrame, site?: AdviceArgument): AdviceRelation | undefined {
  const target = site ?? frame.args.find(arg => arg.role === AdviceArgumentRole.Site);
  const relation = target?.relation ?? frame.relation;
  if (!relation || !relationHasSemanticClass(relation, "locative")) return undefined;
  if (!target?.relation && frame.args.some(arg => instructionFrameRelationOwnsTemporalArgument(frame, arg)))
    return undefined;
  return relation;
}

export function instructionSiteRelation(
  input: InstructionActionRealizationInput, site?: AdviceArgument
): string | undefined {
  const relation = instructionFrameSiteRelation(input.frame, site);
  return relation ? localizeAdviceRelation(relation, input.locale) ?? relation : undefined;
}

function siteRelationObject(input: InstructionActionRealizationInput): string | undefined {
  if (input.theme && input.site)
    return joinLocalizedTokens(input.locale, [input.theme, instructionSiteRelation(input), input.site]);
  const object = input.site ?? input.theme ?? input.container;
  return object ? joinLocalizedTokens(input.locale, [instructionSiteRelation(input), object]) : undefined;
}

function relationForSite(input: InstructionActionRealizationInput): AdviceRelation {
  return input.frame.relation ??
    getUniqueAdviceRelationByGrammarFeature("defaultSiteRelation") ??
    (() => { throw new Error("Missing declarative default site relation"); })();
}

function siteRelationActivity(input: InstructionActionRealizationInput): string | undefined {
  if (!input.activity) return undefined;
  const activity = input.frame.args.find(arg => arg.role === AdviceArgumentRole.Activity);
  // Explicit accompaniment belongs to the selected argument, not the head
  // Time relation, and is already emitted with the other companions.
  if (relationHasSemanticClass(activity?.relation, "accompaniment")) return undefined;
  const relation = activity?.relation ?? relationForSite(input);
  const profile = getAdviceRelationDefinition(relation)?.grammar.timeRealizationProfile ?? "default";
  return joinLocalizedTokens(input.locale, [localizeAdviceRelation(relation, input.locale, profile) ?? relation, input.activity]);
}

/** Keep the selected nominal and its attachment together, independently of Time. */
function accompanimentContent(c: InstructionActionRealizationInput): Array<{ text: string; relation: AdviceRelation }> {
  const contents: Array<{ text: string; relation: AdviceRelation }> = [];
  for (const arg of c.frame.args) {
    if (arg.role !== AdviceArgumentRole.Substance &&
        (arg.role === AdviceArgumentRole.Time || !relationHasSemanticClass(arg.relation, "accompaniment"))) continue;
    const relation = arg.relation ?? (relationHasSemanticClass(c.frame.relation, "accompaniment")
      ? c.frame.relation! : AdviceRelation.With);
    const { amount, text } = instructionCompanionContent(c, arg);
    contents.push({ text: joinLocalizedTokens(c.locale, [amount, text]), relation });
  }
  return contents;
}

function renderEnglishAccompaniment(c: InstructionActionRealizationInput): string {
  let text = "";
  for (const content of accompanimentContent(c)) if (content.text)
    text += ` ${localizeAdviceRelation(content.relation, c.locale, "complement") ?? content.relation} ${content.text}`;
  return text;
}

function thaiAccompanimentRelation(relation: AdviceRelation, locale: string): string {
  return relation === AdviceRelation.With ? "ด้วย"
    : relation === AdviceRelation.Without ? "โดยไม่ใช้"
      : localizeAdviceRelation(relation, locale, "complement") ?? relation;
}

function materialRelation(c: InstructionActionRealizationInput): AdviceRelation {
  return c.frame.args.find(arg => arg.role === AdviceArgumentRole.Material)?.relation ??
    (relationHasSemanticClass(c.frame.relation, "accompaniment") ? c.frame.relation! : AdviceRelation.With);
}

function renderThaiAccompaniment(c: InstructionActionRealizationInput): string {
  let text = "";
  for (const content of accompanimentContent(c)) {
    if (!content.text) continue;
    const label = thaiAccompanimentRelation(content.relation, c.locale);
    text += label + content.text;
  }
  return text;
}

/** Preserve both typed participants of a negated relational action. */
function negatedAttachmentArguments(c: InstructionActionRealizationInput): {
  theme?: string; target?: string;
} {
  // The shared action selector accepts Object or Theme as the primary
  // nominal. Its separate typed Site remains the attachment target.
  if (c.theme && c.site) return { theme: c.theme, target: c.site };
  const theme = c.frame.args.find(arg => arg.role === AdviceArgumentRole.Theme);
  const target = theme && c.frame.args.find(arg =>
    arg !== theme && (arg.role === AdviceArgumentRole.Site || arg.role === AdviceArgumentRole.Object)
  );
  return theme && target
    ? { theme: c.translateArgumentConcept(theme), target: c.translateArgumentConcept(target) }
    : { target: c.site ?? c.theme ?? c.substance ?? c.material };
}

const EN_NEGATED_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.Should]: "Should not ", [AdviceModality.Must]: "Must not "
};
export const EN_POSITIVE_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.May]: "May ", [AdviceModality.Can]: "Can ",
  [AdviceModality.Might]: "Might ", [AdviceModality.Could]: "Could ",
  [AdviceModality.Should]: "Should ", [AdviceModality.Must]: "Must "
};

// A selected clock choice can retain an opaque suffix. Its complete leading
// clock owns the preposition; the remaining Time wording stays intact.
const CLOCK_ARGUMENT = /^[0-9]{1,2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:$|\s)/;

/** Internal selection metadata; public locale inputs and callbacks stay unchanged. */
type SelectedTimeInput = Pick<InstructionActionRealizationInput,
  "locale" | "time" | "timeRelation" | "timeWasRendered"> & { selectedTime?: AdviceArgument };

/** Consume the selected typed Time once; locale adapters own direct wording. */
export function realizeTimeArgument(c: SelectedTimeInput): string | undefined {
  if (!c.time) return undefined;
  const relation = c.timeRelation;
  let direct = !relation;
  if (relation && relationHasGrammarFeature(relation, "directTimeRealization")) {
    const selected = c.selectedTime;
    const value = selected?.normalized ?? c.time;
    // An opaque temporal nominal retains its explicit governor. Only the
    // existing clock/event/weekday/concept owners license direct-time wording.
    direct = Boolean(selected?.conceptId) || CLOCK_ARGUMENT.test(value) ||
      Boolean(localizedTimeArgument(value, c.locale)) || Boolean(localizedWeekdayArgument(value, c.locale));
    // Current value-only locale inputs may have only the realized value. A selected
    // concept (including configured concepts) already owns its typed identity.
    if (!direct && !selected)
      direct = resolveMedicationInstructionConcept(value)?.role === AdviceArgumentRole.Time;
  }
  const text = direct
    ? getInstructionActionLocaleAdapter(c.locale).directTime?.(c.time) ?? c.time
    : joinLocalizedTokens(c.locale, [localizeAdviceRelation(relation!, c.locale, "temporal") ?? relation, c.time]);
  if (c.timeWasRendered !== undefined) c.timeWasRendered = true;
  return text;
}

/** The same typed complements feed either locale's word order. */
function relationDurationContent(c: InstructionActionRealizationInput) {
  const object = c.theme ? joinLocalizedTokens(c.locale, [c.amount, c.theme]) : c.amount ?? c.site;
  const target = c.duration ?? c.activity;
  const relation = target && (c.duration
    ? relationHasGrammarFeature(c.frame.relation, "durationComplement") || relationHasGrammarFeature(c.frame.relation, "durationLead")
    : relationHasGrammarFeature(c.frame.relation, "activityFallback"))
    ? localizeAdviceRelation(c.frame.relation, c.locale, c.duration ? "duration" : undefined) ?? c.frame.relation : undefined;
  const objectRelation = !c.amount && !target && !c.time && object &&
    relationHasSemanticClass(c.frame.relation, "locative")
    ? localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation : undefined;
  return { object, target, relation, objectRelation, time: realizeTimeArgument(c) };
}

function renderEnglishRelationDuration(c: InstructionActionRealizationInput): string {
  const { object, target, relation, objectRelation, time } = relationDurationContent(c);
  return `${c.label}${object ? ` ${objectRelation ? objectRelation + " " : ""}${object}` : ""}${renderEnglishAccompaniment(c)}` +
    `${target ? ` ${relation ? relation + " " : ""}${target}` : ""}${time ? ` ${time}` : ""}`;
}

export function quantityOnlyInstructionArgument(arg: AdviceArgument | undefined): boolean {
  return Boolean(arg?.quantity && !arg.conceptId && !arg.coding && !arg.codings?.length &&
    (arg.normalized !== undefined && arg.normalized === arg.quantity.unit ||
      arg.normalized === undefined && !arg.i18n && arg.quantity.value !== undefined &&
      arg.text.replace(/\s+/gu, "") === `${arg.quantity.value}${arg.quantity.unit ?? ""}`));
}

/** A typed measured nominal without its own noun label retains the opaque
 * argument separately; its source text cannot override the current quantity. */
export function instructionArgumentNeedsAuthoredDirections(arg: AdviceArgument, locale: string): boolean {
  const nominal = arg.role === AdviceArgumentRole.Destination || arg.role === AdviceArgumentRole.Substance ||
    arg.role === AdviceArgumentRole.Object || arg.role === AdviceArgumentRole.Theme || arg.role === AdviceArgumentRole.Material;
  return nominal && arg.quantity !== undefined &&
    (arg.quantity.value !== undefined || arg.quantity.range?.low !== undefined || arg.quantity.range?.high !== undefined) &&
    arg.normalized === undefined && !localizedValue(arg.i18n, locale) && !quantityOnlyInstructionArgument(arg);
}

function instructionCompanionContent(c: InstructionActionRealizationInput, arg: AdviceArgument) {
  const amount = arg.quantity ? c.translateQuantity(arg.quantity) : undefined;
  const quantityOnly = quantityOnlyInstructionArgument(arg);
  const text = instructionArgumentNeedsAuthoredDirections(arg, c.locale) ? undefined : !quantityOnly || !amount
    ? arg.quantity && !amount ? arg.text || arg.normalized : c.translateArgumentConcept(arg)
    : undefined;
  return { amount, text };
}

/** Typed ownership is shared; each locale only orders the resolved words. */
function mixArgumentContent(c: InstructionActionRealizationInput) {
  let themeArg: AdviceArgument | undefined, substanceArg: AdviceArgument | undefined,
    unmarkedSubstance: AdviceArgument | undefined, unmarkedNominal: AdviceArgument | undefined,
    nominalThemeArg: AdviceArgument | undefined, amountArg: AdviceArgument | undefined;
  let additionalCompanions: AdviceArgument[] | undefined;
  for (const arg of c.frame.args) {
    const nominal = arg.role === AdviceArgumentRole.Object || arg.role === AdviceArgumentRole.Container;
    const material = arg.role === AdviceArgumentRole.Substance || arg.role === AdviceArgumentRole.Material;
    // Attachment owns the mixing vehicle independently of lexical noun role.
    // An unmarked Substance can be the theme before an explicit WITH vehicle.
    const companion = arg.relation &&
      (relationHasGrammarFeature(arg.relation, "accompanimentComplement") ||
        relationHasSemanticClass(arg.relation, "accompaniment") ||
        relationHasSemanticClass(arg.relation, "locative"));
    if (!arg.relation) {
      if (arg.role === AdviceArgumentRole.Theme) themeArg ??= arg;
      else if (nominal) {
        if (!nominalThemeArg) nominalThemeArg = arg;
        else unmarkedNominal ??= arg;
      }
    }
    if (companion && (material || nominal || arg.role === AdviceArgumentRole.Theme)) {
      if (!substanceArg) substanceArg = arg;
      else (additionalCompanions ??= []).push(arg);
    } else if (!unmarkedSubstance && material && !arg.relation) unmarkedSubstance = arg;
    if (!amountArg && arg.role === AdviceArgumentRole.Amount) amountArg = arg;
  }
  // Typed Theme wins over an earlier nominal fallback. With a real Theme,
  // the first unmarked nominal remains available as the legacy vehicle.
  if (themeArg) unmarkedNominal = nominalThemeArg;
  else themeArg = nominalThemeArg;
  if (substanceArg) themeArg ??= unmarkedSubstance;
  else {
    substanceArg = unmarkedSubstance;
    // Saved graphs can attach WITH to the frame while their distinct
    // instrument/container keeps its original nominal lexical role.
    if (!substanceArg && c.frame.relation &&
        (relationHasGrammarFeature(c.frame.relation, "accompanimentComplement") ||
          relationHasSemanticClass(c.frame.relation, "accompaniment") ||
          relationHasSemanticClass(c.frame.relation, "locative"))) {
      const legacyVehicle = unmarkedNominal ?? (themeArg &&
        (themeArg.role === AdviceArgumentRole.Object || themeArg.role === AdviceArgumentRole.Container)
        ? themeArg : undefined);
      if (legacyVehicle) {
        substanceArg = legacyVehicle;
        if (themeArg === legacyVehicle) themeArg = undefined;
      }
    }
  }
  const themeAmount = themeArg?.quantity ? c.translateQuantity(themeArg.quantity) : undefined;
  // A quantity-only daughter carries its unit as normalized identity; it has
  // no ingredient noun to repeat as "5 mL of mL".
  const quantityOnlyTheme = quantityOnlyInstructionArgument(themeArg);
  const theme = themeArg && !instructionArgumentNeedsAuthoredDirections(themeArg, c.locale) && (!quantityOnlyTheme || !themeAmount)
    ? themeArg.quantity && !themeAmount
      ? themeArg.text || themeArg.normalized
      : c.translateArgumentConcept(themeArg)
    : undefined;
  const substanceQuantity = substanceArg?.quantity ? c.translateQuantity(substanceArg.quantity) : undefined;
  const quantityOnlySubstance = quantityOnlyInstructionArgument(substanceArg);
  const substance = substanceArg && !instructionArgumentNeedsAuthoredDirections(substanceArg, c.locale) && (!quantityOnlySubstance || !substanceQuantity)
    ? substanceArg.quantity && !substanceQuantity
      ? substanceArg.text || substanceArg.normalized
      : c.translateArgumentConcept(substanceArg)
    : substanceArg ? undefined : c.substance;
  // c.amount already preserves a partial quantity's authored wording. Reusing
  // it avoids fabricating a number or attaching a tablet amount to plain water.
  const coextensiveAmount = themeArg && amountArg?.quantity &&
    themeArg.text.trim() === amountArg.text.trim() ? c.amount : undefined;
  // The parser may retain an Amount inside an unquantified Object such as
  // "1 tab under tongue". Its authored Amount label and source containment
  // identify that same dose without comparing localized unit wording.
  const sourceAmount = !themeArg?.quantity && amountArg?.quantity ? amountArg.text.trim() : undefined;
  const sourceOffset = themeArg && sourceAmount ? themeArg.text.indexOf(sourceAmount) : -1;
  const containsSourceAmount = Boolean(themeArg && sourceAmount && sourceOffset >= 0 &&
    !themeArg.relation &&
    (!themeArg.span || !amountArg?.span ||
      themeArg.span.start <= amountArg.span.start && themeArg.span.end >= amountArg.span.end) &&
    (sourceOffset === 0 || !/[a-z0-9]/i.test(themeArg.text[sourceOffset - 1])) &&
    (sourceOffset + sourceAmount.length === themeArg.text.length ||
      !/[a-z0-9]/i.test(themeArg.text[sourceOffset + sourceAmount.length])));
  const amountAlreadyInTheme = Boolean(coextensiveAmount || containsSourceAmount ||
    themeArg?.quantity && amountArg?.quantity &&
      themeArg.quantity.value === amountArg.quantity.value &&
      themeArg.quantity.unit === amountArg.quantity.unit &&
      themeArg.text.includes(amountArg.text.trim()));
  // A separate medication Amount belongs with the Theme, never with an
  // unmeasured accompaniment. A measured Substance owns its own quantity.
  const vehicleRelation = substanceArg?.relation ?? c.frame.relation;
  const hasSeparateVehicle = substanceArg && vehicleRelation &&
    (relationHasGrammarFeature(vehicleRelation, "accompanimentComplement") ||
      relationHasSemanticClass(vehicleRelation, "accompaniment") ||
      relationHasSemanticClass(vehicleRelation, "locative"));
  const primaryAmount = (themeArg || hasSeparateVehicle) && !amountAlreadyInTheme ? c.amount : undefined;
  const substanceAmount = substanceArg?.quantity ? substanceQuantity
    : themeArg || hasSeparateVehicle || amountAlreadyInTheme ? undefined : c.amount;
  return { theme, themeAmount, substance, substanceArg, amountArg, additionalCompanions,
    coextensiveAmount, primaryAmount, substanceAmount };
}

const WEEKDAY_ARGUMENTS = new Map<string, Record<string, string>>();
for (const entry of lexicalClasses.calendarWeekdayLexemes) {
  const labels = { en: ENGLISH_DAY_NAMES[entry.day], th: THAI_DAY_NAMES[entry.day] };
  for (const form of entry.en) WEEKDAY_ARGUMENTS.set(form, labels);
  // Contextual short Thai aliases remain the calendar parser's responsibility.
  for (const form of entry.th) {
    WEEKDAY_ARGUMENTS.set(form, labels);
    WEEKDAY_ARGUMENTS.set(lexicalClasses.calendarWeekdayPrefix + form, labels);
  }
}

/** Realize an already selected weekday Time through the existing locale labels. */
function localizedWeekdayArgument(value: string, locale: string | undefined): string | undefined {
  const labels = WEEKDAY_ARGUMENTS.get(value.trim().toLowerCase());
  return localizedValue(labels, locale) ?? localizedValue(labels, "en");
}

function englishDirectTime(time: string): string {
  const weekday = localizedWeekdayArgument(time, "en");
  if (weekday) return joinLocalizedTokens("en", [
    localizeAdviceRelation(AdviceRelation.On, "en", "temporal"), weekday
  ]);
  const lower = time.toLowerCase();
  return lower === "immediately" || lower === "immediate" ? "immediately"
    : lower === "night" ? "at night"
    : lower === "bed" || lower === "bedtime" || lower === "sleep" ? "at bedtime"
      : /^(?:the )?(?:morning|afternoon|evening)$/.test(lower)
        ? `in ${lower.startsWith("the ") ? lower : `the ${lower}`}`
        : `at ${time}`;
}

function renderEnglish(realizer: MedicationInstructionActionRealizer, c: InstructionActionRealizationInput): string | undefined {
  switch (realizer) {
    case "source-faithful": {
      if (!/[\u0E00-\u0E7F]/u.test(c.frame.sourceText)) {
        const text = c.frame.sourceText.trim();
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : c.label;
      }
      return "Adjust use according to symptoms";
    }
    case "container-activity": {
      const container = c.container ?? c.theme;
      const relation = c.frame.relation
        ? localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation
        : "before";
      const time = realizeTimeArgument(c);
      return `${c.label}${container ? ` ${container}` : ""}${c.duration ? ` for ${c.duration}` : ""}${c.activity ? ` ${relation} ${c.activity}` : ""}${time ? ` ${time}` : ""}`;
    }
    case "theme-destination-amount":
      return `${c.label}${c.theme ? ` ${c.theme}` : ""}${c.amount ? ` ${c.amount}` : ""}${c.destination ? ` into ${c.destination}` : ""}`;
    case "mix-substance": {
      const { theme, themeAmount, substance, substanceArg, amountArg, additionalCompanions,
        coextensiveAmount, primaryAmount, substanceAmount } = mixArgumentContent(c);
      const themeText = theme
        ? ` ${primaryAmount ? `${primaryAmount} of ` : ""}${coextensiveAmount ?? (themeAmount ? `${themeAmount} of ${theme}` : theme)}`
        : primaryAmount || coextensiveAmount || themeAmount
          ? " " + (primaryAmount ?? coextensiveAmount ?? themeAmount) : "";
      const amountText = substanceAmount ? substanceAmount +
        (substance ? amountArg?.conceptId && !substanceArg?.quantity ? " of " : " " : "") : "";
      const vehicleRelation = substanceArg?.relation ?? c.frame.relation;
      const materialRelation = vehicleRelation &&
        (relationHasSemanticClass(vehicleRelation, "accompaniment") ||
          relationHasSemanticClass(vehicleRelation, "locative"))
        ? localizeAdviceRelation(vehicleRelation, c.locale) ?? vehicleRelation
        : "with";
      const timeSemanticRelation = c.timeRelation;
      const timeRelation = timeSemanticRelation &&
        (relationHasSemanticClass(timeSemanticRelation, "temporal") || timeSemanticRelation === AdviceRelation.In)
        ? localizeAdviceRelation(timeSemanticRelation, c.locale) ?? timeSemanticRelation : "at";
      if (c.timeWasRendered !== undefined && c.time) c.timeWasRendered = true;
      let companionsText = "";
      if (additionalCompanions) for (const arg of additionalCompanions) {
        const { amount, text } = instructionCompanionContent(c, arg);
        const relation = localizeAdviceRelation(arg.relation!, c.locale) ?? arg.relation;
        if (amount || text) companionsText += ` ${relation} ${amount ?? ""}${amount && text ? " " : ""}${text ?? ""}`;
      }
      return `${c.label}${themeText}${substance || substanceAmount ? ` ${materialRelation} ${amountText}${substance ?? ""}` : ""}${companionsText}${c.time ? ` ${timeRelation} ${c.time}` : ""}`;
    }
    case "site-relation": {
      const object = siteRelationObject(c);
      const activity = siteRelationActivity(c);
      const relationTarget = c.time ?? activity;
      const manner = c.manner ? ` ${c.manner}` : "";
      const substance = renderEnglishAccompaniment(c);
      const elapsed = c.duration ? ` for ${c.duration}` : "";
      if (relationTarget) {
        const target = object && (!c.site || !suppressSite(c)) ? ` ${object}` : "";
        if (c.time) {
          const timePhrase = realizeTimeArgument(c);
          return `${c.label}${target}${manner}${elapsed}${substance} ${timePhrase}${activity ? ` ${activity}` : ""}`;
        }
        return `${c.label}${target}${manner}${elapsed}${substance} ${activity}`;
      }
      const result = c.result ? ` until ${c.result}` : "";
      if (object) return `${c.label} ${object}${manner}${elapsed}${substance}${result}`;
      return `${c.label}${manner}${elapsed}${substance}${result}`;
    }
    case "object-amount-material": {
      const object = c.theme ?? c.container;
      const relation = c.material ? materialRelation(c) : undefined;
      const lead = relation && (localizeAdviceRelation(relation, c.locale, "complement") ?? relation);
      return `${c.label}${object ? ` ${object}` : ""}${c.amount ? ` ${c.amount}` : ""}${c.material ? ` ${lead} ${c.material}` : ""}`;
    }
    case "prime": {
      const object = c.theme ?? c.container;
      return `${c.label}${object ? ` ${object}` : ""}${c.amount ? ` with ${c.amount}` : ""}${c.material ? ` ${c.material}` : ""}`;
    }
    case "amount-duration": {
      const relationTarget = c.activity;
      const relation = relationHasGrammarFeature(c.frame.relation, "activityFallback")
        ? localizeAdviceRelation(c.frame.relation, c.locale) : undefined;
      const base = `${c.label}${c.amount ? ` ${c.amount}` : ""}${c.duration ? ` for ${c.duration}` : ""}${renderEnglishAccompaniment(c)}`;
      const body = relation && relationTarget ? `${base} ${relation} ${relationTarget}` : base;
      const time = realizeTimeArgument(c);
      return time ? `${body} ${time}` : body;
    }
    case "object-duration": {
      const object = c.theme && c.site ? siteRelationObject(c) : c.theme ?? c.site;
      const time = realizeTimeArgument(c);
      return `${c.label}${object ? ` ${object}` : ""}${c.duration ? ` for ${c.duration}` : ""}${time ? ` ${time}` : ""}`;
    }
    case "object-time": {
      const object = c.theme ?? c.site;
      const time = realizeTimeArgument(c);
      const amount = c.amount ? (c.theme ? " (" + c.amount + ")" : " " + c.amount) : "";
      const site = c.theme && c.site ? " to " + c.site : "";
      return c.label + (object ? " " + object : "") + amount + site +
        (time ? " " + time : "");
    }
    case "separable-object-relation": {
      const object = c.theme ?? c.site;
      const alias = c.definition?.separableAliases?.find((candidate) =>
        !/[\u0E00-\u0E7F]/u.test(candidate.lead + candidate.particle));
      if (!alias) return renderEnglishRelationDuration(c);
      const { target, relation, time } = relationDurationContent(c);
      return `${alias.lead}${object ? ` ${object}` : ""} ${alias.particle}` +
        `${target ? ` ${relation ? relation + " " : ""}${target}` : ""}${time ? ` ${time}` : ""}`;
    }
    case "relation-duration": return renderEnglishRelationDuration(c);
    case "leave-duration": {
      const durationArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Duration);
      if (durationArg?.conceptId === "overnight" && c.duration) return `${c.label} on ${c.duration}`;
      return `${c.label} on${c.duration ? ` for ${c.duration}` : ""}`;
    }
    case "duration": {
      const object = c.theme ?? (suppressSite(c) ? undefined : c.site);
      const time = realizeTimeArgument(c);
      return `${c.label}${object ? ` ${object}` : ""}${c.duration ? ` for ${c.duration}` : ""}${time ? ` ${time}` : ""}`;
    }
    case "duration-activity": {
      const target = c.activity ?? c.substance ?? c.result;
      if (!target) return `${c.label}${c.duration ? ` ${c.duration}` : ""}`;
      if (c.frame.relation) {
        const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
        return `${c.label}${c.duration ? ` ${c.duration}` : ""} ${relation} ${target}`;
      }
      return `${c.label}${c.duration ? ` ${c.duration}` : ""} ${target}`;
    }
    case "activity": {
      const base = `${c.label}${c.activity ? ` ${c.activity}` : ""}`;
      return c.duration ? `${base} for ${c.duration}` : base;
    }
    default: return undefined;
  }
}

const TH_NEGATED_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.Should]: "ไม่ควร", [AdviceModality.Must]: "ห้าม"
};
export const TH_POSITIVE_MODALITY_PREFIX: Partial<Record<AdviceModality, string>> = {
  [AdviceModality.May]: "อาจ", [AdviceModality.Can]: "สามารถ",
  [AdviceModality.Might]: "อาจ", [AdviceModality.Could]: "อาจ",
  [AdviceModality.Should]: "ควร", [AdviceModality.Must]: "ต้อง"
};

function thaiAsciiSeparated(value: string | undefined): string {
  return value && /^[0-9A-Za-z]/u.test(value) ? ` ${value}` : value ?? "";
}

function renderThaiRelationDuration(c: InstructionActionRealizationInput): string {
  const { object, target, relation, objectRelation, time } = relationDurationContent(c);
  return `${c.label}${objectRelation ?? ""}${thaiAsciiSeparated(object)}${renderThaiAccompaniment(c)}` +
    `${target ? `${relation ?? ""}${thaiAsciiSeparated(target)}` : ""}${time ?? ""}`;
}

function thaiDirectTime(time: string): string {
  const weekday = localizedWeekdayArgument(time, "th");
  if (weekday) return joinLocalizedTokens("th", [
    localizeAdviceRelation(AdviceRelation.On, "th", "temporal"), weekday
  ]);
  if (CLOCK_ARGUMENT.test(time)) return ` เวลา ${time}`;
  return time === "กลางคืน" ? "ตอนกลางคืน"
    : time === "นอน" || time === "bedtime" ? "ก่อนนอน" : time;
}

function renderThai(realizer: MedicationInstructionActionRealizer, c: InstructionActionRealizationInput): string | undefined {
  switch (realizer) {
    case "source-faithful":
      return /[\u0E00-\u0E7F]/u.test(c.frame.sourceText) ? c.frame.sourceText.trim() : "ปรับการใช้ตามอาการ";
    case "container-activity": {
      const container = c.container ?? c.theme;
      const relation = c.frame.relation
        ? localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation
        : "ก่อน";
      const time = realizeTimeArgument(c);
      return `${c.label}${container ?? ""}${c.duration ? `เป็นเวลา ${c.duration}` : ""}${c.activity ? `${relation}${c.activity}` : ""}${time ?? ""}`;
    }
    case "theme-destination-amount":
      return `${c.label}${c.theme ?? ""}${c.destination ? `ลง${c.destination}` : ""}${c.amount ? ` ${c.amount}` : ""}`;
    case "mix-substance": {
      const { theme, themeAmount, substance, substanceArg, amountArg, additionalCompanions,
        coextensiveAmount, primaryAmount, substanceAmount } = mixArgumentContent(c);
      const themeText = theme ? (coextensiveAmount ??
        `${theme}${themeAmount ? ` ${themeAmount}` : ""}${primaryAmount ? ` ${primaryAmount}` : ""}`) : primaryAmount ?? coextensiveAmount ?? themeAmount ?? "";
      const amountSeparator = substanceArg?.quantity ? " " : amountArg?.conceptId ? "" : " ";
      const vehicleRelation = substanceArg?.relation ?? c.frame.relation;
      const materialRelation = vehicleRelation === AdviceRelation.Without
        ? "โดยไม่ใช้"
        : vehicleRelation && relationHasSemanticClass(vehicleRelation, "locative")
          ? localizeAdviceRelation(vehicleRelation, c.locale) ?? vehicleRelation
          : themeText ? "กับ" : vehicleRelation === AdviceRelation.With ? "ด้วย" : "";
      const substanceText = substance || substanceAmount
        ? `${materialRelation}${substance ?? ""}${substanceAmount ? (substance ? amountSeparator : "") + substanceAmount : ""}` : "";
      const timeSemanticRelation = c.timeRelation;
      const timeRelation = timeSemanticRelation &&
        (relationHasSemanticClass(timeSemanticRelation, "temporal") || timeSemanticRelation === AdviceRelation.In)
        ? localizeAdviceRelation(timeSemanticRelation, c.locale) ?? timeSemanticRelation : " เวลา ";
      if (c.timeWasRendered !== undefined && c.time) c.timeWasRendered = true;
      let companionsText = "";
      if (additionalCompanions) for (const arg of additionalCompanions) {
        const { amount, text } = instructionCompanionContent(c, arg);
        const relation = arg.relation === AdviceRelation.Without ? "โดยไม่ใช้"
          : relationHasSemanticClass(arg.relation, "locative")
            ? localizeAdviceRelation(arg.relation!, c.locale) ?? arg.relation : "กับ";
        if (amount || text) companionsText += `${relation}${text ?? ""}${text && amount ? " " : ""}${amount ?? ""}`;
      }
      return `${c.label}${themeText}${substanceText}${companionsText}${c.time ? `${timeRelation}${c.time}` : ""}`;
    }
    case "site-relation": {
      const object = siteRelationObject(c);
      const activity = siteRelationActivity(c);
      const relationTarget = c.time ?? activity;
      const manner = c.manner ?? "";
      const substance = renderThaiAccompaniment(c);
      const elapsed = c.duration ? `เป็นเวลา ${c.duration}` : "";
      if (relationTarget) {
        const target = object && (!c.site || !suppressSite(c)) ? object : "";
        if (c.time) {
          const timePhrase = realizeTimeArgument(c);
          return `${c.label}${target}${manner}${elapsed}${substance}${timePhrase}${activity ?? ""}`;
        }
        return `${c.label}${target}${manner}${elapsed}${substance}${activity}`;
      }
      const result = c.result ? `ให้${c.result}` : "";
      if (object) return `${c.label}${object}${manner}${elapsed}${substance}${result}`;
      return `${c.label}${manner}${elapsed}${substance}${result}`;
    }
    case "object-amount-material": {
      const object = c.theme ?? c.container;
      const lead = c.material ? thaiAccompanimentRelation(materialRelation(c), c.locale) : undefined;
      return `${c.label}${object ?? ""}${c.amount ? ` ${c.amount}` : ""}${c.material ? `${lead}${thaiAsciiSeparated(c.material)}` : ""}`;
    }
    case "prime": {
      const object = c.theme ?? c.container;
      const fallback = medicationInstructionActionLocaleRealizerConfig(c.realizerConfig, c.locale)?.fallbackObject ?? "";
      return `${c.label}${object ?? fallback}${c.amount ? ` ${c.amount}` : ""}${c.material ? ` ${c.material}` : ""}`;
    }
    case "amount-duration": {
      const relationTarget = c.activity;
      const relation = relationHasGrammarFeature(c.frame.relation, "activityFallback")
        ? localizeAdviceRelation(c.frame.relation, c.locale) : undefined;
      const base = `${c.label}${c.amount ? ` ${c.amount}` : ""}${c.duration ? ` นาน ${c.duration}` : ""}${renderThaiAccompaniment(c)}`;
      const body = relation && relationTarget ? `${base}${relation}${relationTarget}` : base;
      const time = realizeTimeArgument(c);
      return time ? `${body}${time}` : body;
    }
    case "object-duration": {
      const object = c.theme && c.site ? siteRelationObject(c) : c.theme ?? c.site;
      const time = realizeTimeArgument(c);
      return `${c.label}${object ?? ""}${c.duration ? ` ${c.duration}` : ""}${time ?? ""}`;
    }
    case "object-time": {
      const object = c.theme ?? c.site;
      const time = realizeTimeArgument(c);
      const amount = c.amount ? " " + c.amount : "";
      const site = c.theme && c.site ? "บริเวณ" + c.site : "";
      return c.label + (object ?? "") + amount + site + (time ?? "");
    }
    case "separable-object-relation": {
      const object = c.theme ?? c.site;
      const alias = c.definition?.separableAliases?.find((candidate) =>
        /[\u0E00-\u0E7F]/u.test(candidate.lead + candidate.particle));
      if (!alias) return renderThaiRelationDuration(c);
      const { target, relation, time } = relationDurationContent(c);
      return `${alias.lead}${object ?? ""}${alias.particle}` +
        `${target ? `${relation ?? ""}${thaiAsciiSeparated(target)}` : ""}${time ?? ""}`;
    }
    case "relation-duration": return renderThaiRelationDuration(c);
    case "leave-duration": {
      const durationArg = c.frame.args.find((arg) => arg.role === AdviceArgumentRole.Duration);
      if (durationArg?.conceptId === "overnight" && c.duration) return `${c.label}${c.duration}`;
      return `${c.label}${c.duration ? ` ${c.duration}` : ""}`;
    }
    case "duration": {
      const object = c.theme ?? (suppressSite(c) ? undefined : c.site);
      // A verb that entails a generic site still keeps a more specific site
      // as a qualifier; retain its full translated label, including laterality.
      const qualifier = !c.theme && object &&
        medicationInstructionActionLocaleRealizerConfig(c.realizerConfig, c.locale)?.suppressSiteConcepts?.length;
      const time = realizeTimeArgument(c);
      return `${c.label}${qualifier ? ` (${object})` : thaiAsciiSeparated(object)}${c.duration ? ` ${c.duration}` : ""}${time ?? ""}`;
    }
    case "duration-activity": {
      const target = c.activity ?? c.substance ?? c.result;
      if (!target) return `${c.label}${c.duration ? ` ${c.duration}` : ""}`;
      if (c.frame.relation) {
        const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
        return relationHasSemanticClass(c.frame.relation, "interval")
          ? `${c.label}${c.duration ? ` ${c.duration}` : ""} ${relation}${target}`
          : `${c.label}${c.duration ? ` ${c.duration}` : ""}${relation}${target}`;
      }
      return `${c.label}${c.duration ? ` ${c.duration}` : ""} ${target}`;
    }
    case "activity": {
      const base = suppressActivity(c) || !c.activity ? c.label : `${c.label}${c.activity}`;
      return c.duration ? `${base}เป็นเวลา ${c.duration}` : base;
    }
    default: return undefined;
  }
}

const EN_ADAPTER: InstructionActionLocaleAdapter = {
  locale: "en",
  directTime: englishDirectTime,
  withAuthoredDirections: ENGLISH_COURSE.withAuthoredDirections,
  selectLexicalRealization(input) {
    const finiteLabel = input.frame.modality === undefined && input.frame.polarity !== AdvicePolarity.Negate &&
      localizedValue(input.frame.predicate.i18n, input.locale) === undefined
      ? medicationInstructionActionLocaleRealizerConfig(input.realizerConfig, input.locale)?.finiteUnmodalLabel
      : undefined;
    return finiteLabel ? { ...input, label: finiteLabel } : input;
  },
  render: renderEnglish,
  renderNegated(c, completeAction) {
    const object = c.site ?? c.theme ?? c.substance ?? c.material;
    const relationTarget = c.activity ?? c.time;
    const prefix = (c.frame.modality && EN_NEGATED_MODALITY_PREFIX[c.frame.modality]) ?? "Do not ";
    if (completeAction) return prefix + lowerInitial(completeAction);
    if (c.site && !c.frame.relation &&
        (c.definition?.code === "apply" || c.definition?.code === "reapply")) {
      return `${prefix}${c.label.toLowerCase()} to ${c.site}`;
    }
    if (object && relationHasGrammarFeature(c.frame.relation, "negatedObjectAttachment")) {
      const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
      const attachment = negatedAttachmentArguments(c);
      return `${prefix}${c.label.toLowerCase()}${attachment.theme ? ` ${attachment.theme}` : ""} ${relation} ${attachment.target}`;
    }
    if (relationTarget && c.frame.relation === AdviceRelation.Without) {
      if (c.timeWasRendered !== undefined && !c.activity && c.time) c.timeWasRendered = true;
      const relation = localizeAdviceRelation(AdviceRelation.Without, c.locale) ?? "without";
      return `${prefix}${c.label.toLowerCase()}${object ? ` ${object}` : ""}${c.duration ? ` for ${c.duration}` : ""} ${relation} ${relationTarget}`;
    }
    const temporalRelation = !c.activity && c.time ? c.timeRelation : c.frame.relation;
    if (relationTarget && relationHasGrammarFeature(temporalRelation, "negatedRelationTarget")) {
      if (c.timeWasRendered !== undefined && !c.activity && c.time) c.timeWasRendered = true;
      const relation = localizeAdviceRelation(temporalRelation, c.locale) ?? temporalRelation;
      const renderedTime = c.activity ? realizeTimeArgument(c) : undefined;
      const localTime = renderedTime ? ` ${renderedTime}` : "";
      return `${prefix}${c.label.toLowerCase()}${object ? ` ${object}` : ""}${c.duration ? ` for ${c.duration}` : ""}${localTime} ${relation} ${relationTarget}`;
    }
    if (c.duration) return `${prefix}${c.label.toLowerCase()}${object ? ` ${object}` : ""} for ${c.duration}`;
    const fallback = object ?? c.activity ?? realizeTimeArgument(c);
    return `${prefix}${c.label.toLowerCase()}${fallback ? ` ${fallback}` : ""}`;
  },
  applyPositiveModality(text, frame) {
    if (!frame.modality) return text;
    const prefix = EN_POSITIVE_MODALITY_PREFIX[frame.modality];
    if (!prefix || text.trim().toLowerCase().startsWith(prefix.trim().toLowerCase())) return text;
    return `${prefix}${lowerInitial(text)}`;
  },
  parseConditionPersistence(body) {
    const match = body.match(/^(.+?)\s+(?:persists?|continues?|remains?)$/iu);
    return match ? { body: match[1].trim(), persists: true } : { body, persists: false };
  },
  renderConditionBody(base, _conditionForm, persists) {
    const normalized = lowerInitial(base);
    return persists ? `${normalized} persists` : normalized;
  },
  joinConditionLead(lead, body) { return `${lead} ${body}`.trim(); },
  conditionalContinuation(text) {
    const lowered = lowerInitial(text);
    const scoped = /^(?:should|must|may|might|can|could)\b/i.test(lowered) ? `you ${lowered}` : lowered;
    return `, ${scoped}`;
  },
  postposedCondition(text) { return ` ${text}`; },
  sequenceSeparator() { return "; then "; },
  continuationText(text, understood) { return understood ? lowerInitial(text) : text; }
};

const TH_ADAPTER: InstructionActionLocaleAdapter = {
  locale: "th",
  directTime: thaiDirectTime,
  withAuthoredDirections: THAI_COURSE.withAuthoredDirections,
  selectLexicalRealization(input) {
    // Whole-unit manner agrees with the already typed dosage form.
    // For solid tablets/capsules, use the registered Thai unit classifier;
    // no English token matching and no new quantity is inferred.
    const whole = input.frame.args.some((arg) =>
      arg.role === AdviceArgumentRole.Manner && arg.conceptId === "whole"
    );
    const unit = input.frame.args.find((arg) =>
      arg.role === AdviceArgumentRole.Amount && arg.quantity
    )?.quantity?.unit;
    const classifier = whole && (unit === "tab" || unit === "cap")
      ? INSTRUCTION_QUANTITY_UNIT_LABELS.get(unit)?.locales?.th?.one
      : undefined;
    const patch = input.frame.predicate.lemma === "apply" && (unit === "patch" || input.frame.args.some(arg =>
      (arg.role === AdviceArgumentRole.Object || arg.role === AdviceArgumentRole.Theme) && arg.conceptId === "patch"));
    const patchLabel = patch && input.label === getMedicationInstructionAction("apply")?.i18n?.th
      ? getMedicationInstructionAction("apply_patch")?.i18n?.th : undefined;
    const realized = classifier || patchLabel
      ? { ...input, ...(classifier ? { manner: `ทั้ง${classifier}` } : {}), ...(patchLabel ? { label: patchLabel } : {}) }
      : input;
    if (realized.frame.predicate.semanticClass !== "avoidance" || !realized.site) return realized;
    return {
      ...realized,
      label: "หลีกเลี่ยง",
      site: realized.site.startsWith("บริเวณ") ? realized.site : `บริเวณ${realized.site}`
    };
  },
  render: renderThai,
  renderNegated(c, completeAction) {
    const object = c.site ?? c.theme ?? c.substance ?? c.material;
    const relationTarget = c.activity ?? c.time;
    const prefix = (c.frame.modality && TH_NEGATED_MODALITY_PREFIX[c.frame.modality]) ?? "ห้าม";
    if (completeAction) return prefix + completeAction;
    if (object && relationHasGrammarFeature(c.frame.relation, "negatedObjectAttachment")) {
      const relation = localizeAdviceRelation(c.frame.relation, c.locale) ?? c.frame.relation;
      const attachment = negatedAttachmentArguments(c);
      return `${prefix}${c.label}${attachment.theme ?? ""}${relation}${attachment.target}`;
    }
    if (relationTarget && c.frame.relation === AdviceRelation.Without) {
      if (c.timeWasRendered !== undefined && !c.activity && c.time) c.timeWasRendered = true;
      const relation = localizeAdviceRelation(AdviceRelation.Without, c.locale) ?? "โดยไม่";
      return `${prefix}${c.label}${object ?? ""}${c.duration ? `เป็นเวลา ${c.duration}` : ""}${relation}${relationTarget}`;
    }
    const temporalRelation = !c.activity && c.time ? c.timeRelation : c.frame.relation;
    if (relationTarget && relationHasGrammarFeature(temporalRelation, "negatedRelationTarget")) {
      if (c.timeWasRendered !== undefined && !c.activity && c.time) c.timeWasRendered = true;
      const relation = localizeAdviceRelation(temporalRelation, c.locale) ?? temporalRelation;
      const localTime = c.activity ? realizeTimeArgument(c) ?? "" : "";
      return `${prefix}${c.label}${object ?? ""}${c.duration ? `เป็นเวลา ${c.duration}` : ""}${localTime}${relation}${relationTarget}`;
    }
    if (c.duration) return `${prefix}${c.label}${object ?? ""}เป็นเวลา ${c.duration}`;
    return `${prefix}${c.label}${object ?? c.activity ?? realizeTimeArgument(c) ?? ""}`;
  },
  applyPositiveModality(text, frame) {
    if (!frame.modality) return text;
    const prefix = TH_POSITIVE_MODALITY_PREFIX[frame.modality];
    if (!prefix || text.trim().toLowerCase().startsWith(prefix.trim().toLowerCase())) return text;
    return `${prefix}${text}`;
  },
  parseConditionPersistence(body) {
    return /^ยัง/u.test(body)
      ? { body: body.replace(/^ยัง/u, "").trim(), persists: true }
      : { body, persists: false };
  },
  renderConditionBody(base, conditionForm, persists) {
    const body = conditionForm ?? base;
    return persists ? `ยัง${body}` : body;
  },
  joinConditionLead(lead, body) { return `${lead}${body}`.trim(); },
  conditionalContinuation(text, imperative) { return `${imperative ? "ให้" : ""}${text}`; },
  postposedCondition(text) {
    // Join the realized lead, independently of the language of its opaque body.
    return inferMedicationLocale(text.charAt(0), "en") === "th" ? text : ` ${text}`;
  },
  sequenceSeparator() { return " จากนั้น"; },
  continuationText(text) { return text; }
};

registerInstructionActionLocaleAdapter(EN_ADAPTER);
registerInstructionActionLocaleAdapter(TH_ADAPTER);

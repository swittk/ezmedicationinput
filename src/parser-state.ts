import { AnnotatedLexToken } from "./lexer/meaning";
import { cloneBodySiteSpatialRelation } from "./body-site-spatial";
import { cloneExtensions, clonePrimitiveElement } from "./fhir-translations";
import {
  CanonicalAdditionalInstructionExpr,
  BodySiteSpatialRelation,
  CanonicalDoseRange,
  CanonicalPrnReasonExpr,
  CanonicalSigClause,
  EventTiming,
  FhirCoding,
  FhirDayOfWeek,
  FhirPrimitiveElement,
  FhirPeriodUnit,
  PrnReasonLookupRequest,
  PrnReasonSuggestion,
  RouteCode,
  SiteCodeLookupRequest,
  SiteCodeSuggestion
} from "./types";

export interface SiteLookupDetail {
  request: SiteCodeLookupRequest;
  suggestions: SiteCodeSuggestion[];
}

export interface PrnReasonLookupDetail {
  request: PrnReasonLookupRequest;
  suggestions: PrnReasonSuggestion[];
}

export interface Token extends AnnotatedLexToken {}

type LocalizedCoding = FhirCoding & { i18n?: Record<string, string> };

export class ParserState {
  input: string;
  tokens: Token[];
  consumed: Set<number>;
  warnings: string[];
  siteTokenIndices: Set<number>;
  siteLookupRequest?: SiteCodeLookupRequest;
  siteLookups: SiteLookupDetail[];
  customSiteHints?: Set<string>;
  prnReasonLookupRequest?: PrnReasonLookupRequest;
  prnReasonLookupRequests?: PrnReasonLookupRequest[];
  prnReasonLookups: PrnReasonLookupDetail[];
  methodVerb?: string;
  productFormKey?: string;
  clauses: CanonicalSigClause[];
  private clause: CanonicalSigClause;

  constructor(input: string, tokens: Token[], customSiteHints?: Set<string>) {
    const dayOfWeek: FhirDayOfWeek[] = [];
    const when: EventTiming[] = [];
    this.clause = {
      kind: "administration",
      rawText: input,
      raw: {
        start: 0,
        end: input.length,
        text: input
      },
      schedule: {
        dayOfWeek,
        when
      },
      leftovers: [],
      evidence: [],
      confidence: 1
    };
    this.input = input;
    this.tokens = tokens;
    this.consumed = new Set<number>();
    this.warnings = [];
    this.siteTokenIndices = new Set<number>();
    this.siteLookups = [];
    this.customSiteHints = customSiteHints;
    this.prnReasonLookups = [];
    this.clauses = [this.clause];
  }

  get primaryClause(): CanonicalSigClause {
    return this.clause;
  }

  get dose(): number | undefined {
    return this.clause.dose?.value;
  }

  set dose(value: number | undefined) {
    this.ensureDose().value = value;
  }

  get doseRange(): CanonicalDoseRange | undefined {
    return this.clause.dose?.range;
  }

  set doseRange(value: CanonicalDoseRange | undefined) {
    this.ensureDose().range = value;
  }

  get unit(): string | undefined {
    return this.clause.dose?.unit;
  }

  set unit(value: string | undefined) {
    this.ensureDose().unit = value;
  }

  get routeCode(): RouteCode | undefined {
    return this.clause.route?.code;
  }

  set routeCode(value: RouteCode | undefined) {
    this.ensureRoute().code = value;
  }

  get routeText(): string | undefined {
    return this.clause.route?.text;
  }

  set routeText(value: string | undefined) {
    this.ensureRoute().text = value;
  }

  get methodText(): string | undefined {
    return this.clause.method?.text;
  }

  set methodText(value: string | undefined) {
    if (value === undefined) {
      if (this.clause.method) {
        delete this.clause.method.text;
        this.cleanupMethod();
      }
      return;
    }
    this.ensureMethod().text = value;
  }

  get methodTextElement(): FhirPrimitiveElement | undefined {
    return this.clause.method?._text;
  }

  set methodTextElement(value: FhirPrimitiveElement | undefined) {
    if (value === undefined) {
      if (this.clause.method) {
        delete this.clause.method._text;
        this.cleanupMethod();
      }
      return;
    }
    this.ensureMethod()._text = clonePrimitiveElement(value);
  }

  get methodCoding(): LocalizedCoding | undefined {
    return this.clause.method?.coding as LocalizedCoding | undefined;
  }

  set methodCoding(value: LocalizedCoding | undefined) {
    if (value === undefined) {
      if (this.clause.method) {
        delete this.clause.method.coding;
        this.cleanupMethod();
      }
      return;
    }
    this.ensureMethod().coding = value?.code
      ? {
        code: value.code,
        display: value.display,
        system: value.system,
        _display: clonePrimitiveElement(value._display),
        i18n: value.i18n
      }
      : undefined;
  }

  get count(): number | undefined {
    return this.clause.schedule?.count;
  }

  set count(value: number | undefined) {
    this.ensureSchedule().count = value;
  }

  get duration(): number | undefined {
    return this.clause.schedule?.duration;
  }

  set duration(value: number | undefined) {
    this.ensureSchedule().duration = value;
  }

  get durationMax(): number | undefined {
    return this.clause.schedule?.durationMax;
  }

  set durationMax(value: number | undefined) {
    this.ensureSchedule().durationMax = value;
  }

  get durationUnit(): FhirPeriodUnit | undefined {
    return this.clause.schedule?.durationUnit;
  }

  set durationUnit(value: FhirPeriodUnit | undefined) {
    this.ensureSchedule().durationUnit = value;
  }

  get frequency(): number | undefined {
    return this.clause.schedule?.frequency;
  }

  set frequency(value: number | undefined) {
    this.ensureSchedule().frequency = value;
  }

  get frequencyMax(): number | undefined {
    return this.clause.schedule?.frequencyMax;
  }

  set frequencyMax(value: number | undefined) {
    this.ensureSchedule().frequencyMax = value;
  }

  get period(): number | undefined {
    return this.clause.schedule?.period;
  }

  set period(value: number | undefined) {
    this.ensureSchedule().period = value;
  }

  get periodMax(): number | undefined {
    return this.clause.schedule?.periodMax;
  }

  set periodMax(value: number | undefined) {
    this.ensureSchedule().periodMax = value;
  }

  get periodUnit(): FhirPeriodUnit | undefined {
    return this.clause.schedule?.periodUnit;
  }

  set periodUnit(value: FhirPeriodUnit | undefined) {
    this.ensureSchedule().periodUnit = value;
  }

  get dayOfWeek(): FhirDayOfWeek[] {
    const schedule = this.ensureSchedule();
    if (!schedule.dayOfWeek) {
      schedule.dayOfWeek = [];
    }
    return schedule.dayOfWeek;
  }

  get when(): EventTiming[] {
    const schedule = this.ensureSchedule();
    if (!schedule.when) {
      schedule.when = [];
    }
    return schedule.when;
  }

  get timeOfDay(): string[] | undefined {
    return this.clause.schedule?.timeOfDay;
  }

  set timeOfDay(value: string[] | undefined) {
    this.ensureSchedule().timeOfDay = value;
  }

  get timingCode(): string | undefined {
    return this.clause.schedule?.timingCode;
  }

  set timingCode(value: string | undefined) {
    this.ensureSchedule().timingCode = value;
  }

  get asNeeded(): boolean | undefined {
    return this.clause.prn?.enabled;
  }

  set asNeeded(value: boolean | undefined) {
    if (value === undefined) {
      delete this.clause.prn;
      return;
    }
    this.ensurePrn().enabled = value;
  }

  get asNeededReason(): string | undefined {
    return this.clause.prn?.reason?.text;
  }

  set asNeededReason(value: string | undefined) {
    if (value === undefined) {
      if (this.clause.prn?.reason) {
        delete this.clause.prn.reason.text;
        this.cleanupPrn();
      }
      return;
    }
    const prn = this.clause.prn ?? (this.clause.prn = { enabled: true });
    if (prn.enabled === undefined) {
      prn.enabled = true;
    }
    if (!prn.reason) {
      prn.reason = {};
    }
    prn.reason.text = value;
  }

  get asNeededReasons(): CanonicalPrnReasonExpr[] | undefined {
    return this.clause.prn?.reasons;
  }

  set asNeededReasons(value: CanonicalPrnReasonExpr[] | undefined) {
    if (!value || !value.length) {
      if (this.clause.prn?.reasons) {
        delete this.clause.prn.reasons;
        this.cleanupPrn();
      }
      return;
    }
    const prn = this.clause.prn ?? (this.clause.prn = { enabled: true });
    if (prn.enabled === undefined) {
      prn.enabled = true;
    }
    const reasons: CanonicalPrnReasonExpr[] = [];
    for (const reason of value) {
      reasons.push({
        text: reason.text,
        spatialRelation: cloneBodySiteSpatialRelation(reason.spatialRelation),
        coding: reason.coding
          ? {
            code: reason.coding.code,
            display: reason.coding.display,
            system: reason.coding.system,
            extension: cloneExtensions(reason.coding.extension),
            _display: clonePrimitiveElement(reason.coding._display),
            i18n: reason.coding.i18n
          }
          : undefined
      });
    }
    prn.reasons = reasons;
  }

  get asNeededReasonCoding(): LocalizedCoding | undefined {
    return this.clause.prn?.reason?.coding as LocalizedCoding | undefined;
  }

  set asNeededReasonCoding(value: LocalizedCoding | undefined) {
    if (value === undefined) {
      if (this.clause.prn?.reason) {
        delete this.clause.prn.reason.coding;
        this.cleanupPrn();
      }
      return;
    }
    const prn = this.clause.prn ?? (this.clause.prn = { enabled: true });
    if (prn.enabled === undefined) {
      prn.enabled = true;
    }
    if (!prn.reason) {
      prn.reason = {};
    }
    prn.reason.coding = value?.code
      ? {
        code: value.code,
        display: value.display,
        system: value.system,
        extension: cloneExtensions(value.extension),
        _display: clonePrimitiveElement(value._display),
        i18n: value.i18n
      }
      : undefined;
  }

  get siteText(): string | undefined {
    return this.clause.site?.text;
  }

  set siteText(value: string | undefined) {
    this.ensureSite().text = value;
  }

  get siteSource(): "abbreviation" | "text" | "selection" | "resolver" | undefined {
    return this.clause.site?.source;
  }

  set siteSource(value: "abbreviation" | "text" | "selection" | "resolver" | undefined) {
    this.ensureSite().source = value;
  }

  get siteCoding(): LocalizedCoding | undefined {
    return this.clause.site?.coding as LocalizedCoding | undefined;
  }

  set siteCoding(value: LocalizedCoding | undefined) {
    if (value === undefined) {
      if (this.clause.site) {
        delete this.clause.site.coding;
        this.cleanupSite();
      }
      return;
    }
    this.ensureSite().coding = value?.code
      ? {
        code: value.code,
        display: value.display,
        system: value.system,
        i18n: value.i18n
      }
      : undefined;
  }

  get siteSpatialRelation(): BodySiteSpatialRelation | undefined {
    return this.clause.site?.spatialRelation;
  }

  set siteSpatialRelation(value: BodySiteSpatialRelation | undefined) {
    if (value === undefined) {
      if (this.clause.site) {
        delete this.clause.site.spatialRelation;
        this.cleanupSite();
      }
      return;
    }
    this.ensureSite().spatialRelation = {
      relationText: value.relationText,
      relationCoding: value.relationCoding
        ? {
          code: value.relationCoding.code,
          display: value.relationCoding.display,
          system: value.relationCoding.system,
          extension: cloneExtensions(value.relationCoding.extension),
          _display: clonePrimitiveElement(value.relationCoding._display),
          i18n: value.relationCoding.i18n
        }
        : undefined,
      targetText: value.targetText,
      targetCoding: value.targetCoding
        ? {
          code: value.targetCoding.code,
          display: value.targetCoding.display,
          system: value.targetCoding.system,
          i18n: value.targetCoding.i18n
        }
        : undefined,
      sourceText: value.sourceText
    };
  }

  get additionalInstructions(): CanonicalAdditionalInstructionExpr[] {
    if (!this.clause.additionalInstructions) {
      this.clause.additionalInstructions = [];
    }
    return this.clause.additionalInstructions;
  }

  set additionalInstructions(value: CanonicalAdditionalInstructionExpr[]) {
    this.clause.additionalInstructions = value;
  }

  get patientInstruction(): string | undefined {
    return this.clause.patientInstruction;
  }

  set patientInstruction(value: string | undefined) {
    this.clause.patientInstruction = value;
  }

  private ensureDose(): NonNullable<CanonicalSigClause["dose"]> {
    if (!this.clause.dose) {
      this.clause.dose = {};
    }
    return this.clause.dose;
  }

  private ensureRoute(): NonNullable<CanonicalSigClause["route"]> {
    if (!this.clause.route) {
      this.clause.route = {};
    }
    return this.clause.route;
  }

  private ensureSite(): NonNullable<CanonicalSigClause["site"]> {
    if (!this.clause.site) {
      this.clause.site = {};
    }
    return this.clause.site;
  }

  private ensureMethod(): NonNullable<CanonicalSigClause["method"]> {
    if (!this.clause.method) {
      this.clause.method = {};
    }
    return this.clause.method;
  }

  private ensureSchedule(): NonNullable<CanonicalSigClause["schedule"]> {
    if (!this.clause.schedule) {
      this.clause.schedule = {};
    }
    return this.clause.schedule;
  }

  private ensurePrn(): NonNullable<CanonicalSigClause["prn"]> {
    if (!this.clause.prn) {
      this.clause.prn = { enabled: false };
    }
    return this.clause.prn;
  }

  private cleanupPrn(): void {
    const prn = this.clause.prn;
    if (!prn) {
      return;
    }
    if (
      prn.reason &&
      prn.reason.text === undefined &&
      prn.reason.coding === undefined
    ) {
      delete prn.reason;
    }
    if (prn.reasons?.length === 0) {
      delete prn.reasons;
    }
    if (prn.enabled === undefined && prn.reason === undefined && prn.reasons === undefined) {
      delete this.clause.prn;
    }
  }

  private cleanupSite(): void {
    const site = this.clause.site;
    if (!site) {
      return;
    }
    if (
      site.text === undefined &&
      site.coding === undefined &&
      site.spatialRelation === undefined &&
      site.source === undefined &&
      site.inferred === undefined &&
      site.evidence === undefined
    ) {
      delete this.clause.site;
    }
  }

  private cleanupMethod(): void {
    const method = this.clause.method;
    if (!method) {
      return;
    }
    if (
      method.text === undefined &&
      method._text === undefined &&
      method.coding === undefined &&
      method.evidence === undefined
    ) {
      delete this.clause.method;
    }
  }
}

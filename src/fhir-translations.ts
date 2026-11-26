import {
  FhirExtension,
  FhirPrimitiveElement,
  FhirR6PrimitiveElement,
  FhirR6Extension
} from "./types";
import { quantityAnnotationExtensions } from "./fhir-quantity-operator";

export const FHIR_TRANSLATION_EXTENSION_URL =
  "http://hl7.org/fhir/StructureDefinition/translation";

const TRANSLATION_LANG_EXTENSION_URL = "lang";
const TRANSLATION_CONTENT_EXTENSION_URL = "content";

function normalizeLocaleKey(locale: string | undefined): string | undefined {
  const trimmed = locale?.trim().toLowerCase();
  return trimmed || undefined;
}

export function cloneI18nRecord(
  i18n: Record<string, string> | undefined
): Record<string, string> | undefined {
  return i18n ? { ...i18n } : undefined;
}

export function mergeI18nRecords(
  ...records: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const locale in record) {
      const normalizedLocale = normalizeLocaleKey(locale);
      const content = record[locale]?.trim();
      if (!normalizedLocale || !content) {
        continue;
      }
      merged[normalizedLocale] = content;
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

export function cloneExtensions(
  extensions: FhirR6Extension[] | undefined
): FhirExtension[] | undefined {
  return extensions?.length
    ? quantityAnnotationExtensions(extensions, "r5") as FhirExtension[] : undefined;
}

export function clonePrimitiveElement(
  element: FhirR6PrimitiveElement | undefined
): FhirPrimitiveElement | undefined {
  if (!element) return undefined;
  const { extension, ...metadata } = element;
  return {
    ...metadata,
    ...(extension ? { extension: cloneExtensions(extension) } : {})
  };
}

function buildTranslationExtension(locale: string, content: string): FhirExtension {
  return {
    url: FHIR_TRANSLATION_EXTENSION_URL,
    extension: [
      {
        url: TRANSLATION_LANG_EXTENSION_URL,
        valueCode: locale
      },
      {
        url: TRANSLATION_CONTENT_EXTENSION_URL,
        valueString: content
      }
    ]
  };
}

export function buildTranslationPrimitiveElement(
  translations: Record<string, string> | undefined,
  base?: FhirPrimitiveElement
): FhirPrimitiveElement | undefined {
  const nextExtensions: FhirExtension[] = [];
  const baseExtensions = base?.extension ?? [];

  for (const extension of baseExtensions) {
    if (extension.url !== FHIR_TRANSLATION_EXTENSION_URL) {
      nextExtensions.push(extension);
    }
  }

  if (translations) {
    for (const locale in translations) {
      const normalizedLocale = normalizeLocaleKey(locale);
      const content = translations[locale]?.trim();
      if (!normalizedLocale || !content) {
        continue;
      }
      nextExtensions.push(buildTranslationExtension(normalizedLocale, content));
    }
  }

  const { extension: _extensions, ...metadata } = base ?? {};
  if (!nextExtensions.length) return Object.keys(metadata).length ? metadata : undefined;
  return { ...metadata, extension: nextExtensions };
}

export function mergeTranslationPrimitiveElement(
  base: FhirPrimitiveElement | undefined,
  translations: Record<string, string> | undefined
): FhirPrimitiveElement | undefined {
  const supplied = mergeI18nRecords(translations), seen = new Set<string>();
  const selected = getPrimitiveTranslations(base);
  const nextExtensions: FhirExtension[] = [];
  for (const extension of base?.extension ?? []) {
    let current = extension;
    if (extension.url === FHIR_TRANSLATION_EXTENSION_URL) {
      const { locale, content } = getTranslationParts(extension);
      if (locale && content) {
        seen.add(locale);
        const replacement = supplied?.[locale];
        // Re-encoding the selected display does not replace other authored
        // variants in that locale. A different supplied translation does.
        if (replacement && replacement !== selected?.[locale] && replacement !== content)
          current = { ...extension, extension: extension.extension?.map(part =>
            part.url === TRANSLATION_CONTENT_EXTENSION_URL ? { ...part, valueString: replacement } : part) };
      }
    }
    nextExtensions.push(current);
  }
  for (const locale in supplied)
    if (!seen.has(locale)) nextExtensions.push(buildTranslationExtension(locale, supplied[locale]));
  return nextExtensions.length ? { ...base, extension: nextExtensions } : base ? { ...base } : undefined;
}

function getTranslationParts(
  extension: FhirR6Extension
): { locale?: string; content?: string } {
  const parts = extension.extension ?? [];
  let locale: string | undefined;
  let content: string | undefined;

  for (const part of parts) {
    switch (part.url) {
      case TRANSLATION_LANG_EXTENSION_URL:
        locale = normalizeLocaleKey(part.valueCode);
        break;
      case TRANSLATION_CONTENT_EXTENSION_URL:
        content = part.valueString?.trim() || undefined;
        break;
      default:
        break;
    }
  }

  return { locale, content };
}

export function getPrimitiveTranslation(
  element: FhirR6PrimitiveElement | undefined,
  locale: string | undefined
): string | undefined {
  const targetLocale = normalizeLocaleKey(locale);
  if (!targetLocale || !element?.extension?.length) {
    return undefined;
  }

  let languagePrefixMatch: string | undefined;

  for (const extension of element.extension) {
    if (extension.url !== FHIR_TRANSLATION_EXTENSION_URL) {
      continue;
    }
    const parts = getTranslationParts(extension);
    if (!parts.locale || !parts.content) {
      continue;
    }
    if (parts.locale === targetLocale) {
      return parts.content;
    }
    if (
      languagePrefixMatch === undefined &&
      (targetLocale.startsWith(`${parts.locale}-`) ||
        parts.locale.startsWith(`${targetLocale}-`))
    ) {
      languagePrefixMatch = parts.content;
    }
  }

  return languagePrefixMatch;
}

export function getPrimitiveTranslations(
  element: FhirR6PrimitiveElement | undefined
): Record<string, string> | undefined {
  if (!element?.extension?.length) {
    return undefined;
  }

  const translations: Record<string, string> = {};
  for (const extension of element.extension) {
    if (extension.url !== FHIR_TRANSLATION_EXTENSION_URL) {
      continue;
    }
    const { locale, content } = getTranslationParts(extension);
    if (!locale || !content) {
      continue;
    }
    translations[locale] = content;
  }

  return Object.keys(translations).length ? translations : undefined;
}

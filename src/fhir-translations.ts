import {
  FhirExtension,
  FhirPrimitiveElement
} from "./types";

export const FHIR_TRANSLATION_EXTENSION_URL =
  "http://hl7.org/fhir/StructureDefinition/translation";

const TRANSLATION_LANG_EXTENSION_URL = "lang";
const TRANSLATION_CONTENT_EXTENSION_URL = "content";

function normalizeLocaleKey(locale: string | undefined): string | undefined {
  const trimmed = locale?.trim().toLowerCase();
  return trimmed || undefined;
}

function cloneExtension(extension: FhirExtension): FhirExtension {
  return {
    url: extension.url,
    extension: extension.extension?.map(cloneExtension),
    valueCode: extension.valueCode,
    valueString: extension.valueString
  };
}

export function clonePrimitiveElement(
  element: FhirPrimitiveElement | undefined
): FhirPrimitiveElement | undefined {
  if (!element?.extension?.length) {
    return undefined;
  }
  return {
    extension: element.extension.map(cloneExtension)
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
      nextExtensions.push(cloneExtension(extension));
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

  if (!nextExtensions.length) {
    return undefined;
  }

  return {
    extension: nextExtensions
  };
}

function getTranslationParts(
  extension: FhirExtension
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
  element: FhirPrimitiveElement | undefined,
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

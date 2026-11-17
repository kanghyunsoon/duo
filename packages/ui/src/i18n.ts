/** Offline UI translations. Project Truth and API machine values stay unchanged. */
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en.js";
import { ko } from "./locales/ko.js";

export type Language = "ko" | "en";
export const LANGUAGE_STORAGE_KEY = "duo.ui.language";

export function initialLanguage(storage?: Pick<Storage, "getItem">): Language {
  try {
    const saved = storage?.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === "ko" || saved === "en") return saved;
  } catch { /* Storage can be disabled; translation must still work. */ }
  return "en";
}

function browserLanguage(): Language {
  if (typeof window === "undefined") return "en";
  try { return initialLanguage(window.localStorage); }
  catch { return "en"; }
}

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ko: { translation: ko } },
  lng: browserLanguage(),
  fallbackLng: "en",
  supportedLngs: ["ko", "en"],
  initAsync: false,
  keySeparator: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/** Shared by render helpers as well as React components. */
export function t(key: string, values?: Record<string, unknown>): string {
  return i18n.t(key, values ?? {});
}

/** Only use for DUO-owned display labels, never for user-authored content. */
export function message(text: string): string {
  const key = `text.${text}`;
  return Object.hasOwn(en, key) ? t(key) : text;
}

export function syncDocumentLanguage(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = i18n.resolvedLanguage ?? "en";
  document.title = t("app.document_title");
}

export async function changeLanguage(language: Language): Promise<void> {
  await i18n.changeLanguage(language);
  if (typeof window !== "undefined") {
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language); }
    catch { /* The selection still applies for this page session. */ }
  }
}

i18n.on("languageChanged", syncDocumentLanguage);
syncDocumentLanguage();

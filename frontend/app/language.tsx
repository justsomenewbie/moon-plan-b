"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { savedLocale, translate } from "../lib/i18n";
import type { Locale, Message, MessageValues } from "../lib/i18n";

const STORAGE_KEY = "moon-plan-b-language";
const LanguageContext = createContext({
  locale: "en" as Locale,
  ready: false,
  choose: (_value: string) => {},
  t: (message: Message, values?: MessageValues) => translate("en", message, values),
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>("en");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try { setLocale(savedLocale(localStorage.getItem(STORAGE_KEY))); } catch { /* English remains the default without storage. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translate(locale, "Moon Plan B — Sun & Earth comparison");
  }, [locale]);

  function choose(value: string) {
    const next = savedLocale(value);
    setLocale(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Switching still works without storage. */ }
  }

  return <LanguageContext value={{ locale, ready, choose, t: (message, values) => translate(locale, message, values) }}>{children}</LanguageContext>;
}

export const useLanguage = () => useContext(LanguageContext);

export function LanguageControl() {
  const { locale, ready, choose, t } = useLanguage();
  return <label className="theme-control language-switch"><span className="sr-only">{t("Language")}</span><select aria-label={t("Language")} value={locale} disabled={!ready} onChange={(event) => choose(event.target.value)}>
    <option value="en" lang="en" aria-label="English">EN</option><option value="vi" lang="vi" aria-label="Tiếng Việt">VI</option>
  </select></label>;
}

"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { savedLocale, translate } from "../lib/i18n";
import type { Locale, Message, MessageValues } from "../lib/i18n";

const STORAGE_KEY = "moon-plan-b-language";
// Browser-tab titles per page; an unknown path is the not-found page.
const pageTitles: Record<string, string> = {
  "/compare": "Comparison tool", "/compare-dates": "Compare dates", "/plan": "Plan a lunar visit", "/plan/site": "Site details",
  "/data": "Data catalog", "/orbit": "Orbit view", "/api-docs": "API explorer",
};
const LanguageContext = createContext({
  locale: "en" as Locale,
  ready: false,
  choose: (_value: string) => {},
  t: (message: Message, values?: MessageValues) => translate("en", message, values),
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>("en");
  const [ready, setReady] = useState(false);
  const path = usePathname() ?? "/";
  const pathname = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  useEffect(() => {
    try { setLocale(savedLocale(localStorage.getItem(STORAGE_KEY))); } catch { /* English remains the default without storage. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    const title = pathname === "/" ? translate(locale, "Moon Plan B — Sun & Earth comparison")
      : translate(locale, pageTitles[pathname] ?? "Page not found") + " — Moon Plan B";
    const apply = () => { if (document.title !== title) document.title = title; };
    apply();
    // The framework writes the page's English metadata title again after the stored language is restored,
    // so keep the translated title in place whenever the <title> element changes.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [locale, pathname]);

  function choose(value: string) {
    const next = savedLocale(value);
    setLocale(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Switching still works without storage. */ }
  }

  return <LanguageContext value={{ locale, ready, choose, t: (message, values) => translate(locale, message, values) }}>{children}</LanguageContext>;
}

export const useLanguage = () => useContext(LanguageContext);

const languages = [["en", "English"], ["vi", "Tiếng Việt"]] as const;

export function LanguageControl() {
  const { locale, ready, choose, t } = useLanguage();
  return <div className="segmented language-switch" role="group" aria-label={t("Language")}>
    {languages.map(([code, name]) => <button key={code} type="button" lang={code} aria-label={`${code.toUpperCase()} · ${name}`} aria-pressed={locale === code}
      disabled={!ready} onClick={() => choose(code)}>{code.toUpperCase()}</button>)}
  </div>;
}

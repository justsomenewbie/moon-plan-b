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
    document.title = pathname === "/" ? translate(locale, "Moon Plan B — Sun & Earth comparison")
      : translate(locale, pageTitles[pathname] ?? "Page not found") + " — Moon Plan B";
  }, [locale, pathname]);

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
  return <label className="language-switch"><span className="sr-only">{t("Language")}</span>
    <select aria-label={t("Language")} value={locale} disabled={!ready} onChange={event => choose(event.target.value)}>
      <option value="en" lang="en" aria-label="English">EN</option><option value="vi" lang="vi" aria-label="Tiếng Việt">VI</option>
    </select></label>;
}

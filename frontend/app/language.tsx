"use client";

import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
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

// Small inline flags: emoji flags render as the letters "US" / "VN" on Windows.
function UsFlag() {
  return <svg className="flag" viewBox="0 0 20 14" width="20" height="14" aria-hidden="true" focusable="false">
    <rect width="20" height="14" fill="#FFFFFF" />
    {[0, 2, 4, 6, 8, 10, 12].map(stripe => <rect key={stripe} y={stripe * 14 / 13} width="20" height={14 / 13} fill="#B22234" />)}
    <rect width="8.6" height={14 * 7 / 13} fill="#3C3B6E" />
    {[[2.2, 1.9], [4.3, 1.9], [6.4, 1.9], [3.25, 3.75], [5.35, 3.75], [2.2, 5.6], [4.3, 5.6], [6.4, 5.6]].map(([x, y]) =>
      <circle key={x + "-" + y} cx={x} cy={y} r=".55" fill="#FFFFFF" />)}
  </svg>;
}

function VietnamFlag() {
  return <svg className="flag" viewBox="0 0 20 14" width="20" height="14" aria-hidden="true" focusable="false">
    <rect width="20" height="14" fill="#DA251D" />
    <polygon fill="#FFCD00" points="10,2.8 10.94,5.7 13.99,5.7 11.53,7.5 12.47,10.4 10,8.6 7.53,10.4 8.47,7.5 6.01,5.7 9.06,5.7" />
  </svg>;
}

const languages = [
  { code: "en", name: "English", Flag: UsFlag },
  { code: "vi", name: "Tiếng Việt", Flag: VietnamFlag },
] as const;

// A menu button with a listbox popup: a native select cannot show the flags.
export function LanguageControl() {
  const { locale, ready, choose, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const current = languages.find(language => language.code === locale) ?? languages[0];

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function show() {
    setActive(Math.max(0, languages.findIndex(language => language.code === locale)));
    setOpen(true);
  }
  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }
  function select(index: number) {
    choose(languages[index].code);
    close(true);
  }

  return <div className="language-switch" ref={root}>
    <button ref={button} type="button" className="language-button" aria-haspopup="listbox" aria-expanded={open}
      aria-controls={id + "-list"} aria-label={t("Language") + ": " + current.name} disabled={!ready}
      onClick={() => open ? close(false) : show()}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); }
      }}>
      <current.Flag /><span>{current.code.toUpperCase()}</span>
    </button>
    <ul ref={list} id={id + "-list"} className="language-list" role="listbox" tabIndex={-1} hidden={!open}
      aria-label={t("Language")} aria-activedescendant={id + "-" + languages[active].code}
      onBlur={event => { if (!root.current?.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={event => {
        if (event.key === "ArrowDown") { event.preventDefault(); setActive((active + 1) % languages.length); }
        else if (event.key === "ArrowUp") { event.preventDefault(); setActive((active + languages.length - 1) % languages.length); }
        else if (event.key === "Home") { event.preventDefault(); setActive(0); }
        else if (event.key === "End") { event.preventDefault(); setActive(languages.length - 1); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(active); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === "Tab") setOpen(false);
      }}>
      {languages.map((language, index) => <li key={language.code} id={id + "-" + language.code} role="option" lang={language.code}
        aria-selected={language.code === locale} data-active={index === active || undefined}
        onPointerEnter={() => setActive(index)} onClick={() => select(index)}>
        <language.Flag /><span>{language.name}</span>
      </li>)}
    </ul>
  </div>;
}

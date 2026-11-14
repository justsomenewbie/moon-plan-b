"use client";

import { useEffect, useState } from "react";
import { localTheme, savedTheme } from "../lib/theme";
import type { ThemeMode } from "../lib/theme";
import { useLanguage } from "./language";

const STORAGE_KEY = "moon-plan-b-theme";

export default function ThemeControl() {
  const { t } = useLanguage();
  const [mode, setMode] = useState<ThemeMode | null>(null);

  const [appearance, setAppearance] = useState<"light" | "dark">("dark");

  useEffect(() => {
    try { setMode(savedTheme(localStorage.getItem(STORAGE_KEY))); }
    catch { setMode("auto"); }
  }, []);

  useEffect(() => {
    if (!mode) return;
    const update = () => {
      const applied = localTheme(mode, new Date());
      document.documentElement.dataset.theme = applied;
      setAppearance(applied);
    };
    update();
    if (mode !== "auto") return;
    const timer = window.setInterval(update, 60000);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [mode]);

  function choose(value: string) {
    const next = savedTheme(value);
    setMode(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Appearance still works when storage is unavailable. */ }
  }

  const action = appearance === "light" ? "Switch to dark appearance" : "Switch to light appearance";
  return <div className="appearance-switch">
    <button className="theme-disc" type="button" disabled={!mode} title={t(action)} aria-label={t(action)}
      onClick={() => choose(appearance === "light" ? "dark" : "light")}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        {appearance === "light" ? <path d="M20 14.25A8.5 8.5 0 0 1 9.75 4a8.5 8.5 0 1 0 10.25 10.25Z"/> :
          <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/></>}
      </svg>
    </button>
    <button type="button" className="theme-auto" disabled={!mode} aria-pressed={mode === "auto"}
      aria-describedby="theme-help" onClick={() => choose(mode === "auto" ? appearance : "auto")}>{t("Auto")}</button>
    <span className="sr-only" id="theme-help">{t("Auto uses light from 07:00 to 19:00 on your device, and dark otherwise. Observation times remain UTC.")}</span>
  </div>;
}

"use client";

import { useEffect, useState } from "react";
import { followsClock, localTheme, nextThemeBoundary, savedTheme, toggleAppearance, toggleAuto } from "../lib/theme";
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
    let timer = 0;
    const update = () => {
      const now = new Date();
      const applied = localTheme(mode, now);
      document.documentElement.dataset.theme = applied;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", applied === "light" ? "#EEF1F6" : "#0B0F1A");
      setAppearance(applied);
      if (!followsClock(mode)) return;
      // Wake at the next local 06:00 or 18:00; one second late so the clock has passed the boundary.
      window.clearTimeout(timer);
      timer = window.setTimeout(update, nextThemeBoundary(now).getTime() - now.getTime() + 1000);
    };
    update();
    // An explicit Light or Dark choice installs no timer and no visibility listener.
    if (!followsClock(mode)) return;
    const refresh = () => { if (!document.hidden) update(); };
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [mode]);

  function choose(next: ThemeMode) {
    setMode(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Appearance still works when storage is unavailable. */ }
  }

  // The icon button always sets an explicit appearance, which turns Auto off. The Auto button toggles:
  // pressing it while on keeps the current theme as an explicit choice.
  const action = appearance === "light" ? "Switch to dark appearance" : "Switch to light appearance";
  return <div className="appearance-switch">
    <button className="theme-disc" type="button" disabled={!mode} title={t(action)} aria-label={t("Dark")} aria-pressed={appearance === "dark"}
      onClick={() => choose(toggleAppearance(appearance))}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        {appearance === "light" ? <path d="M20 14.25A8.5 8.5 0 0 1 9.75 4a8.5 8.5 0 1 0 10.25 10.25Z"/> :
          <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/></>}
      </svg>
    </button>
    <button type="button" className="theme-auto" disabled={!mode} aria-pressed={mode === "auto"}
      aria-describedby="theme-help" onClick={() => { if (mode) choose(toggleAuto(mode, appearance)); }}>{t("Auto")}</button>
    <span className="sr-only" id="theme-help">{t("Auto uses light from 06:00 to 18:00 on your device clock, and dark otherwise. Observation times remain UTC.")}</span>
  </div>;
}

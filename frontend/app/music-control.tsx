"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "./language";

// Background music ("Orbital Atlas"). One shared <audio> for the whole visit, so client-side navigation
// does not restart it. Browsers block sound until the visitor interacts with the page, so if the first
// play() is refused the track starts on the first click, tap or key press. The choice is remembered.
const STORAGE_KEY = "moon-plan-b-music";
const VOLUME = 0.3;

let audio: HTMLAudioElement | null = null;
const listeners = new Set<(playing: boolean) => void>();

function track() {
  if (audio) return audio;
  const a = new Audio();
  const opus = a.canPlayType('audio/webm; codecs="opus"');
  a.src = opus ? "/audio/orbital-atlas.webm" : "/audio/orbital-atlas.m4a";
  a.loop = true;
  a.volume = VOLUME;
  a.preload = "none";
  const notify = () => listeners.forEach(fn => fn(!a.paused));
  a.addEventListener("play", notify);
  a.addEventListener("pause", notify);
  audio = a;
  return a;
}

function savedOn() {
  try { return localStorage.getItem(STORAGE_KEY) !== "off"; } catch { return true; }
}
function save(on: boolean) {
  try { localStorage.setItem(STORAGE_KEY, on ? "on" : "off"); } catch { /* storage blocked: keep the in-page state */ }
}

let armed = false;
function startWhenAllowed() {
  if (armed) return;
  armed = true;
  const events = ["pointerdown", "keydown", "touchstart"] as const;
  const start = (event: Event) => {
    // A press on the music button itself is handled by its own toggle.
    if (event.target instanceof Element && event.target.closest(".music-toggle")) return;
    events.forEach(e => window.removeEventListener(e, start, true));
    armed = false;
    if (savedOn()) void track().play().catch(() => undefined);
  };
  events.forEach(e => window.addEventListener(e, start, { capture: true, passive: true }));
}

export default function MusicControl() {
  const { t } = useLanguage();
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    listeners.add(setPlaying);
    if (audio) setPlaying(!audio.paused);
    else if (savedOn()) {
      // Try right away; most browsers refuse until the first interaction, then the listener starts it.
      track().play().catch(() => startWhenAllowed());
    }
    return () => { listeners.delete(setPlaying); };
  }, []);

  const toggle = () => {
    const a = track();
    if (a.paused) { save(true); void a.play().catch(() => undefined); }
    else { save(false); a.pause(); }
  };

  const label = playing ? t("Turn background music off") : t("Turn background music on");
  return <button type="button" className="theme-disc music-toggle" aria-pressed={playing} aria-label={label} title={label} onClick={toggle}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4z" />
      {playing
        ? <><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></>
        : <><path d="m16 9 5 6" /><path d="m21 9-5 6" /></>}
    </svg>
  </button>;
}

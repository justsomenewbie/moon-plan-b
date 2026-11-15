"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { allows3D } from "./gate";
import "./three.css";

// Three.js lives in its own chunk. Nothing requests it until this component renders <ThreeCanvas />.
const ThreeCanvas = dynamic(() => import("./three-canvas"), { ssr: false });

const firstInput = ["pointerdown", "pointermove", "keydown", "touchstart", "scroll"] as const;

// Decorative backdrop for every page. It waits for the page to finish loading, then for the first
// input or two quiet seconds, and only starts in a visible tab.
export default function ThreeBackdrop() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
    if (!allows3D({
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      saveData: nav.connection?.saveData,
      deviceMemory: nav.deviceMemory,
    })) return;
    let timer = 0;
    let idle = 0;
    let done = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      if (idle && "cancelIdleCallback" in window) window.cancelIdleCallback(idle);
      window.removeEventListener("load", arm);
      document.removeEventListener("visibilitychange", start);
      for (const type of firstInput) window.removeEventListener(type, soon);
    };
    function start() {
      if (done) return;
      if (document.hidden) { document.addEventListener("visibilitychange", start); return; }
      done = true;
      cleanup();
      setReady(true);
    }
    // Never start inside an input handler: hand over to the next idle period.
    function whenIdle(timeout: number) {
      if (idle) return;
      if ("requestIdleCallback" in window) idle = window.requestIdleCallback(start, { timeout });
      else timer = globalThis.setTimeout(start, 200) as unknown as number;
    }
    function soon() { whenIdle(600); }
    function arm() {
      for (const type of firstInput) window.addEventListener(type, soon, { passive: true, once: true });
      timer = window.setTimeout(() => whenIdle(1500), 2000);
    }
    if (document.readyState === "complete") arm();
    else window.addEventListener("load", arm, { once: true });
    return cleanup;
  }, []);
  return ready ? <ThreeCanvas /> : null;
}

"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

// A secondary section that starts collapsed on a phone to shorten the page. From 761px up it is always open
// and its summary is hidden (see mobile.css), so wider screens and print look as they did before.
export default function MobileFold({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const fold = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const phone = window.matchMedia("(max-width: 760px)");
    // A link to something inside the fold, or to the section that holds it, opens it.
    const linked = () => {
      const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
      return Boolean(target && fold.current && (fold.current.contains(target) || target === fold.current.parentElement));
    };
    const reveal = () => setOpen(true);
    const follow = () => { if (linked()) reveal(); };
    const resize = () => { if (!phone.matches) reveal(); };
    if (phone.matches && !linked()) setOpen(false);
    window.addEventListener("hashchange", follow);
    window.addEventListener("beforeprint", reveal);
    phone.addEventListener("change", resize);
    return () => {
      window.removeEventListener("hashchange", follow);
      window.removeEventListener("beforeprint", reveal);
      phone.removeEventListener("change", resize);
    };
  }, []);
  return <details ref={fold} className="mobile-fold" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {children}
  </details>;
}

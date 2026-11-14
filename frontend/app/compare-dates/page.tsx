"use client";

import { useEffect, useState } from "react";
import type { TerrainDateRequest } from "../../lib/api/terrain-dates";
import { isMock } from "../../lib/api/client";
import { readTerrainDateLink, terrainDatesHref } from "../../lib/terrain-date-link";
import { LanguageControl, useLanguage } from "../language";
import ThemeControl from "../theme-control";
import TerrainDates from "../terrain-dates";

export default function DateComparisonPage() {
  const { t } = useLanguage();
  const [request, setRequest] = useState<TerrainDateRequest>();
  const [error, setError] = useState("");
  useEffect(() => {
    function restore() {
      try {
        if (isMock) throw new Error("This comparison requires a live team backend.");
        setRequest(readTerrainDateLink(new URLSearchParams(window.location.search)));
        setError("");
      } catch (e) {
        setRequest(undefined);
        setError(e instanceof Error ? e.message : "The shared selection is invalid.");
      }
    }
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  return <div className="app-shell">
    <header className="app-header"><a href="/" className="brand">Moon Plan B</a>
      <nav aria-label={t("Main")}><LanguageControl /><ThemeControl /></nav>
    </header>
    <main id="workspace" className="terrain-result">
      <h1>{t("Compare dates")}</h1>
      {error ? <p role="alert">{t(error)}</p> : request
        ? <TerrainDates key={terrainDatesHref(request)} initialRequest={request}
            onCompared={next => window.history.replaceState(window.history.state, "", terrainDatesHref(next))} />
        : <p role="status">{t("Loading dataset…")}</p>}
      <a className="terrain-print" href="/#workspace">{t("Open the observation workspace")}</a>
    </main>
  </div>;
}

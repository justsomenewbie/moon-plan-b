"use client";

import { useEffect, useState } from "react";
import type { TerrainDateRequest } from "../../lib/api/terrain-dates";
import { isMock } from "../../lib/api/client";
import { readTerrainDateLink, terrainDatesHref } from "../../lib/terrain-date-link";
import { useLanguage } from "../language";
import { SiteFooter, SiteHeader, SkyBackground } from "../site-chrome";
import TerrainDates from "../terrain-dates";

export default function DateComparisonPage() {
  const { t } = useLanguage();
  const [request, setRequest] = useState<TerrainDateRequest>();
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    function restore() {
      try {
        setEmpty(!window.location.search);
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
  return <div className="app-shell"><SkyBackground />
    <a className="skip-link" href="#workspace">{t("Skip to content")}</a>
    <SiteHeader />
    <main id="workspace" className="terrain-result" tabIndex={-1}>
      <h1>{t("Compare dates")}</h1>
      {empty ? <section className="card empty-card" aria-labelledby="dates-empty-title">
          <h2 id="dates-empty-title">{t("No dates selected yet")}</h2>
          <p>{t("Pick one site and two UTC date ranges to see which period gives more Sun and Earth visibility.")}</p>
          <div className="hero-actions">
            <a className="button primary" href="/plan?mode=dates">{t("Find dates for my site")}</a>
            <a className="button outline" href="/compare#workspace">{t("Open comparison tool")}</a>
          </div>
        </section> : error ? <p role="alert">{t(error)}</p> : request
        ? <TerrainDates key={terrainDatesHref(request)} initialRequest={request}
            onCompared={next => window.history.replaceState(window.history.state, "", terrainDatesHref(next))} />
        : <p role="status">{t("Loading dataset…")}</p>}
      {!empty && <a className="terrain-print" href="/compare#workspace">{t("Open the observation workspace")}</a>}
    </main>
    <SiteFooter />
  </div>;
}

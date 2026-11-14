"use client";

import { useState } from "react";
import { archiveB2Run, rankArchiveB2 } from "../../lib/archive-b2";
import { missionSites } from "../../lib/globe-sites";
import { LanguageControl, useLanguage } from "../language";
import MoonGlobe from "../moon-globe";
import SiteSky from "./site-sky";
import "./orbit.css";

const weeks = [["2026-11-14", "2026-11-21"], ["2026-11-21", "2026-11-28"]] as const;
const results = weeks.map(([from, to]) => rankArchiveB2({ from, to, priority: "joint" }));
const sites = [missionSites[1], missionSites[0]];

export default function Orbit() {
  const { t } = useLanguage();
  const [site, setSite] = useState(sites[0]);
  const [week, setWeek] = useState(0);
  const [surface, setSurface] = useState(false);
  const [from, to] = weeks[week];
  const rows = results[week]?.rows;
  const reading = rows?.find(row => row.id === site.id);
  const peer = sites.find(item => item.id !== site.id)!;
  const other = rows?.find(row => row.id === peer.id);
  const name = site.name.split(" · ")[0], otherName = peer.name.split(" · ")[0];
  const labels = ["14–20 Nov", "21–27 Nov"];
  const planner = "/plan?" + new URLSearchParams({ mode: "sites", source: "saved-b2", from, to, priority: "joint" });
  const observation = "/compare?" + new URLSearchParams({ run_id: archiveB2Run.runId, site_id: site.id, view_site: site.id,
    from: from + "T00:00:00Z", to: to + "T00:00:00Z", resolutionSeconds: "3600" }) + "#terrain-observations";
  const inspect = (id: string) => { const next = sites.find(item => item.id === id); if (next) setSite(next); };
  return <main className="orbit-page">
    <div className="orbit-bar"><a href="/" className="orbit-brand">Moon Plan B</a><span>{t(surface ? "At the landing site" : "Orbit view")}</span><LanguageControl /></div>
    <div className="orbit-layout">
      <header className="orbit-heading"><p className="orbit-kicker">{t("Lunar south pole")}</p>
        <h1>{t("Where can we see both the Sun and Earth?")}</h1></header>
      <div className="orbit-stage">
        <button type="button" className="orbit-view-switch" aria-expanded={surface} aria-controls="site-view" onClick={() => setSurface(!surface)}>
          {t(surface ? "Return to the Moon" : "See the sky from this site")} <span aria-hidden="true">{surface ? "↑" : "↓"}</span>
        </button>
        <div id="site-view">{surface ? <SiteSky siteId={site.id} weekUtc={from + "T00:00:00Z"} />
          : <MoonGlobe home orbit={{ site, weekUtc: from + "T00:00:00Z", onSite: inspect }} />}</div>
      </div>
      <section className="orbit-panel" aria-label={t("Landing site comparison")}>
        <div className="orbit-tabs" role="group" aria-label={t("Landing site")}>{sites.map(item =>
          <button type="button" key={item.id} aria-pressed={site === item} onClick={() => inspect(item.id)}>{item.name.split(" · ")[0]}</button>)}</div>
        <div className="orbit-reading" aria-live="polite" aria-atomic="true">
          <h2>{name}</h2>
          <p className="orbit-value">{reading ? <>{reading.bothHours}<small> / 168 h</small></> : t("Unavailable")}</p>
          <p>{t("with both the Sun and Earth in view")}</p>
          <p className="orbit-other">{other && reading && (other.bothHours === reading.bothHours
            ? t("{site} has the same visibility this week.", { site: otherName }) : t("{site} has {hours} h in the same week.", { site: otherName, hours: other.bothHours }))}</p>
        </div>
        <div className="orbit-weeks" role="group" aria-label={t("Comparison week")}>
          <span>2026 · UTC</span>{weeks.map((item, i) =>
            <button type="button" key={item[0]} aria-pressed={i === week} onClick={() => setWeek(i)}>{t(labels[i])}</button>)}
        </div>
        <a className="orbit-detail-link" href={planner}>{t("Compare all 23 sites")} →</a>
      </section>
    </div>
    <details className="orbit-method"><summary>{t("How to read this view")} · B2</summary>
      <p>{t("On the interactive globe, lighting shows the smooth Moon at 00:00 UTC on the first day. The backup photograph is undated. The hours use terrain sampled hourly for the week; they do not predict battery life or radio quality.")}</p>
      <p><a href="/data/run-b2/manifest.json">{t("Model manifest")}</a> · <a href="/data/run-b2/visibility.json">{t("Visibility intervals")}</a> · <a href="https://svs.gsfc.nasa.gov/4720/">LRO · {t("Surface map")}</a> · <a href="https://svs.gsfc.nasa.gov/5001/">LRO · {t("Photograph")}</a> · <a href="https://ssd.jpl.nasa.gov/horizons/">JPL Horizons</a></p>
      <p><a href={observation}>{t("Inspect this site and week with the live API")} →</a></p>
      <p>{t("Source run")}: <code>{archiveB2Run.runId}</code></p>
      <a href="/compare?saved=2026-11-14T00%3A00%3A00Z#observed-week">{t("Earlier example · run B")}</a>
    </details>
  </main>;
}

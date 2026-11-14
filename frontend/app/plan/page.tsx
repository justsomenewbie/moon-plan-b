"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isMock } from "../../lib/api/client";
import { getPlannerRanking, getPlannerRun, type PlannerRun } from "../../lib/api/planner";
import { useLanguage, LanguageControl } from "../language";
import MissionDateSearch from "../mission-date-search";
import { SiteFooter, SkyBackground } from "../site-chrome";
import { TimeRange } from "../terrain-site-result";
import ThemeControl from "../theme-control";
import AstronautGuide from "../astronaut-guide";
import { savedResultFromUrl } from "../observed-week";
import "./plan.css";

type Priority = "joint" | "sun" | "earth";
const criteria = { joint: "Sun and Earth together", sun: "Sunlight", earth: "Earth visibility" } as const;
const DAY = 86400000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const midnight = (date: string) => date + "T00:00:00Z";

function CatalogSearch({ run, first, last, priority }: { run: PlannerRun; first: string; last: string; priority: Priority }) {
  const { t } = useLanguage();
  const [result, setResult] = useState<Awaited<ReturnType<typeof getPlannerRanking>>>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState(priority);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  function clear() {
    active.current?.abort(); setPending(false); setError(""); setResult(undefined);
  }
  return <section aria-labelledby="catalog-question">
    <h2 id="catalog-question">{t("Which site fits my dates?")}</h2>
    <form className="request-fields" onChange={clear} onSubmit={async e => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      const from = midnight(String(form.get("from"))), to = midnight(String(form.get("to")));
      clear();
      const controller = new AbortController();
      active.current = controller;
      setPending(true);
      try {
        const next = await getPlannerRanking(run, { from, to, priority: metric }, controller.signal);
        if (!controller.signal.aborted) setResult(next);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The request could not be completed. Retry or check the connection.");
      } finally { if (!controller.signal.aborted) setPending(false); }
    }}>
      <label className="field">{t("Start date (UTC)")}<input name="from" type="date" required min={run.start.slice(0,10)} max={day(Date.parse(run.end) - DAY)} defaultValue={first} /></label>
      <label className="field">{t("End date (UTC, exclusive)")}<input name="to" type="date" required min={day(Date.parse(run.start) + DAY)} max={run.end.slice(0,10)} defaultValue={last} /></label>
      <label className="field">{t("Rank sites by")}<select name="priority" value={metric} onChange={e => setMetric(e.target.value as Priority)}>
        {Object.entries(criteria).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
      </select></label>
      <button className="button primary" disabled={pending}>{t("Find sites")}</button>
    </form>
    {pending && <p role="status">{t("Checking visibility for the catalog…")}</p>}
    {error && <p role="alert">{t(error)}</p>}
    {result && <section aria-label={t("Site search results")} className="plan-results">
      <h3>{t("Site search results")}</h3>
      <p><TimeRange start={result.ranking.range.start} end={result.ranking.range.end} /> · {t(criteria[metric])}</p>
      <p className="data-notice">{result.recommendedIds.length
        ? t("Highest percentage among sites with complete coverage: {sites}.", { sites: result.ranking.ranking.filter(r => result.recommendedIds.includes(r.site_id)).map(r => r.name).join(" · ") })
        : t("No site has enough coverage for a recommendation.")}</p>
      <div className="table-scroll"><table><caption>{t("All sites in this run")}</caption>
        <thead><tr><th scope="col">{t("Site")}</th><th scope="col">{t("Sun visible")}</th><th scope="col">{t("Earth visible")}</th><th scope="col">{t("Both visible")}</th><th scope="col">{t("Longest joint window")}</th></tr></thead>
        <tbody>{result.ranking.ranking.map(row => {
          const site = result.evidence.sites.find(s => s.id === row.site_id)!;
          const complete = site.coverage_in_range === "complete" && site.metrics !== null;
          const bounds = result.ranking.range;
          const href = "/compare?" + new URLSearchParams({ run_id: run.runId, site_id: row.site_id, view_site: row.site_id, from: bounds.start, to: bounds.end, resolutionSeconds: "3600" }) + "#terrain-observations";
          return <tr key={row.site_id}><th scope="row">{run.stepSeconds === 3600 && Date.parse(bounds.end) - Date.parse(bounds.start) <= 366 * DAY ? <a href={href}>{row.name}</a> : row.name}</th>
            {complete ? <><td>{row.pct_sun}%</td><td>{row.pct_earth}%</td><td>{row.pct_both}%</td><td>{site.metrics!.longest_both_h} h</td></> : <td colSpan={4}>{t("Coverage")} · {t(site.coverage_in_range)}</td>}</tr>;
        })}</tbody></table></div>
      <p className="muted text-sm">{t("Visibility alone does not measure solar power or radio signal strength.")} · {t("Run ID")} <code>{run.runId}</code></p>
    </section>}
  </section>;
}

function Planner({ seed }: { seed: URLSearchParams }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState(seed.get("mode") === "dates" ? "dates" : "sites");
  const catalog = useQuery({ queryKey: ["mission-planner-run"], queryFn: ({signal}) => getPlannerRun(signal), enabled: !isMock });
  if (isMock) return <div className="data-notice"><p>{t("This preview uses sample data. Searching the model catalog requires a connection to the team API.")}</p><a href="/compare#observed-week">{t("Try the saved example")}</a></div>;
  if (catalog.isPending) return <p role="status">{t("Loading sites for this run…")}</p>;
  if (!catalog.data) return <div role="alert"><p>{t(catalog.error?.message ?? "The default model run or its site catalog is unavailable.")}</p><button className="button outline" onClick={() => void catalog.refetch()}>{t("Retry site list")}</button></div>;
  const run = catalog.data;
  const today = day(Date.now());
  const seedDay = (key: string, fallback: string) => {
    const v = seed.get(key);
    return v && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(midnight(v))) && day(Date.parse(midnight(v))) === v ? v : fallback;
  };
  const first = seedDay("from", today >= run.start.slice(0,10) && today < run.end.slice(0,10) ? today : run.start.slice(0,10));
  const last = seedDay("to", day(Math.min(Date.parse(midnight(first)) + 7*DAY, Date.parse(run.end))));
  const sort = seed.get("priority");
  const priority = sort === "sun" || sort === "earth" ? sort : "joint";
  const mission = Number(seed.get("missionHours"));
  return <>
    <p className="plan-coverage">{t("{count} sites · model coverage (UTC, end exclusive)", {count:run.sites.length})}<br/><TimeRange start={run.start} end={run.end} /> · {t("Model step")} {run.stepSeconds / 3600} h</p>
    <div className="mode-switch" role="group" aria-label={t("Choose how to search")}>
      <button type="button" aria-pressed={mode === "sites"} onClick={() => setMode("sites")}>{t("I have dates")}</button>
      <button type="button" aria-pressed={mode === "dates"} onClick={() => setMode("dates")}>{t("I have a site")}</button>
    </div>
    {mode === "sites" ? <CatalogSearch run={run} first={first} last={last} priority={priority} /> :
      <MissionDateSearch runId={run.runId} sites={run.sites} stepSeconds={run.stepSeconds} from={midnight(first)} to={midnight(last)}
        coverageStart={run.start} coverageEnd={run.end} initialSiteId={seed.get("site") ?? undefined}
        initialMissionHours={mission > 0 && Number.isInteger(mission) ? mission : undefined} initialObjective={priority === "joint" ? "both" : priority} />}
  </>;
}

export default function PlanPage() {
  const { t } = useLanguage();
  const [seed,setSeed] = useState<URLSearchParams>();
  useEffect(() => {
    function read() { setSeed(new URLSearchParams(window.location.search)); }
    read(); window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  return <div className="app-shell"><SkyBackground />
    <header className="app-header"><a className="brand" href="/">Moon Plan B</a><nav aria-label={t("Main")}><a href="/compare">{t("Compare")}</a><LanguageControl /><ThemeControl /></nav></header>
    <main className="plan-main"><h1>{t("Plan a lunar visit")}</h1>{seed && <Planner key={seed.toString()} seed={seed} />}</main>
    <AstronautGuide savedResult={savedResultFromUrl(new URLSearchParams())} terrain={null} comparisonPath="/compare" /><SiteFooter />
  </div>;
}

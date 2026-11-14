"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { hasLiveOptions, landingClock, liveExtras, plannerFormState, type PlannerSource } from "../../lib/planner-source";
import { useQuery } from "@tanstack/react-query";
import { isMock } from "../../lib/api/client";
import { getPlannerRanking, getPlannerRun, type PlannerRun, type PlannerPriority } from "../../lib/api/planner";
import { archiveB2Run, rankArchiveB2 } from "../../lib/archive-b2";
import { getSavedPlannerRanking, savedPlannerRun, savedPlannerWindows } from "../../lib/saved-planner";
import { useLanguage, LanguageControl } from "../language";
import MissionDateSearch from "../mission-date-search";
import SavedLanding from "./saved-landing";
import { SiteFooter, SkyBackground } from "../site-chrome";
import { TimeRange } from "../terrain-site-result";
import ThemeControl from "../theme-control";
import AstronautGuide from "../astronaut-guide";
import { savedResultFromUrl } from "../observed-week";
import "./plan.css";

const criteria = { joint: "Sun and Earth together", sun: "Sunlight", earth: "Earth visibility" } as const;
const DAY = 86400000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const midnight = (date: string) => date + "T00:00:00Z";
const planLink = (params: Record<string, string>) => "/plan?" + new URLSearchParams(params);
type SearchResult = {
  from: string; to: string; scope: "live" | "catalog" | "pair";
  rows: { id: string; name: string; hours: number[] | null; longest?: number; coverage?: string }[];
  leaders: string[];
};

function storedResult(from: string, to: string, priority: PlannerPriority, source: PlannerSource): SearchResult | null {
  const saved = source === "saved-b2" ? rankArchiveB2({ from, to, priority }) : getSavedPlannerRanking({ from, to, priority });
  return saved && { ...saved, rows: saved.rows.map(s => ({ id: s.id, name: s.name, hours: [s.sunHours, s.earthHours, s.bothHours] })) };
}

function CatalogSearch({ run, first, last, priority, source }: { run: PlannerRun; first: string; last: string; priority: PlannerPriority; source: PlannerSource }) {
  const { t } = useLanguage();
  const [result, setResult] = useState<SearchResult | null>(() => source === "live" ? null : storedResult(first, last, priority, source));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState(priority);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  function clear() { active.current?.abort(); setPending(false); setError(""); setResult(null); }
  const best = result?.rows.filter(r => result.leaders.includes(r.id)) ?? [];
  const column = { sun: 0, earth: 1, joint: 2 }[metric];
  return <section aria-labelledby="catalog-question">
    <h2 id="catalog-question">{t("Which site fits my dates?")}</h2>
    <form className="request-fields print:hidden" onChange={clear} onSubmit={async e => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      const from = midnight(String(form.get("from"))), to = midnight(String(form.get("to")));
      clear();
      if (from < run.start || to > run.end || from >= to) { setError("Choose an increasing UTC window inside the model run."); return; }
      if (source !== "live") {
        const next = storedResult(from, to, metric, source);
        setResult(next);
        if (!next) setError("No saved observations cover this request. Choose a saved range below or connect to the team API.");
        return;
      }
      const controller = new AbortController(); active.current = controller; setPending(true);
      try {
        const { ranking, evidence, recommendedIds } = await getPlannerRanking(run, { from, to, priority: metric }, controller.signal);
        if (!controller.signal.aborted) setResult({ from: ranking.range.start, to: ranking.range.end, scope: "live", leaders: recommendedIds,
          rows: ranking.ranking.map(row => {
            const site = evidence.sites.find(s => s.id === row.site_id)!;
            const m = site.coverage === "complete" && site.coverage_in_range === "complete" ? site.metrics : null;
            return { id: row.site_id, name: row.name, hours: m && [m.sun_hours, m.earth_hours, m.both_hours], longest: m?.longest_both_h, coverage: site.coverage_in_range };
          }) });
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The request could not be completed. Retry or check the connection.");
      } finally { if (!controller.signal.aborted) setPending(false); }
    }}>
      <label className="field">{t("Start date (UTC)")}<input name="from" type="date" required min={run.start.slice(0,10)} max={day(Date.parse(run.end) - DAY)} defaultValue={first} /></label>
      <label className="field">{t("End date (UTC, exclusive)")}<input name="to" type="date" required min={day(Date.parse(run.start) + DAY)} max={run.end.slice(0,10)} defaultValue={last} /></label>
      <label className="field">{t("Rank sites by")}<select name="priority" value={metric} onChange={e => setMetric(e.target.value as PlannerPriority)}>
        {Object.entries(criteria).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
      </select></label>
      <button className="button primary" disabled={pending}>{t("Find sites")}</button>
    </form>
    {pending && <p role="status">{t("Checking visibility for the catalog…")}</p>}
    {error && <p role="alert">{t(error)}</p>}
    {source === "saved" && <div className="plan-presets print:hidden"><span>{t("Saved ranges for all 23 sites:")}</span>{savedPlannerWindows.catalog.map(w => <a key={w.from} href={planLink({mode:"sites",source:"saved",from:w.from.slice(0,10),to:w.to.slice(0,10),priority:metric})}>{w.from.slice(0,10)} → {w.to.slice(0,10)}</a>)}</div>}
    {result && <section aria-label={t("Site search results")} className="plan-results">
      <h3>{t("Site search results")}</h3>
      <p><TimeRange start={result.from} end={result.to} /> · {t(criteria[metric])}</p>
      <p><strong>{result.scope === "pair" ? t("Saved observations: Odysseus and Athena only.") : result.scope === "catalog" ? t("Saved ranking: all 23 sites.") : t("Live catalog: {count} sites.", {count: result.rows.length})}</strong></p>
      <p className="data-notice">{!best.length ? t("No site has enough coverage for a recommendation.") : best.some(r => (r.hours?.[column] ?? 0) > 0)
        ? t("Most hours meeting your priority: {sites}.", { sites: best.map(r => r.name).join(" · ") })
        : t("No evaluated site meets this visibility priority for any hour in this window.")}</p>
      <div className="table-scroll"><table><caption>{t("Visibility hours in the selected window")}</caption>
        <thead><tr><th scope="col">{t("Site")}</th>{["Sun visible","Earth visible","Both visible",...(result.scope === "live" ? ["Longest joint window"] : [])].map(label => <th key={label} scope="col">{t(label)} (h)</th>)}</tr></thead>
        <tbody>{result.rows.map(row => {
          const href = "/compare?" + new URLSearchParams({run_id:run.runId,site_id:row.id,view_site:row.id,from:result.from,to:result.to,resolutionSeconds:"3600"}) + (Date.parse(result.to) - Date.parse(result.from) > 366 * DAY ? "#workspace" : "#terrain-observations");
          return <tr key={row.id}><th scope="row">{result.scope === "live" && run.stepSeconds === 3600 ? <a href={href}>{row.name}</a> : row.name}</th>
            {row.hours ? <>{row.hours.map((h,i) => <td key={i}>{h}</td>)}{result.scope === "live" && <td>{row.longest}</td>}</> : <td colSpan={4}>{t("Coverage")} · {t(row.coverage ?? "Incomplete coverage")}</td>}</tr>;
        })}</tbody></table></div>
      <p className="muted text-sm">{t("Visibility alone does not measure solar power or radio signal strength.")} · {t("Run ID")} <code>{run.runId}</code></p>
    </section>}
  </section>;
}

function Planner({ seed }: { seed: URLSearchParams }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState(seed.get("mode") === "dates" ? "dates" : "sites");
  const [edited, setEdited] = useState<{mode: string; params: URLSearchParams} | null>(null);
  const formArea = useRef<HTMLDivElement>(null);
  const requestedSource = seed.get("source");
  const forced = requestedSource === "saved" || requestedSource === "saved-b2";
  const catalog = useQuery({ queryKey: ["mission-planner-run"], queryFn: ({signal}) => getPlannerRun(signal), enabled: !isMock && !forced, retry:false });
  const source: PlannerSource = requestedSource === "saved" ? "saved" : forced || isMock || !catalog.data ? "saved-b2" : "live";
  const run = source === "saved-b2" ? archiveB2Run : source === "saved" ? savedPlannerRun : catalog.data!;
  const today = day(Date.now());
  const seedDay = (key: string, fallback: string) => {
    const v = seed.get(key);
    return v && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(midnight(v))) && day(Date.parse(midnight(v))) === v ? v : fallback;
  };
  const localStart = savedPlannerWindows.pair.from.slice(0,10);
  const first = seedDay("from", source === "saved" ? localStart : today >= run.start.slice(0,10) && today < run.end.slice(0,10) ? today : run.start.slice(0,10));
  const last = seedDay("to", day(Math.min(Date.parse(midnight(first)) + (source === "saved" && mode === "sites" ? 1 : 7)*DAY, Date.parse(run.end))));
  const sort = seed.get("priority");
  const priority = sort === "sun" || sort === "earth" ? sort : "joint";
  const hours = Number(seed.get("missionHours"));
  const mission = Number.isSafeInteger(hours) && hours > 0 && hours <= (Date.parse(run.end)-Date.parse(run.start))/3600000 ? hours : undefined;
  const loading = !isMock && !forced && catalog.isPending;
  useLayoutEffect(() => {
    const form = formArea.current?.querySelector("form");
    if (form) setEdited({ mode, params: plannerFormState(seed, mode, source, new FormData(form)) });
  }, [seed, mode, source, loading]);
  function sourceLink(next: PlannerSource) {
    const params = new URLSearchParams(edited?.mode === mode ? edited.params : seed);
    if (next === "live") params.delete("source"); else params.set("source", next);
    params.set("mode", mode);
    return "/plan?" + params;
  }
  if (loading) return <p role="status">{t("Connecting to the team API…")} <a href={sourceLink("saved-b2")}>{t("Use saved data now")}</a></p>;
  return <>
    <p className="plan-coverage"><strong>{t("{count} sites · model coverage (UTC, end exclusive)", {count:run.sites.length})}</strong><br/><TimeRange start={run.start} end={run.end} /> · {t("Model step")} {run.stepSeconds / 3600} h</p>
    <p className="plan-source">{t(source === "saved" ? "Saved run B" : source === "saved-b2" ? "Saved run B2" : "Live team API")} · <a href={source === "saved" ? "/data#bundled-data" : source === "saved-b2" ? "/data#run-b2" : "/data"}>{t("Browse data and all original files")}</a></p>
    {!isMock && !forced && catalog.isError && <p role="status">{t("The team API could not load the catalog. Showing the verified saved run.")} <button type="button" className="text-button" onClick={() => void catalog.refetch()}>{t("Retry site list")}</button></p>}
    <div className="flex flex-wrap gap-4 print:hidden">
      {source !== "saved-b2" && <a href={sourceLink("saved-b2")}>{t("Open saved run B2")}</a>}
      {source !== "saved" && <a href={sourceLink("saved")}>{t("Open the earlier run B archive")}</a>}
      {forced && !isMock && <a href={sourceLink("live")}>{t("Check live data")}</a>}
    </div>
    <div className="mode-switch print:hidden" role="group" aria-label={t("Choose how to search")}>
      <button type="button" aria-pressed={mode === "sites"} onClick={() => { if (mode !== "sites") { setEdited(null); setMode("sites"); } }}>{t("I have dates")}</button>
      <button type="button" aria-pressed={mode === "dates"} onClick={() => { if (mode !== "dates") { setEdited(null); setMode("dates"); } }}>{t("I have a site")}</button>
    </div>
    <div ref={formArea} onChange={e => {
      const input = e.target;
      if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
        if (input.form) setEdited({ mode, params: plannerFormState(seed, mode, source, new FormData(input.form)) });
      }
    }}>
    {mode === "sites" ? <CatalogSearch key={source} run={run} first={first} last={last} priority={priority} source={source} /> :
      source !== "live" ? <SavedLanding key={source} source={source} siteId={seed.get("site") ?? undefined} from={first} to={last} missionHours={mission} priority={priority} earliest={landingClock(seed, "earliest")} latest={landingClock(seed, "latest")} liveOptions={hasLiveOptions(seed)} /> :
      <MissionDateSearch runId={run.runId} sites={run.sites} stepSeconds={run.stepSeconds} from={midnight(first)} to={midnight(last)}
        coverageStart={run.start} coverageEnd={run.end} initialSiteId={seed.get("site") ?? undefined} initialMissionHours={mission} initialEarliest={landingClock(seed, "earliest")} initialLatest={landingClock(seed, "latest")}
        initialExtras={liveExtras(seed)} initialSunAtLanding={seed.get("sunAtLanding") === "1"} initialEarthAtLanding={seed.get("earthAtLanding") === "1"}
        initialObjective={seed.get("liveObjective") === "earliest" ? "earliest" : seed.get("liveObjective") === "balanced" ? "balanced" : priority === "joint" ? "both" : priority} />}
    </div>
    <AstronautGuide planningArchive={source === "live" ? undefined : source} savedResult={savedResultFromUrl(new URLSearchParams())} terrain={null} comparisonPath="/compare" />
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
    <a className="skip-link" href="#plan-title">{t("Skip to content")}</a>
    <header className="app-header"><a className="brand" href="/">Moon Plan B</a><nav aria-label={t("Main")}><a href="/data">{t("Data catalog")}</a><a href="/compare">{t("Compare")}</a><LanguageControl /><ThemeControl /></nav></header>
    <main className="plan-main"><h1 id="plan-title" tabIndex={-1}>{t("Plan a lunar visit")}</h1>{seed && <Planner key={seed.toString()} seed={seed} />}</main>
    <SiteFooter />
  </div>;
}

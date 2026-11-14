"use client";

import { ApiProblemText, useRetryCountdown, useProblemFields } from "../api-problem-text";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { hasLiveOptions, landingClock, liveExtras, plannerFormState, plannerLink, type PlannerSource } from "../../lib/planner-source";
import { useQuery } from "@tanstack/react-query";
import { isMock } from "../../lib/api/client";
import { getPlannerMissionRanking, getPlannerRanking, getPlannerRun, type PlannerRun, type PlannerPriority } from "../../lib/api/planner";
import { rankSavedMissionWindows, type MissionWindowRanking } from "../../lib/mission-window-ranking";
import type { TerrainSummary } from "../../lib/api/terrain-summary";
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
import { pairLocation, type PairLocation } from "../../lib/globe-sites";
import SiteMap from "./site-map";
import { usesSmoothSphere } from "../../lib/site-horizon";
import "./plan.css";

const criteria = { joint: "Sun and Earth together", sun: "Sunlight", earth: "Earth visibility" } as const;
const DAY = 86400000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const midnight = (date: string) => date + "T00:00:00Z";
type SearchResult = {
  from: string; to: string; scope: "live" | "catalog" | "pair";
  rows: (PairLocation & { smoothSphere: boolean; hours: number[] | null; longest?: number; coverage?: string; missionWindow?: { start: string; end: string } })[];
  leaders: string[]; missionHours?: number; excludedSites?: string[];
};

function missionResult(ranking: MissionWindowRanking, run: PlannerRun, evidence?: TerrainSummary): SearchResult {
  return {
    from: ranking.from, to: ranking.to, scope: evidence ? "live" : ranking.scope,
    missionHours: ranking.missionHours, leaders: ranking.leaders,
    excludedSites: ranking.excludedIds.map(id => run.sites.find(site => site.id === id)?.name ?? id),
    rows: ranking.rows.map(row => {
      const site = run.sites.find(site => site.id === row.id);
      const location = evidence ? pairLocation({ site_id: row.id, name: row.name }, run.sites, evidence.sites, evidence.conventions).location
        : site && site.lat_deg != null && site.lon_deg != null ? { point: { latitude: site.lat_deg, longitude: site.lon_deg } }
        : { reason: "This release supplies no coordinates for this site." };
      return { id: row.id, name: row.name, location, smoothSphere: usesSmoothSphere(site),
        hours: [row.sunHours, row.earthHours, row.bothHours], missionWindow: { start: row.start, end: row.end } };
    }),
  };
}

function storedResult(from: string, to: string, priority: PlannerPriority, source: Exclude<PlannerSource, "live">, missionHours?: number): SearchResult | null {
  if (missionHours !== undefined) {
    const ranking = rankSavedMissionWindows(source, { from, to, priority, missionHours });
    return ranking && missionResult(ranking, source === "saved-b2" ? archiveB2Run : savedPlannerRun);
  }
  const saved = source === "saved-b2" ? rankArchiveB2({ from, to, priority }) : getSavedPlannerRanking({ from, to, priority });
  const run = source === "saved-b2" ? archiveB2Run : savedPlannerRun;
  // Both archived manifests specify planetocentric latitude and east longitude in MOON_ME.
  return saved && { ...saved, rows: saved.rows.map(row => {
    const site = run.sites.find(s => s.id === row.id);
    const location = site ? { point: { latitude: site.lat_deg, longitude: site.lon_deg } }
      : { reason: "This release supplies no coordinates for this site." };
    return { id: row.id, name: row.name, location, smoothSphere: usesSmoothSphere(site), hours: [row.sunHours, row.earthHours, row.bothHours] };
  }) };
}

function savedSearchError(source: PlannerSource, duration: string) {
  return source === "saved" && duration
    ? "The earlier archive supports shorter missions only for Odysseus and Athena during 14–21 November 2026 UTC. Open saved run B2 for all sites."
    : "No saved observations cover this request. Choose a saved range below or connect to the team API.";
}

function CatalogSearch({ run, first, last, priority, source, initialSite, runIds, initialDuration }: { initialDuration: string; run: PlannerRun; first: string; last: string; priority: PlannerPriority; source: PlannerSource; initialSite: string | null; runIds: string[] }) {
  const { t } = useLanguage();
  const [result, setResult] = useState<SearchResult | null>(() => source === "live" ? null : storedResult(first, last, priority, source, initialDuration ? Number(initialDuration) : undefined));
  const [duration, setDuration] = useState(initialDuration);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | Error>(() => source !== "live" && initialDuration && !result ? savedSearchError(source, initialDuration) : "");
  const wait = useRetryCountdown(error);
  const { prefix, fieldAttributes } = useProblemFields(error);
  const [metric, setMetric] = useState(priority);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  function clear() { active.current?.abort(); setPending(false); if (!wait) setError(""); setResult(null); }
  const best = result?.rows.filter(r => result.leaders.includes(r.id)) ?? [];
  const column = { sun: 0, earth: 1, joint: 2 }[metric];
  const flatLeaders = best.filter(row => row.smoothSphere && (row.hours?.[column] ?? 0) > 0);
  const showLongest = result?.scope === "live" && result.missionHours === undefined;
  function detailHref(siteId: string) {
    if (!result) return undefined;
    const mission = result.rows.find(row => row.id === siteId)?.missionWindow;
    if (source !== "live") return plannerLink("/plan/site", {
      source, site: siteId, from: mission?.start ?? result.from.slice(0, 10), to: mission?.end ?? result.to.slice(0, 10), priority: metric,
      ...(result.missionHours ? { missionHours: String(result.missionHours), searchFrom: result.from.slice(0, 10), searchTo: result.to.slice(0, 10) } : {}),
    }, runIds);
    if (run.stepSeconds !== 3600) return undefined;
    const from = mission?.start ?? result.from, to = mission?.end ?? result.to;
    const longWindow = Date.parse(to) - Date.parse(from) > 366 * DAY;
    const params = new URLSearchParams({ run_id: run.runId, site_id: siteId, view_site: siteId,
      from, to, resolutionSeconds: String(run.stepSeconds) });
    return "/compare?" + params + (longWindow ? "#workspace" : "#terrain-observations");
  }
  return <section aria-labelledby="catalog-question">
    <h2 id="catalog-question">{t("Which site fits my dates?")}</h2>
    <form className="request-fields print:hidden" onChange={clear} onSubmit={async e => {
      e.preventDefault();
      if (pending || wait) return;
      const form = new FormData(e.currentTarget);
      const from = midnight(String(form.get("from"))), to = midnight(String(form.get("to")));
      clear();
      if (from < run.start || to > run.end || from >= to) { setError("Choose an increasing UTC window inside the model run."); return; }
      const missionHours = duration ? Number(duration) : undefined;
      if (missionHours !== undefined && (!Number.isSafeInteger(missionHours) || missionHours < 1 || missionHours * 3600000 > Date.parse(to) - Date.parse(from) || missionHours * 3600 % run.stepSeconds !== 0)) {
        setError("Choose a whole number of mission hours that fits the dates and model step."); return;
      }
      if (source !== "live") {
        const next = storedResult(from, to, metric, source, missionHours);
        setResult(next);
        if (!next) setError(savedSearchError(source, duration));
        return;
      }
      const controller = new AbortController(); active.current = controller; setPending(true);
      try {
        if (missionHours !== undefined) {
          const { ranking, evidence } = await getPlannerMissionRanking(run, { from, to, priority: metric, missionHours }, controller.signal);
          if (!controller.signal.aborted) setResult(missionResult(ranking, run, evidence));
          return;
        }
        const { ranking, evidence, recommendedIds } = await getPlannerRanking(run, { from, to, priority: metric }, controller.signal);
        if (!controller.signal.aborted) setResult({ from: ranking.range.start, to: ranking.range.end, scope: "live", leaders: recommendedIds,
          rows: ranking.ranking.map(row => {
            const site = evidence.sites.find(s => s.id === row.site_id)!;
            const m = site.coverage === "complete" && site.coverage_in_range === "complete" ? site.metrics : null;
            return { ...pairLocation(row, run.sites, evidence.sites, evidence.conventions),
              smoothSphere: usesSmoothSphere(run.sites.find(s => s.id === row.site_id)), hours: m && [m.sun_hours, m.earth_hours, m.both_hours], longest: m?.longest_both_h, coverage: site.coverage_in_range };
          }) });
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause : "The request could not be completed. Retry or check the connection.");
      } finally { if (!controller.signal.aborted) setPending(false); }
    }}>
      <label className="field">{t("Start date (UTC)")}<input name="from" {...fieldAttributes("start")} type="date" required min={run.start.slice(0,10)} max={day(Date.parse(run.end) - DAY)} defaultValue={first} /></label>
      <label className="field">{t("End date (UTC, exclusive)")}<input name="to" {...fieldAttributes("end")} type="date" required min={day(Date.parse(run.start) + DAY)} max={run.end.slice(0,10)} defaultValue={last} /></label>
      <label className="field">{t("Mission duration in hours (optional)")}<input name="missionHours" type="number" min="1" step="1" value={duration} onChange={e => setDuration(e.target.value)} aria-describedby="catalog-duration-help" />
        <small id="catalog-duration-help">{t("Leave empty to rank the entire date range.")}</small></label>
      <label className="field">{t("Rank sites by")}<select name="priority" value={metric} onChange={e => setMetric(e.target.value as PlannerPriority)}>
        {Object.entries(criteria).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
      </select></label>
      <button className="button primary" disabled={pending || wait > 0}>{wait ? t("Try again in {seconds} s", { seconds: wait }) : t("Find sites")}</button>
    </form>
    {pending && <p role="status">{t("Checking visibility for the catalog…")}</p>}
    {error && <p role="alert"><ApiProblemText error={error} fieldPrefix={prefix} /></p>}
    {source === "saved" && duration && <p><a href={plannerLink("/plan", {mode:"sites",source:"saved",from:savedPlannerWindows.pair.from.slice(0,10),to:savedPlannerWindows.pair.to.slice(0,10),priority:metric,missionHours:duration}, runIds)}>{t("Search the saved week for Odysseus and Athena")}</a></p>}
    {source === "saved" && !duration && <div className="plan-presets print:hidden"><span>{t("Saved ranges for all 23 sites:")}</span>{savedPlannerWindows.catalog.map(w => <a key={w.from} href={plannerLink("/plan", {mode:"sites",source:"saved",from:w.from.slice(0,10),to:w.to.slice(0,10),priority:metric}, runIds)}>{w.from.slice(0,10)} → {w.to.slice(0,10)}</a>)}</div>}
    {result && <section aria-label={t("Site search results")} className="plan-results">
      <h3>{t("Site search results")}</h3>
      <p><TimeRange start={result.from} end={result.to} /> · {t(criteria[metric])}</p>
      {result.missionHours && <p>{t("Each site is ranked by hours of {priority} in its best {hours}-hour mission. The table shows the earliest window when scores tie.", { priority: t(criteria[metric]), hours: result.missionHours })}</p>}
      <p><strong>{result.scope === "pair" ? t("Saved observations: Odysseus and Athena only.") : result.scope === "catalog" ? t("Saved ranking: all 23 sites.") : t("Live catalog: {count} sites.", {count: run.sites.length})}</strong></p>
      {!!result.excludedSites?.length && <p>{t("Incomplete coverage excluded these sites: {sites}.", {sites: result.excludedSites.join(" · ")})}</p>}
      <p className="data-notice">{!result.rows.some(row => row.hours) ? t("No site has enough coverage for a recommendation.") : best.some(r => (r.hours?.[column] ?? 0) > 0)
        ? t("Most hours meeting your priority: {sites}.", { sites: best.map(r => r.name).join(" · ") })
        : t("No evaluated site meets this visibility priority for any hour in this window.")}
        {flatLeaders.length > 0 && <span className="block">{t("Local terrain shadows are omitted for {sites}.", { sites: flatLeaders.map(r => r.name).join(" · ") })}</span>}</p>
      <SiteMap sites={result.rows} leaders={result.leaders} column={column} criterion={t(criteria[metric])} initialSite={initialSite} detailHref={detailHref} />
      <div className="table-scroll"><table><caption>{t(result.missionHours ? "Visibility hours in each site’s best mission window" : "Visibility hours in the selected window")}</caption>
        <thead><tr><th scope="col">{t("Site")}</th>{result.missionHours && <th scope="col">{t("Earliest best mission window (UTC, end exclusive)")}</th>}{["Sun visible","Earth visible","Both visible",...(showLongest ? ["Longest joint window"] : [])].map(label => <th key={label} scope="col">{t(label)} (h)</th>)}</tr></thead>
        <tbody>{result.rows.map(row => {
          const href = detailHref(row.id);
          return <tr key={row.id}><th scope="row">{href ? <a href={href}>{row.name}</a> : row.name}
            {row.smoothSphere && <small className="block">{t("Smooth-sphere horizon")}</small>}</th>
            {row.missionWindow && <td><TimeRange start={row.missionWindow.start} end={row.missionWindow.end} /></td>}
            {row.hours ? <>{row.hours.map((h,i) => <td key={i}>{h}</td>)}{showLongest && <td>{row.longest}</td>}</> : <td colSpan={4}>{t("Coverage")} · {t(row.coverage ?? "Incomplete coverage")}</td>}</tr>;
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
  const pins = seed.getAll("run_id");
  const pinnedRun = pins.length > 1 ? "" : pins[0];
  const forced = requestedSource === "saved" || requestedSource === "saved-b2";
  const catalog = useQuery({ queryKey: ["mission-planner-run", pinnedRun], queryFn: ({signal}) => getPlannerRun(signal, pinnedRun), enabled: !isMock && !forced, retry:false });
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
  const capture = useCallback((form: HTMLFormElement) => {
    setEdited({ mode, params: plannerFormState(seed, mode, source, new FormData(form)) });
  }, [seed, mode, source]);
  const savedLanding = mode === "dates" && source !== "live";
  useLayoutEffect(() => {
    const form = formArea.current?.querySelector("form");
    if (!savedLanding && form) capture(form);
  }, [capture, loading, savedLanding]);
  function sourceLink(next: PlannerSource) {
    const params = new URLSearchParams(edited?.mode === mode ? edited.params : seed);
    if (next === "live") params.delete("source"); else params.set("source", next);
    params.set("mode", mode);
    return "/plan?" + params;
  }
  if (loading) return <p role="status">{t("Connecting to the team API…")} <a href={sourceLink("saved-b2")}>{t("Use saved data now")}</a></p>;
  if (!forced && pinnedRun !== undefined && !catalog.data) return <section role="alert">
    <p>{t("The linked model run could not be opened.")} <code>{pinnedRun}</code></p>
    {catalog.error && <p><ApiProblemText error={catalog.error} /></p>}
    <div className="flex flex-wrap gap-4">
      {!isMock && <button type="button" className="text-button" onClick={() => void catalog.refetch()}>{t("Retry site list")}</button>}
      <a href={sourceLink("saved-b2")}>{t("Open saved run B2")}</a>
      <a href={sourceLink("saved")}>{t("Open the earlier run B archive")}</a>
    </div>
  </section>;
  return <>
    <p className="plan-coverage"><strong>{t("{count} sites · model coverage (UTC, end exclusive)", {count:run.sites.length})}</strong><br/><TimeRange start={run.start} end={run.end} /> · {t("Model step")} {run.stepSeconds / 3600} h</p>
    <p className="plan-source">{t(source === "saved" ? "Saved run B" : source === "saved-b2" ? "Saved run B2" : "Live team API")} · {source === "live" ? <>
      {t("Run ID")} <a href={"/api/v1/runs/" + encodeURIComponent(run.runId)}><code>{run.runId}</code></a> · <a href={"/api/v1/runs/" + encodeURIComponent(run.runId) + "/files/manifest.json"}>{t("Source file manifest (JSON)")}</a>
    </> : <a href={source === "saved" ? "/data#bundled-data" : "/data#run-b2"}>{t("Browse data and all original files")}</a>}</p>
    {!isMock && !forced && catalog.isError && <p role="status">{t("The team API could not load the catalog. Showing the verified saved run.")} <span className="block"><ApiProblemText error={catalog.error} /></span><button type="button" className="text-button" onClick={() => void catalog.refetch()}>{t("Retry site list")}</button></p>}
    <div className="flex flex-wrap gap-4 print:hidden">
      {source !== "saved-b2" && <a href={sourceLink("saved-b2")}>{t("Open saved run B2")}</a>}
      {source !== "saved" && <a href={sourceLink("saved")}>{t("Open the earlier run B archive")}</a>}
      {forced && !isMock && <a href={sourceLink("live")}>{pinnedRun === undefined ? t("Check live data") : t("Return to the linked live run")}</a>}
    </div>
    <div className="mode-switch print:hidden" role="group" aria-label={t("Choose how to search")}>
      <button type="button" aria-pressed={mode === "sites"} onClick={() => { if (mode !== "sites") { setEdited(null); setMode("sites"); } }}>{t("I have dates")}</button>
      <button type="button" aria-pressed={mode === "dates"} onClick={() => { if (mode !== "dates") { setEdited(null); setMode("dates"); } }}>{t("I have a site")}</button>
    </div>
    <div ref={formArea} onChange={e => {
      const input = e.target;
      if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
        if (!savedLanding && input.form) capture(input.form);
      }
    }}>
    {mode === "sites" ? <CatalogSearch key={source + "/" + run.runId} initialSite={seed.get("site")} runIds={pins} initialDuration={seed.get("missionHours") ?? ""} run={run} first={first} last={last} priority={priority} source={source} /> :
      source !== "live" ? <SavedLanding key={source} source={source} siteId={seed.get("site") ?? undefined} from={first} to={last} missionHours={mission} priority={priority} earliest={landingClock(seed, "earliest")} latest={landingClock(seed, "latest")} liveOptions={hasLiveOptions(seed)} onFieldsChange={capture} /> :
      <MissionDateSearch runId={run.runId} sites={run.sites} stepSeconds={run.stepSeconds} from={midnight(first)} to={midnight(last)}
        coverageStart={run.start} coverageEnd={run.end} initialSiteId={seed.get("site") ?? undefined} initialMissionHours={mission} initialEarliest={landingClock(seed, "earliest")} initialLatest={landingClock(seed, "latest")}
        initialExtras={liveExtras(seed)} initialSunAtLanding={seed.get("sunAtLanding") === "1"} initialEarthAtLanding={seed.get("earthAtLanding") === "1"}
        initialObjective={seed.get("liveObjective") === "earliest" ? "earliest" : seed.get("liveObjective") === "balanced" ? "balanced" : priority === "joint" ? "both" : priority} />}
    </div>
    <AstronautGuide planningSource={source === "live" ? run : source} savedResult={savedResultFromUrl(new URLSearchParams())} terrain={null} comparisonPath="/compare" />
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

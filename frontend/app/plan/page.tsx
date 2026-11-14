"use client";

import { ApiProblemText, useRetryCountdown, useProblemFields } from "../api-problem-text";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fullModelPeriodLink, hasLiveOptions, landingClock, liveExtras, plannerFormState, plannerLink, type PlannerSource } from "../../lib/planner-source";
import { useQuery } from "@tanstack/react-query";
import { hasRetryDeadline, isMock } from "../../lib/api/client";
import { getPlannerMissionRanking, getPlannerRanking, getPlannerRun, type PlannerRun, type PlannerPriority } from "../../lib/api/planner";
import { rankSavedMissionWindows, type MissionWindowRanking } from "../../lib/mission-window-ranking";
import type { TerrainSummary } from "../../lib/api/terrain-summary";
import { archiveB2Run, rankArchiveB2, savedB2EarthWindows } from "../../lib/archive-b2";
import { getSavedPlannerRanking, savedEarthWindows, savedJointWindows, savedPlannerRun, savedPlannerWindows } from "../../lib/saved-planner";
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
import { clipEarthWindows, type EarthWindow } from "../../lib/earth-windows";
import { usesSmoothSphere } from "../../lib/site-horizon";
import "./plan.css";

const criteria = { joint: "Sun and Earth together", sun: "Sunlight", earth: "Earth visibility" } as const;
const DAY = 86400000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const midnight = (date: string) => date + "T00:00:00Z";
type SearchResult = {
  from: string; to: string; scope: "live" | "catalog" | "pair";
  rows: (PairLocation & { smoothSphere: boolean; hours: number[] | null; earthWindows?: EarthWindow[]; trackingPower?: number; longest?: number; coverage?: string; missionWindow?: { start: string; end: string } })[];
  leaders: string[]; missionHours?: number; excludedSites?: string[];
};

function missionResult(ranking: MissionWindowRanking, run: PlannerRun, source: PlannerSource, evidence?: TerrainSummary): SearchResult {
  return {
    from: ranking.from, to: ranking.to, scope: evidence ? "live" : ranking.scope,
    missionHours: ranking.missionHours, leaders: ranking.leaders,
    excludedSites: ranking.excludedIds.map(id => run.sites.find(site => site.id === id)?.name ?? id),
    rows: ranking.rows.map(row => {
      const site = run.sites.find(site => site.id === row.id);
      const location = evidence ? pairLocation({ site_id: row.id, name: row.name }, run.sites, evidence.sites, evidence.conventions).location
        : site && site.lat_deg != null && site.lon_deg != null ? { point: { latitude: site.lat_deg, longitude: site.lon_deg } }
        : { reason: "This release supplies no coordinates for this site." };
      const verified = evidence?.sites.find(s => s.id === row.id);
      const earthWindows = source === "live"
        ? verified?.coverage === "complete" && verified.coverage_in_range === "complete"
          ? clipEarthWindows(verified.windows.earth, row.start, row.end) : undefined
        : (source === "saved-b2" ? savedB2EarthWindows : savedEarthWindows)(row.id, row.start, row.end);
      return { id: row.id, name: row.name, location, smoothSphere: usesSmoothSphere(site), earthWindows,
        hours: [row.sunHours, row.earthHours, row.bothHours], missionWindow: { start: row.start, end: row.end } };
    }),
  };
}

function rankByLongest(result: SearchResult): SearchResult {
  const rows = result.rows.toSorted((a, b) => (b.longest ?? -1) - (a.longest ?? -1) || a.name.localeCompare(b.name, "en"));
  const top = rows[0]?.longest;
  return { ...result, rows, leaders: top !== undefined && top > 0 ? rows.filter(row => row.longest === top).map(row => row.id) : [] };
}

function storedResult(from: string, to: string, priority: PlannerPriority, source: Exclude<PlannerSource, "live">, longest: boolean, missionHours?: number): SearchResult | null {
  if (longest && missionHours !== undefined) return null;
  if (missionHours !== undefined) {
    const ranking = rankSavedMissionWindows(source, { from, to, priority, missionHours });
    return ranking && missionResult(ranking, source === "saved-b2" ? archiveB2Run : savedPlannerRun, source);
  }
  const saved = source === "saved-b2" ? rankArchiveB2({ from, to, priority }) : getSavedPlannerRanking({ from, to, priority });
  const run = source === "saved-b2" ? archiveB2Run : savedPlannerRun;
  // Both archived manifests specify planetocentric latitude and east longitude in MOON_ME.
  if (!saved) return null;
  const pair = source === "saved" && longest ? savedJointWindows(saved.from, saved.to) : null;
  if (source === "saved" && longest && !pair) return null;
  const chosen = pair ? saved.rows.filter(row => pair.some(site => site.id === row.id)) : saved.rows;
  const result: SearchResult = { ...saved, scope: pair ? "pair" : saved.scope, rows: chosen.map(row => {
    const site = run.sites.find(s => s.id === row.id);
    const location = site ? { point: { latitude: site.lat_deg, longitude: site.lon_deg } }
      : { reason: "This release supplies no coordinates for this site." };
    const longest = pair ? pair.find(site => site.id === row.id)?.window?.hours ?? 0 :
      "longestBothHours" in row && typeof row.longestBothHours === "number" ? row.longestBothHours : undefined;
    return { id: row.id, name: row.name, location, smoothSphere: usesSmoothSphere(site),
      earthWindows: (source === "saved-b2" ? savedB2EarthWindows : savedEarthWindows)(row.id, saved.from, saved.to),
      hours: [row.sunHours, row.earthHours, row.bothHours], longest };
  }) };
  return longest ? rankByLongest(result) : result;
}

function savedSearchError(source: PlannerSource, duration: string) {
  return source === "saved" && duration
    ? "The earlier archive has no mission windows for these dates. Use the saved range for Odysseus and Athena below, or open saved run B2."
    : "No saved observations cover this request. Choose a saved range below or connect to the team API.";
}

function catalogInputError(run: PlannerRun, from: string, to: string, duration: string) {
  if (from < run.start || to > run.end || from >= to) return "Choose an increasing UTC window inside the model run.";
  const hours = Number(duration);
  if (duration && (!Number.isSafeInteger(hours) || hours < 1 || hours * 3600000 > Date.parse(to) - Date.parse(from) || hours * 3600 % run.stepSeconds !== 0)) {
    return "Choose a whole number of mission hours that fits the dates and model step.";
  }
  return "";
}

function CatalogSearch({ run, first, last, priority, source, initialSite, runIds, initialDuration, initialLongest }: { initialDuration: string; initialLongest: boolean; run: PlannerRun; first: string; last: string; priority: PlannerPriority; source: PlannerSource; initialSite: string | null; runIds: string[] }) {
  const { t, locale } = useLanguage();
  const legacyError = locale === "vi" ? "Bản lưu B chỉ có các khoảng liên tục cho Odysseus và Athena trong khoảng ngày đã lưu." : "Run B retains continuous windows only for Odysseus and Athena within its saved dates.";
  const durationError = locale === "vi" ? "Hãy bỏ trống thời lượng nhiệm vụ để so sánh khoảng liên tục dài nhất trong toàn bộ khoảng ngày." : "Clear the mission duration to compare the longest continuous window across the travel dates.";
  const [result, setResult] = useState<SearchResult | null>(() => source === "live" ? null : storedResult(first, last, priority, source, initialLongest, initialDuration ? Number(initialDuration) : undefined));
  const [duration, setDuration] = useState(initialDuration);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | Error>(() => source !== "live" && initialDuration && !result && !initialLongest
    ? catalogInputError(run, midnight(first), midnight(last), initialDuration) || savedSearchError(source, initialDuration) : "");
  const wait = useRetryCountdown(error);
  const { prefix, fieldAttributes } = useProblemFields(error);
  const [order, setOrder] = useState<PlannerPriority | "longest">(initialLongest ? "longest" : priority);
  const longest = order === "longest";
  const metric = longest ? "joint" : order;
  const label = t(longest ? "Longest joint window" : criteria[metric]);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  function clear() { active.current?.abort(); setPending(false); if (!wait) setError(""); setResult(null); }
  const best = result?.rows.filter(r => result.leaders.includes(r.id)) ?? [];
  const column = { sun: 0, earth: 1, joint: 2 }[metric];
  const flatLeaders = best.filter(row => row.smoothSphere && (row.hours?.[column] ?? 0) > 0);
  const pairRange = savedPlannerWindows.pair;
  const presets = savedPlannerWindows.catalog.filter(range => !duration || Date.parse(range.to) - Date.parse(range.from) === Number(duration) * 3600000);
  const showLongest = (source !== "saved" || longest) && result?.missionHours === undefined;
  function detailHref(siteId: string) {
    if (!result) return undefined;
    const mission = result.rows.find(row => row.id === siteId)?.missionWindow;
    if (source !== "live") return plannerLink("/plan/site", {
      source, site: siteId, from: mission?.start ?? result.from.slice(0, 10), to: mission?.end ?? result.to.slice(0, 10), priority: metric,
      ...(longest ? { order: "longest" } : {}),
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
    <form className="request-fields catalog-fields print:hidden" onChange={clear} onSubmit={async e => {
      e.preventDefault();
      if (pending || wait) return;
      const form = new FormData(e.currentTarget);
      const from = midnight(String(form.get("from"))), to = midnight(String(form.get("to")));
      clear();
      const invalid = catalogInputError(run, from, to, duration);
      if (invalid) { setError(invalid); return; }
      if (longest && duration) return;
      const missionHours = duration ? Number(duration) : undefined;
      if (source !== "live") {
        const next = storedResult(from, to, metric, source, longest, missionHours);
        setResult(next);
        if (!next && !longest) setError(savedSearchError(source, duration));
        return;
      }
      const controller = new AbortController(); active.current = controller; setPending(true);
      try {
        if (missionHours !== undefined) {
          const { ranking, evidence } = await getPlannerMissionRanking(run, { from, to, priority: metric, missionHours }, controller.signal);
          if (!controller.signal.aborted) setResult(missionResult(ranking, run, source, evidence));
          return;
        }
        const { ranking, evidence, recommendedIds } = await getPlannerRanking(run, { from, to, priority: metric }, controller.signal);
        if (controller.signal.aborted) return;
        const next: SearchResult = { from: ranking.range.start, to: ranking.range.end, scope: "live", leaders: recommendedIds,
          rows: ranking.ranking.map(row => {
            const site = evidence.sites.find(s => s.id === row.site_id)!;
            const m = site.coverage === "complete" && site.coverage_in_range === "complete" ? site.metrics : null;
            return { ...pairLocation(row, run.sites, evidence.sites, evidence.conventions),
              earthWindows: m ? clipEarthWindows(site.windows.earth, ranking.range.start, ranking.range.end) : undefined,
              trackingPower: m ? row.mean_power_tracking : undefined,
              smoothSphere: usesSmoothSphere(run.sites.find(s => s.id === row.site_id)), hours: m && [m.sun_hours, m.earth_hours, m.both_hours], longest: m?.longest_both_h, coverage: site.coverage_in_range };
          }) };
        setResult(longest ? rankByLongest(next) : next);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause : "The request could not be completed. Retry or check the connection.");
      } finally { if (!controller.signal.aborted) setPending(false); }
    }}>
      <label className="field">{t("Start date (UTC)")}<input name="from" {...fieldAttributes("start")} type="date" required min={run.start.slice(0,10)} max={day(Date.parse(run.end) - DAY)} defaultValue={first} /></label>
      <label className="field">{t("End date (UTC, exclusive)")}<input name="to" {...fieldAttributes("end")} type="date" required min={day(Date.parse(run.start) + DAY)} max={run.end.slice(0,10)} defaultValue={last} /></label>
      <label className="field"><span id="catalog-duration-label">{t("Mission duration in hours (optional)")}</span><input aria-labelledby="catalog-duration-label" name="missionHours" type="number" min="1" step="1" value={duration} onChange={e => setDuration(e.target.value)} aria-describedby="catalog-duration-help" />
        <small id="catalog-duration-help">{t("Leave empty to rank the entire date range.")}</small></label>
      <label className="field">{t("Rank sites by")}<select name="priority" value={order} onChange={e => setOrder(e.target.value as typeof order)}>
        {Object.entries(criteria).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
        <option value="longest">{t("Longest joint window")}</option>
      </select></label>
      <button className="button primary" disabled={pending || wait > 0 || (longest && Boolean(duration))}>{wait ? t("Try again in {seconds} s", { seconds: wait }) : t("Find sites")}</button>
    </form>
    {pending && <p role="status">{t("Checking visibility for the catalog…")}</p>}
    {longest && duration && <p role="status">{durationError}</p>}
    {source === "saved" && longest && !duration && <p>{legacyError}</p>}
    {error && <p role="alert"><ApiProblemText error={error} fieldPrefix={prefix} /></p>}
    {source === "saved" && (duration || longest) && <p><a href={plannerLink("/plan", {mode:"sites",source:"saved",from:pairRange.from.slice(0,10),to:pairRange.to.slice(0,10),priority:metric,...(duration ? {missionHours:duration} : {}),...(longest ? {order:"longest"} : {})}, runIds)}>
      {t("Search the saved range for Odysseus and Athena")} · <TimeRange start={pairRange.from} end={pairRange.to} />
    </a></p>}
    {source === "saved" && !longest && presets.length > 0 && <div className="plan-presets print:hidden"><span>{t("Saved ranges for all 23 sites:")}</span>{presets.map(w => <a key={w.from} href={plannerLink("/plan", {mode:"sites",source:"saved",from:w.from.slice(0,10),to:w.to.slice(0,10),priority:metric,...(duration ? { missionHours: duration } : {})}, runIds)}>{w.from.slice(0,10)} → {w.to.slice(0,10)}</a>)}</div>}
    {result && <section aria-label={t("Site search results")} className="plan-results">
      <h3>{t("Site search results")}</h3>
      <p><TimeRange start={result.from} end={result.to} /> · {label}</p>
      {result.missionHours && <p>{t("Each site is ranked by hours of {priority} in its best {hours}-hour mission. The table shows the earliest window when scores tie.", { priority: t(criteria[metric]), hours: result.missionHours })}</p>}
      <p><strong>{result.scope === "pair" ? t("Saved observations: Odysseus and Athena only.") : result.scope === "catalog" ? t("Saved ranking: all 23 sites.") : t("Live catalog: {count} sites.", {count: run.sites.length})}</strong></p>
      {!!result.excludedSites?.length && <p>{t("Incomplete coverage excluded these sites: {sites}.", {sites: result.excludedSites.join(" · ")})}</p>}
      <p className="data-notice">{!result.rows.some(row => row.hours) ? t("No site has enough coverage for a recommendation.") : best.some(r => (r.hours?.[column] ?? 0) > 0)
        ? longest ? <>{label} · {best[0].longest} h · {best.map(r => r.name).join(" · ")}</> : t("Most hours meeting your priority: {sites}.", { sites: best.map(r => r.name).join(" · ") })
        : t("No evaluated site meets this visibility priority for any hour in this window.")}
        {flatLeaders.length > 0 && <span className="block">{t("Local terrain shadows are omitted for {sites}.", { sites: flatLeaders.map(r => r.name).join(" · ") })}</span>}</p>
      <SiteMap startUtc={result.from} evaluatedHours={result.missionHours ?? (Date.parse(result.to) - Date.parse(result.from)) / 3600000} sites={result.rows} leaders={result.leaders} column={longest ? "longest" : column} criterion={label} initialSite={initialSite} detailHref={detailHref} />
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
  const catalog = useQuery({ queryKey: ["mission-planner-run", pinnedRun], queryFn: ({signal}) => getPlannerRun(signal, pinnedRun), enabled: q => !isMock && !forced && !hasRetryDeadline(q.state.error), retry:false });
  const catalogWait = useRetryCountdown(catalog.error ?? "");
  const retryCatalog = <button type="button" className="text-button" disabled={catalog.isFetching || catalogWait > 0}
    onClick={() => void catalog.refetch({ cancelRefetch: false })}>
    {catalogWait ? t("Try again in {seconds} s", { seconds: catalogWait }) : t("Retry site list")}
  </button>;
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
  const mission = Number.isSafeInteger(hours * 3600 / run.stepSeconds) && hours > 0 && hours <= (Date.parse(run.end)-Date.parse(run.start))/3600000 ? hours : undefined;
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
      {!isMock && retryCatalog}
      <a href={sourceLink("saved-b2")}>{t("Open saved run B2")}</a>
      <a href={sourceLink("saved")}>{t("Open the earlier run B archive")}</a>
    </div>
  </section>;
  const fullPeriod = edited?.mode === mode && fullModelPeriodLink(edited.params, source, run);
  return <>
    <p className="plan-coverage"><strong>{t("{count} sites · model coverage (UTC, end exclusive)", {count:run.sites.length})}</strong><br/><TimeRange start={run.start} end={run.end} /> · {t("Model step")} {run.stepSeconds / 3600} h</p>
    <p className="plan-source">{t(source === "saved" ? "Saved run B" : source === "saved-b2" ? "Saved run B2" : "Live team API")} · {source === "live" ? <>
      {t("Run ID")} <a href={"/api/v1/runs/" + encodeURIComponent(run.runId)}><code>{run.runId}</code></a> · <a href={"/api/v1/runs/" + encodeURIComponent(run.runId) + "/files/manifest.json"}>{t("Source file manifest (JSON)")}</a>
    </> : <a href={source === "saved" ? "/data#bundled-data" : "/data#run-b2"}>{t("Browse data and all original files")}</a>}</p>
    {!isMock && !forced && catalog.isError && <p role="status">{t("The team API could not load the catalog. Showing the verified saved run.")} <span className="block"><ApiProblemText error={catalog.error} /></span>{retryCatalog}</p>}
    <div className="flex flex-wrap gap-4 print:hidden">
      {source !== "saved-b2" && <a href={sourceLink("saved-b2")}>{t("Open saved run B2")}</a>}
      {source !== "saved" && <a href={sourceLink("saved")}>{t("Open the earlier run B archive")}</a>}
      {forced && !isMock && <a href={sourceLink("live")}>{pinnedRun === undefined ? t("Check live data") : t("Return to the linked live run")}</a>}
    </div>
    <div className="mode-switch print:hidden" role="group" aria-label={t("Choose how to search")}>
      <button type="button" aria-pressed={mode === "sites"} onClick={() => { if (mode !== "sites") { setEdited(null); setMode("sites"); } }}>{t("I have dates")}</button>
      <button type="button" aria-pressed={mode === "dates"} onClick={() => { if (mode !== "dates") { setEdited(null); setMode("dates"); } }}>{t("I have a site")}</button>
    </div>
    {fullPeriod && <p className="print:hidden"><a href={fullPeriod}>{t("Use full model period")}</a></p>}
    <div id="planning-form" ref={formArea} onChange={e => {
      const input = e.target;
      if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
        if (!savedLanding && input.form) capture(input.form);
      }
    }}>
    {mode === "sites" ? <CatalogSearch key={source + "/" + run.runId} initialSite={seed.get("site")} runIds={pins} initialDuration={seed.get("missionHours") ?? ""} initialLongest={seed.get("order") === "longest" && priority === "joint"} run={run} first={first} last={last} priority={priority} source={source} /> :
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
    <main className="plan-main"><h1 id="plan-title" tabIndex={-1}>{t("Plan a lunar visit")}</h1>
      <p>{t("Already have dates? Compare sites for that period. Already have a site? Look for a time to land there.")}</p>
      {seed && <Planner key={seed.toString()} seed={seed} />}</main>
    <SiteFooter />
  </div>;
}

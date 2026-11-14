"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button as AnimatedButton } from "@animate-ui/react/primitives/buttons/button";
import { defaultWindow, getDataset, getJob, isMock, validateWindow } from "../lib/api/client";
import type { WindowRequest } from "../lib/api/client";
import { ApiControls } from "./requests";
import ThemeControl from "./theme-control";
import MoonGlobe from "./moon-globe";
import LocalSky from "./local-sky";
import { LanguageControl, useLanguage } from "./language";
import type { Message } from "../lib/i18n";
import { alternatives, commonOffsets, durationHours, laterMatch, publishedWindows, readSelection, selectionParams, validateDataset } from "../lib/dataset";
import type { Dataset, Mode, Scenario, Selection } from "../lib/dataset";
import { Comparison, formatUtc, SampleTable, SiteAssessments, SkyPosition, Sources, Timeline, Windows } from "./observations";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export default function Navigator() {
  const { t, locale } = useLanguage();
  const queryClient = useQueryClient();
  const [requestWindow, setRequestWindow] = useState(defaultWindow);
  const [sharedJobId, setSharedJobId] = useState("");
  const [data, setData] = useState<Dataset | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [importCompletion, setImportCompletion] = useState(0);
  const [error, setError] = useState<string | { importReason: string }>("");
  const [retryLoad, setRetryLoad] = useState<{ request: WindowRequest; jobId: string; reset: boolean } | null>(null);
  const [message, setMessage] = useState<Message>("");
  const [shareUrl, setShareUrl] = useState("");
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadGeneration = useRef(0);
  const loadFocus = useRef<Element | null>(null);
  const lastLocation = useRef<string | null>(null);

  useEffect(() => {
    if (loading) return;
    const initiator = loadFocus.current;
    loadFocus.current = null;
    // Restore focus lost during loading without taking it from another control.
    if (initiator && (document.activeElement === initiator || document.activeElement === document.body)) {
      document.getElementById(error ? "data-error" : "workspace")?.focus();
    }
  }, [loading, error, importCompletion]);

  function replaceUrl(url: string) {
    window.history.replaceState(null, "", url);
    lastLocation.current = window.location.pathname + window.location.search;
  }

  function acceptDataset(next: Dataset, reset: boolean) {
    setData(next); setTick(0); setPlaying(false); setShareUrl("");
    if (reset) replaceUrl(window.location.pathname);
    try {
      setSelection(readSelection(new URLSearchParams(window.location.search), next)); setError("");
    } catch (e) {
      setSelection(null); setError(e instanceof Error ? e.message : "The shared selection is invalid.");
    }
  }

  async function loadDemo(reset = false, request: WindowRequest = requestWindow, jobId = "") {
    const generation = ++loadGeneration.current;
    loadFocus.current = document.activeElement?.closest("button, form") ? document.activeElement : null;
    setLoading(true); setError(""); setRetryLoad(null); setMessage(""); setPlaying(false);
    try {
      const next = await queryClient.fetchQuery({ queryKey: ["dataset", request, jobId], queryFn: async ({ signal }) => {
        if (!jobId) return getDataset(request, signal);
        const job = await getJob(jobId, request, signal);
        if (job.status !== "done") throw new Error(job.status === "failed" ? job.problem.detail : "The shared job has not completed. Retry when its result is ready.");
        return job.result;
      }, staleTime: reset ? 0 : 60000 });
      if (generation === loadGeneration.current) {
        setSharedJobId(jobId); setRequestWindow(request); acceptDataset(next, reset);
        setMessage(next.scenarios.length ? { text: "Loaded {count} observation windows.", values: { count: next.scenarios.length } } : "No observation windows in this UTC range.");
      }
    } catch (e) {
      if (generation === loadGeneration.current) { setError(e instanceof Error ? e.message : "Data could not load."); setRetryLoad({ request, jobId, reset }); }
    } finally { if (generation === loadGeneration.current) setLoading(false); }
  }

  const restoreLocation = useEffectEvent(() => {
    const location = window.location.pathname + window.location.search;
    if (location === lastLocation.current) return;
    lastLocation.current = location;
    loadGeneration.current++;
    loadFocus.current = null;
    setRetryLoad(null); setSelection(null); setTick(0); setPlaying(false); setShareUrl(""); setMessage(""); setError("");
    const params = new URLSearchParams(window.location.search);
    try {
      for (const key of ["from", "to", "resolutionSeconds", "job"]) if (params.getAll(key).length > 1) throw new Error("The shared request contains duplicate fields.");
      const request = ["from", "to", "resolutionSeconds"].some((key) => params.has(key)) ? validateWindow({ from: params.get("from") ?? "", to: params.get("to") ?? "", resolutionSeconds: Number(params.get("resolutionSeconds")) }) : defaultWindow;
      const jobId = params.get("job") ?? "";
      if (jobId && !/^[a-zA-Z0-9._-]{1,100}$/.test(jobId)) throw new Error("The shared job ID is invalid.");
      if (data && params.get("v") === data.datasetId && jobId === sharedJobId && Date.parse(request.from) === Date.parse(requestWindow.from) && Date.parse(request.to) === Date.parse(requestWindow.to) && request.resolutionSeconds === requestWindow.resolutionSeconds) {
        setSelection(readSelection(params, data)); setLoading(false);
      } else {
        void loadDemo(false, request, jobId);
        // Browser history owns focus/scroll; a request must not move it to results.
        loadFocus.current = null;
      }
    } catch (e) { setLoading(false); setError(e instanceof Error ? e.message : "Invalid shared request range."); }
  });

  useEffect(() => {
    restoreLocation();
    const restore = () => { loadFocus.current = null; restoreLocation(); };
    window.addEventListener("popstate", restore);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => { setReducedMotion(preference.matches); if (preference.matches) setPlaying(false); };
    change(); preference.addEventListener("change", change);
    return () => { lastLocation.current = null; loadGeneration.current++; void queryClient.cancelQueries({ queryKey: ["dataset"] }); window.removeEventListener("popstate", restore); preference.removeEventListener("change", change); };
    // Initial load, browser history and OS motion preference are external subscriptions.
  }, []);

  const a = data?.scenarios.find((s) => s.id === selection?.a);
  const b = data?.scenarios.find((s) => s.id === selection?.b);
  const windows = useMemo(() => data ? publishedWindows(data.scenarios) : [], [data]);
  const siteWindow = useMemo(() => windows.find(group => group.some(s => s.id === a?.id)), [windows, a]);
  const compatible = data && a && selection ? alternatives(data, a, selection.mode) : [];
  function siteOption(s: Scenario) {
    const name = data!.sites.find(site => site.id === s.siteId)!.name;
    return name + " · " + s.id;
  }
  const offsets = a ? commonOffsets(a, b) : [];
  const offset = offsets[Math.min(tick, offsets.length - 1)] ?? 0;
  useEffect(() => {
    if (!playing || reducedMotion || offsets.length < 2) return;
    if (tick >= offsets.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setTick((v) => v + 1), 900);
    return () => window.clearTimeout(timer);
  }, [playing, reducedMotion, tick, offsets.length]);

  async function importFile(file?: File) {
    if (!file) return;
    const generation = ++loadGeneration.current;
    loadFocus.current = document.activeElement;
    setLoading(true); setPlaying(false); setMessage(""); setRetryLoad(null); setError("");
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error("Choose a JSON dataset smaller than 5 MB.");
      const next = validateDataset(JSON.parse(await file.text()));
      if (generation === loadGeneration.current) {
        setSharedJobId("");
        acceptDataset(next, false);
        setMessage("Dataset imported locally. Structural checks passed; scientific validity is not verified. No file was uploaded.");
      }
    } catch (e) {
      if (generation === loadGeneration.current) setError({ importReason: e instanceof Error ? e.message : "Invalid JSON." });
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
        // Repeated size rejections can leave loading and error unchanged.
        setImportCompletion(generation);
      }
    }
  }

  function choose(nextA: Scenario, mode: Mode, nextB?: string) {
    if (!data || !selection) return;
    const compatible = alternatives(data, nextA, mode);
    setSelection({ ...selection, mode, a: nextA.id, b: compatible.find((s) => s.id === nextB)?.id ?? compatible[0]?.id ?? "" });
    setTick(0); setPlaying(false); setShareUrl(""); setMessage(""); setError("");
    replaceUrl(window.location.pathname);
  }

  async function share() {
    if (!data || !selection || !b) return;
    const url = new URL(window.location.href);
    url.search = selectionParams(data, selection).toString(); url.hash = "";
    for (const key of ["from", "to", "resolutionSeconds"] as const) url.searchParams.set(key, String(requestWindow[key]));
    if (sharedJobId) url.searchParams.set("job", sharedJobId);
    setShareUrl(url.href); replaceUrl(url.href);
    try {
      await navigator.clipboard.writeText(url.href);
      setMessage("Selection link copied. Imported datasets must be supplied separately; a localhost link opens only on this computer.");
    } catch { setMessage("Copy the selection link below. Imported datasets must be supplied separately; a localhost link opens only on this computer."); }
  }

  function printReport() {
    setPlaying(false);
    const details = Array.from(document.querySelectorAll("details"));
    const before = details.map((d) => d.open);
    details.forEach((d) => { d.open = true; });
    window.print();
    details.forEach((d, i) => { d.open = before[i]; });
  }

  function findMatch() {
    if (!data || !a || !selection) return;
    const result = laterMatch(data, a, selection.h);
    if (result.candidate) {
      choose(a, "dates", result.candidate.id);
      setMessage(result.unresolvedBefore ? "A later published window meets the criterion. Earlier candidates have unresolved assessments, so this is not a confirmed first match." : "Selected the first later match in the published candidate set. Dates outside this dataset were not searched.");
    } else setMessage(result.unresolvedBefore ? "No definite later match. Some published candidates have missing or near-threshold assessments." : "No later published candidate meets this criterion. Dates outside this dataset were not searched.");
  }

  return <div className="app-shell">
    <a className="skip-link" href="#workspace">{t("Skip to comparison")}</a>
    <header className="app-header"><a className="brand" href="/">Moon Plan B</a><nav aria-label={t("Main")}><a href="#workspace" className="active-link">{t("Compare")}</a><a href="#sources">{t("Sources & method")}</a><ThemeControl /><LanguageControl /><button className="button outline" onClick={() => fileInput.current?.click()} disabled={loading}>{t("Import data")}</button></nav>
      <input ref={fileInput} aria-label={t("Import JSON dataset")} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
    </header>
    <section className="intro"><div className="hero-copy"><p className="eyebrow">{t("Lunar observation explorer")}</p><h1>{t("Find a clearer window.")}</h1><p className="lead">{t("Compare the Sun and Earth above the lunar horizon.")}</p>
      <div className="hero-actions"><a className="button primary" href="#workspace">{t("Explore the comparison")}{" "}<span aria-hidden="true">&nbsp;↗</span></a>{data && a && !loading ? <a className="button outline" href="#local-sky">{t("Explore the 3D sky")}</a> : <a className="button outline" href="#resources">{t("Explore lunar resources")}</a>}</div>
      <p className="muted text-sm hero-meta">{isMock ? t("Synthetic mock API · draft contract, pending backend agreement") : t("Backend API · draft compatibility requires producer review")} · <a href="/api-docs">{t("API explorer")}</a></p>
      <p className="data-notice">{!data ? isMock ? t("No scientific dataset connected. Use the demonstration or import a release.") : t("Waiting for a valid API dataset. You can also import a release.") : data.evidence === "synthetic-fixture" ? t("Demonstration data — fictional sites and values. Not for mission planning.") : t("Supplied data — scientific validity has not been independently verified. Not for mission planning.")}</p>
      </div><MoonGlobe />
    </section>

    <ApiControls request={requestWindow} loading={loading} onLoad={(request) => void loadDemo(true, request)} onResult={(next, range, jobId) => { loadGeneration.current++; setLoading(false); setRetryLoad(null); setRequestWindow({ from: range.from, to: range.to, resolutionSeconds: range.resolutionSeconds }); setSharedJobId(isMock ? "" : jobId); acceptDataset(next, true); setMessage(isMock ? "Mock job finished. These are synthetic fixture results; your coordinates were not calculated." : "Job result received. Shared links depend on backend job retention. Scientific validity is not independently verified."); }} />
    {error ? <div id="data-error" tabIndex={-1} role="alert" className="error-state"><h2>{t("We could not use that data or selection.")}</h2><p>{typeof error === "string" ? t(error) : t("Import rejected: {reason} The previous dataset has not changed.", { reason: t(error.importReason) })}</p><div className="flex flex-wrap gap-3 mt-4">{data && !selection ? <button className="button primary" onClick={() => { acceptDataset(data, true); setMessage("Saved selection cleared. Using the loaded dataset’s default windows."); }}>{t("Use loaded dataset")}</button> : null}{retryLoad ? <button className="button outline" onClick={() => void loadDemo(retryLoad.reset, retryLoad.request, retryLoad.jobId)}>{t("Retry API request")}</button> : null}{isMock || !retryLoad ? <button className="button outline" onClick={() => void loadDemo(true, isMock ? defaultWindow : requestWindow, isMock ? "" : sharedJobId)}>{isMock ? t("Reset to demonstration") : t("Retry API request")}</button> : null}<button className="button outline" onClick={() => fileInput.current?.click()}>{t("Import the correct dataset")}</button></div></div> : null}
    <div className="live-status" role="status" aria-live="polite">{loading ? t("Loading dataset…") : t(message)}</div>

    {loading ? <main id="workspace" className="loading-state" aria-busy="true"><div className="loading-line" /><h2>{t("Opening the dataset")}</h2><p className="muted">{t("Checking the schema, UTC windows and coverage before displaying results.")}</p></main> : data && selection && a ? <main id="workspace" className="workspace" tabIndex={-1}>
      <aside className="controls" aria-label={t("Comparison controls")}>
        <div className="mode-switch" role="group" aria-label={t("Comparison mode")}>{(["dates", "sites"] as const).map((mode) => <button key={mode} aria-pressed={selection.mode === mode} onClick={() => choose(a, mode)}>{mode === "dates" ? t("Compare dates") : t("Compare sites")}</button>)}</div>
        {selection.mode === "sites" && siteWindow ? <>
          <label className="field">{t("Published UTC window")}<select value={siteWindow[0].id} onChange={e => {
            const group = windows.find(group => group[0].id === e.target.value)!;
            choose(group.find(s => s.siteId === a.siteId) ?? group[0], "sites", group.find(s => s.siteId === b?.siteId)?.id);
          }}>{windows.map(([first]) => <option key={first.id} value={first.id}>{first.startUtc.replace(/T00:00:00(?:\.000)?Z$/, "")} · {durationHours(first)} h</option>)}</select></label>
          <label className="field">{t("Primary site")}<select value={a.id} onChange={e => {
            const next = siteWindow.find(s => s.id === e.target.value)!;
            choose(next, "sites", next.siteId === b?.siteId ? a.id : b?.id);
          }}>
            {siteWindow.map(s => <option key={s.id} value={s.id}>{siteOption(s)}</option>)}</select></label>
        </> : <>
          <label className="field">{t("Site")}<select value={a.siteId} onChange={(e) => { const next = data.scenarios.find((s) => s.siteId === e.target.value && Date.parse(s.startUtc) === Date.parse(a.startUtc)) ?? data.scenarios.find((s) => s.siteId === e.target.value); if (next) choose(next, "dates"); }}>{data.sites.filter((s) => data.scenarios.some((v) => v.siteId === s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="field">{t("Primary window")}<select value={a.id} onChange={(e) => choose(data.scenarios.find((s) => s.id === e.target.value)!, "dates")}>{data.scenarios.filter((s) => s.siteId === a.siteId).map((s) => <option key={s.id} value={s.id}>{formatUtc(s.startUtc, locale)} · {durationHours(s)} h{s.coverage !== "complete" ? ` · ${t(s.coverage)}` : ""}</option>)}</select></label>
        </>}
        <label className="field">{selection.mode === "dates" ? t("Compare with") : t("Alternative site")}<select value={selection.b} disabled={compatible.length === 0} onChange={(e) => choose(a, selection.mode, e.target.value)}>{compatible.length === 0 ? <option value="">{t("No compatible window")}</option> : compatible.map((s) => <option key={s.id} value={s.id}>{selection.mode === "dates" ? formatUtc(s.startUtc, locale) : siteOption(s)}{s.coverage !== "complete" ? ` · ${t(s.coverage)}` : ""}</option>)}</select></label>
        <div className="field">{t("Window")}<p className="fixed-value">{durationHours(a)} {t("hours")}{" "}<span className="muted text-sm">{t("from the dataset")}</span></p></div>
        <label className="field">{t("Joint-window criterion")}<select value={selection.h} onChange={(e) => { setSelection({ ...selection, h: Number(e.target.value) }); setShareUrl(""); replaceUrl(window.location.pathname); }}>{data.criteriaHours.map((h) => <option value={h} key={h}>{h} {t("hours")}</option>)}</select></label>
        {selection.mode === "dates" ? <button className="text-button find-match" onClick={findMatch}>{t("Find a later published match")}</button> : null}
        <div className="control-actions"><AnimatedButton type="button" className="button primary" disabled={!b} onClick={() => void share()}>{t("Share comparison")}</AnimatedButton><button className="button outline" onClick={printReport}>{t("Print report")}</button></div>
        {shareUrl ? <label className="field share-field">{t("Selection link")}<input readOnly value={shareUrl} onFocus={(e) => e.target.select()} /></label> : null}
        <p className="muted text-xs mt-5">{t("Only supplied windows are selectable. Requests include a bounded UTC range and desired resolution; the server supplies the observations.")}</p>
        <button className="text-button mt-4" onClick={() => void loadDemo(true, requestWindow, sharedJobId)}>{t("Reload current window")}</button>
      </aside>
      <div className="results">
        {selection.mode === "sites" && siteWindow && <SiteAssessments data={data} scenarios={siteWindow} h={selection.h} />}
        <div className="window-labels"><p><strong>{t("Primary")}</strong> {data.sites.find((s) => s.id === a.siteId)?.name}<span>{formatUtc(a.startUtc, locale)} → {formatUtc(a.endUtc, locale)}</span></p>{b ? <p><strong>{t("Alternative")}</strong> {data.sites.find((s) => s.id === b.siteId)?.name}<span>{formatUtc(b.startUtc, locale)} → {formatUtc(b.endUtc, locale)}</span></p> : <p>{t("No compatible alternative in this release. The primary remains visible.")}</p>}</div>
        {a.coverage !== "complete" || b && b.coverage !== "complete" ? <p className="coverage-notice">{t("Incomplete coverage: unavailable totals are not zero. Gaps are not bridged, and no definite threshold result is inferred.")}</p> : null}
        <Timeline a={a} b={b} mode={selection.mode} offset={offset} />
        <div className="playback"><button className="button play-button" aria-label={playing ? t("Pause timeline") : t("Play timeline")} disabled={offsets.length < 2 || reducedMotion} onClick={() => { if (tick === offsets.length - 1) setTick(0); setPlaying((v) => !v); }}><svg viewBox="0 0 20 20" aria-hidden="true">{playing ? <path d="M5 3h3v14H5zm7 0h3v14h-3z" /> : <path d="m6 3 11 7-11 7z" />}</svg></button>
          <label className="slider-label"><span className="sr-only">{t("Timeline sample")}</span><input aria-label={t("Timeline sample")} aria-valuetext={offsets.length ? t("{hours} hours elapsed. Primary {primary}{alternative}", { hours: offset / 3600000, primary: formatUtc(new Date(Date.parse(a.startUtc) + offset).toISOString(), locale), alternative: b ? t(". Alternative {time}", { time: formatUtc(new Date(Date.parse(b.startUtc) + offset).toISOString(), locale) }) : "" }) : t("No shared samples")} type="range" min="0" max={Math.max(0, offsets.length - 1)} step="1" value={Math.min(tick, Math.max(0, offsets.length - 1))} disabled={offsets.length === 0} onChange={(e) => { setTick(Number(e.target.value)); setPlaying(false); }} /></label><output className="mono">{offsets.length ? `+${(offset / 3600000).toFixed(1)} h` : t("No shared samples")}</output>
        </div>
        <p className="sample-time">{offsets.length ? <>{t("Primary:")}{" "}{formatUtc(new Date(Date.parse(a.startUtc) + offset).toISOString(), locale)}{b ? <> · {t("Alternative:")}{" "}{formatUtc(new Date(Date.parse(b.startUtc) + offset).toISOString(), locale)}</> : null}</> : t("The pair has no shared sample times. Exact observations are available in the sample table where present.")}</p>
        {reducedMotion ? <p className="muted text-sm">{t("Reduced motion is on. Use the slider to select samples without playback.")}</p> : null}
        <LocalSky data={data} a={a} b={b} offset={offsets.length ? offset : undefined} />
        <div className="detail-row"><SkyPosition scenario={a} offset={offsets.length ? offset : -1} /><Comparison a={a} b={b} h={selection.h} /></div>
        <SampleTable a={a} b={b} /><Windows a={a} b={b} />
      </div>
    </main> : !loading && data && data.scenarios.length === 0 ? <main id="workspace" className="empty-state" tabIndex={-1}><h2>{t("No observation windows in this dataset")}</h2><p>{isMock ? t("Import a release containing scenarios, or explore the clearly labeled demonstration.") : t("Request another UTC range above, or import a release containing scenarios.")}</p><button className="button primary" onClick={() => void loadDemo(true, defaultWindow)}>{isMock ? t("Explore demonstration") : t("Load default date range")}</button></main> : null}
    {data && !loading ? <Sources data={data} a={a} b={b} /> : null}
    <section id="resources" className="reference-resources" aria-labelledby="resources-heading"><p className="eyebrow">{t("Beyond the comparison")}</p><h2 id="resources-heading">{t("Explore the Moon through its sources.")}</h2><p className="muted">{t("Reference material for learning and cross-checks. These links do not supply the synthetic comparison values.")}</p><div className="resource-links">
      <a href="https://svs.gsfc.nasa.gov/5001/" target="_blank" rel="noreferrer"><strong>{t("The Moon, frame by frame ↗")}</strong><span>{t("See the source and credits for the LRO photographic mosaic.")}</span></a>
      <a href="https://ssd.jpl.nasa.gov/horizons/manual.html#observer-table" target="_blank" rel="noreferrer"><strong>{t("Understand the observations ↗")}</strong><span>{t("Read the JPL Horizons observer-table documentation and coordinate conventions.")}</span></a>
      <a href="https://trek.nasa.gov/moon/" target="_blank" rel="noreferrer"><strong>{t("Explore lunar terrain ↗")}</strong><span>{t("Open NASA Moon Trek in a separate tab to explore its lunar map.")}</span></a>
    </div></section>
    <footer className="app-footer"><p>{t("Ideal horizon only. Terrain, power and radio links are not modeled.")}</p><p>{t("Frontend draft · AI-assisted implementation ·")}{" "}<a href="https://github.com/justsomenewbie/moon-plan-b" target="_blank" rel="noreferrer">{t("Project repository")}</a></p></footer>
  </div>;
}

"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { defaultTerrainSites, defaultWindow, getDataset, getJob, getTerrainWindow, isMock, validateCustomWindow, validateTerrainWindow, validateWindow } from "../lib/api/client";
import { parseTerrainSummary, readTerrainObservation } from "../lib/api/terrain-summary";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import type { DisplayedPair } from "./terrain-pair";
import TerrainResult from "./terrain-result";
import type { TerrainTarget, WindowRequest } from "../lib/api/client";
import { ApiControls } from "./requests";
import { LunarResources, SiteFooter, SiteHeader, SkyBackground } from "./site-chrome";
import AstronautGuide from "./astronaut-guide";
import { workspaceGuideContext } from "../lib/api/guide-chat";
import MoonGlobe from "./moon-globe";
import LocalSky from "./local-sky";
import ImportDialog from "./import-dialog";
import { useLanguage } from "./language";
import type { Message } from "../lib/i18n";
import { alternatives, commonOffsets, durationHours, laterMatch, publishedWindows, readSelection, sampleAt, selectionParams, sharedDatasetVersion, validateDataset } from "../lib/dataset";
import type { Dataset, Mode, Scenario, Selection } from "../lib/dataset";
import { Comparison, formatUtc, SampleTable, SiteAssessments, SkyPosition, Sources, Timeline, Windows } from "./observations";
import QaInspector from "./qa-inspector";
import ObservedWeek, { isSavedResultLink, savedResultFromUrl } from "./observed-week";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const needsRelease = "This link needs a different dataset version. Import that exact release before reopening it.";

export default function Navigator() {
  const { t, locale } = useLanguage();
  const queryClient = useQueryClient();
  const [requestWindow, setRequestWindow] = useState(defaultWindow);
  const [skyAlternative, setSkyAlternative] = useState(false);
  const [sharedJobId, setSharedJobId] = useState("");
  const [data, setData] = useState<Dataset | null>(null);
  const [terrain, setTerrain] = useState<TerrainSummary | null>(null);
  const [displayedPair, setDisplayedPair] = useState<DisplayedPair | null>(null);
  const [terrainView, setTerrainView] = useState({ siteIndex: 0, sample: 0, link: "" });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [importCompletion, setImportCompletion] = useState(0);
  const [error, setError] = useState<string | { importReason: string; syntax?: boolean }>("");
  const [retryLoad, setRetryLoad] = useState<{ request: WindowRequest; jobId: string; target?: TerrainTarget; reset: boolean } | null>(null);
  const [message, setMessage] = useState<Message>("");
  const [shareUrl, setShareUrl] = useState("");
  const [savedResult, setSavedResult] = useState(() => savedResultFromUrl(new URLSearchParams()));
  const [clearanceDeg, setClearanceDeg] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [qaEnabled, setQaEnabled] = useState(false);
  const importDialog = useRef<HTMLDialogElement>(null);
  const recoverPinnedImport = useRef(false);
  const loadGeneration = useRef(0);
  const loadFocus = useRef<Element | null>(null);
  const lastLocation = useRef<string | null>(null);
  const pendingAnchor = useRef("");

  useEffect(() => {
    if (loading) return;
    // The fragment target is absent until the live dataset has rendered.
    if (pendingAnchor.current && window.location.hash === pendingAnchor.current) {
      document.getElementById(pendingAnchor.current.slice(1))?.scrollIntoView();
    }
    pendingAnchor.current = "";
    const initiator = loadFocus.current;
    loadFocus.current = null;
    // Restore focus lost during loading without taking it from another control.
    if (initiator && (document.activeElement === initiator || document.activeElement === document.body)) {
      const target = document.getElementById(error ? "data-error" : "workspace");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start", behavior: "instant" });
    }
  }, [loading, error, importCompletion]);

  useEffect(() => { setQaEnabled(new URLSearchParams(window.location.search).get("qa") === "true"); }, []);

  function replaceUrl(url: string) {
    if (!url.includes("?") && qaEnabled) url += "?qa=true";
    const next = new URL(url, window.location.href);
    next.searchParams.delete("saved");
    lastLocation.current = next.pathname + next.search;
    const current = new URLSearchParams(window.location.search);
    if (current.has("saved")) next.searchParams.set("saved", savedResultFromUrl(current));
    window.history.replaceState(null, "", next);
  }

  function chooseSavedResult(value: string) {
    const next = new URL(window.location.href);
    next.searchParams.set("saved", value);
    next.hash = "observed-week";
    window.history.pushState(null, "", next);
    setSavedResult(value);
  }

  function acceptDataset(next: Dataset, reset: boolean) {
    setTerrain(null);
    setData(next); setSkyAlternative(false); setPlaying(false); setShareUrl("");
    if (reset) replaceUrl(window.location.pathname);
    try {
      setSelection(readSelection(new URLSearchParams(window.location.search), next)); setError("");
      return true;
    } catch (e) {
      setSelection(null); setError(e instanceof Error ? e.message : "The shared selection is invalid.");
      return false;
    }
  }

  function showObservation(result: TerrainSummary, siteIndex: number, sample: number, url?: URL, updateAddress = false) {
    const site = result.sites[siteIndex];
    if (url && site) {
      url.searchParams.set("view_site", site.id);
      const at = site.series?.t[sample];
      if (at) url.searchParams.set("at", at);
      else url.searchParams.delete("at");
      url.hash = "terrain-observations";
    }
    setTerrainView({ siteIndex, sample, link: url?.href ?? "" });
    if (updateAddress) replaceUrl(url?.href ?? window.location.pathname);
  }

  function acceptTerrain(next: TerrainSummary, reset: boolean, request?: WindowRequest, target?: TerrainTarget) {
    const { siteIndex, sample } = !reset ? readTerrainObservation(new URLSearchParams(window.location.search), next) : { siteIndex: 0, sample: 0 };
    let url: URL | undefined;
    if (request) {
      url = new URL(window.location.pathname, window.location.origin);
      url.search = new URLSearchParams({ from: request.from, to: request.to, resolutionSeconds: String(request.resolutionSeconds), run_id: next.run.run_id }).toString();
      if (target?.site_id) url.searchParams.set("site_id", target.site_id);
      url.hash = "workspace";
    }
    setData(null); setSelection(null); setTerrain(next); setSharedJobId(""); setShareUrl(""); setError(""); setPlaying(false);
    showObservation(next, siteIndex, sample, url, reset);
  }

  async function loadDemo(reset = false, request: WindowRequest = requestWindow, jobId = "", target?: TerrainTarget, refresh = false) {
    const generation = ++loadGeneration.current;
    loadFocus.current = document.activeElement?.closest("button, form") ? document.activeElement : null;
    setLoading(true); setError(""); setRetryLoad(null); setMessage(""); setPlaying(false);
    try {
      // A paused offline request would also lock the local file import until reconnection.
      const next = await queryClient.fetchQuery({ queryKey: ["dataset", request, jobId, target], queryFn: async ({ signal }) => {
        if (!jobId) return isMock ? getDataset(request, signal) : getTerrainWindow(request, signal, target);
        if (!isMock) throw new Error("This view accepts saved observation windows. Custom job links require the backend jobs interface.");
        const job = await getJob(jobId, request, signal);
        if (job.status !== "done") throw new Error(job.status === "failed" ? job.problem.detail : "The shared job has not completed. Retry when its result is ready.");
        return job.result;
      }, networkMode: isMock ? "online" : "always", staleTime: reset || refresh ? 0 : 60000 });
      if (generation === loadGeneration.current) {
        setRequestWindow(request);
        if ("schema_version" in next) {
          acceptTerrain(next, reset, request, target);
          setMessage("Loaded terrain-model results from the team API.");
        } else {
          setSharedJobId(jobId);
          if (!acceptDataset(next, reset)) return;
          setMessage(next.scenarios.length ? { text: "Loaded {count} observation windows.", values: { count: next.scenarios.length } } : "No observation windows in this UTC range.");
        }
      }
    } catch (e) {
      if (generation === loadGeneration.current) { setError(e instanceof Error ? e.message : "Data could not load."); setRetryLoad({ request, jobId, target, reset }); }
    } finally { if (generation === loadGeneration.current) setLoading(false); }
  }

  const restoreLocation = useEffectEvent(() => {
    const url = new URL(window.location.href);
    pendingAnchor.current = url.hash;
    setSavedResult(savedResultFromUrl(url.searchParams));
    url.searchParams.delete("saved");
    const location = url.pathname + url.search;
    if (location === lastLocation.current) { pendingAnchor.current = ""; return; }
    lastLocation.current = location;
    loadGeneration.current++;
    loadFocus.current = null;
    setRetryLoad(null); setSelection(null); setPlaying(false); setShareUrl(""); setMessage(""); setError("");
    const params = new URLSearchParams(window.location.search);
    setQaEnabled(params.get("qa") === "true");
    const hasObservation = params.has("view_site") || params.has("at");
    setTerrain(null);
    try {
      const version = sharedDatasetVersion(params);
      if (hasObservation && !params.get("run_id")) throw new Error("The shared observation needs a pinned model run.");
      for (const key of ["from", "to", "resolutionSeconds", "job", "run_id", "site_id", "view_site", "at"]) if (params.getAll(key).length > 1) throw new Error("The shared request contains duplicate fields.");
      const validateRange = isMock ? validateWindow : params.has("site_id") ? validateCustomWindow : validateTerrainWindow;
      const request = ["from", "to", "resolutionSeconds"].some((key) => params.has(key)) ? validateRange({ from: params.get("from") ?? "", to: params.get("to") ?? "", resolutionSeconds: Number(params.get("resolutionSeconds")) }) : defaultWindow;
      const jobId = params.get("job") ?? "";
      const runId = params.get("run_id") ?? undefined;
      if (runId !== undefined && (!/^[A-Za-z0-9_.-]{1,64}$/.test(runId) || jobId || isMock)) throw new Error("This run link requires a live backend and a valid model run ID.");
      const siteId = params.get("site_id") ?? undefined;
      if (siteId !== undefined && (!runId || !/^[A-Za-z0-9_.:-]{1,64}$/.test(siteId))) throw new Error("The shared site requires a model run and a valid site ID.");
      if (params.has("job") && !/^[a-zA-Z0-9._-]{1,100}$/.test(jobId)) throw new Error("The shared job ID is invalid.");
      if (data && version === data.datasetId && jobId === sharedJobId && Date.parse(request.from) === Date.parse(requestWindow.from) && Date.parse(request.to) === Date.parse(requestWindow.to) && request.resolutionSeconds === requestWindow.resolutionSeconds) {
        setSelection(readSelection(params, data)); setLoading(false);
      } else if (version !== null && !isMock) {
        throw new Error(needsRelease);
      } else {
        void loadDemo(false, request, jobId, runId ? { run_id: runId, site_id: siteId } : undefined);
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
  const comparisonHref = loading || a || terrain || data?.scenarios.length === 0 ? "#workspace" : "#data-error";
  const guideContext = useMemo(() => workspaceGuideContext(loading ? null : terrain, loading ? null : data, a, b, terrainView.siteIndex),
    [loading, terrain, data, a, b, terrainView.siteIndex]);
  function guideMode(mode: Mode) {
    if (loading) return undefined;
    if (terrain) {
      if (!terrainView.link || !terrain.sites.length) return undefined;
      return () => {
        const id = mode === "sites" ? "terrain-pair" : "terrain-dates";
        const panel = document.getElementById(id);
        const details = panel instanceof HTMLDetailsElement ? panel : panel?.querySelector("details");
        if (!details) return;
        details.open = true;
        details.querySelector("summary")?.focus();
      };
    }
    if (!a || !data || !selection || !alternatives(data, a, mode).length) return undefined;
    return () => { choose(a, mode); document.getElementById("workspace")?.focus(); };
  }
  const windows = useMemo(() => data ? publishedWindows(data.scenarios) : [], [data]);
  const siteWindow = useMemo(() => windows.find(group => group.some(s => s.id === a?.id)), [windows, a]);
  const compatible = data && a && selection ? alternatives(data, a, selection.mode) : [];
  function siteOption(s: Scenario) {
    const name = data!.sites.find(site => site.id === s.siteId)!.name;
    return name + " · " + s.id;
  }
  const offsets = a ? commonOffsets(a, b) : [];
  const tick = selection?.tick ?? 0;
  const offset = offsets[Math.min(tick, offsets.length - 1)] ?? 0;
  function selectTick(next: number) {
    if (!selection || !a || offsets[next] === undefined) return;
    setSelection({ ...selection, tick: next });
    const url = new URL(window.location.href);
    if (url.searchParams.get("v") === data?.datasetId) {
      url.searchParams.set("sample", sampleAt(a, offsets[next])!.utc);
      replaceUrl(url.href);
      setShareUrl("");
      setMessage("");
    }
  }
  const advance = useEffectEvent(() => selectTick(tick + 1));
  useEffect(() => {
    if (!playing || reducedMotion || offsets.length < 2) return;
    if (tick >= offsets.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(advance, 900);
    return () => window.clearTimeout(timer);
  }, [playing, reducedMotion, tick, offsets.length]);

  async function importFile(file?: File) {
    if (!file) return;
    const generation = ++loadGeneration.current;
    loadFocus.current = document.activeElement;
    setLoading(true); setPlaying(false); setMessage(""); setError("");
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error("Choose a JSON dataset of 5 MiB or less.");
      const input = JSON.parse(await file.text());
      const pin = recoverPinnedImport.current && retryLoad?.target && !retryLoad.reset ? retryLoad : null;
      if (pin && input?.schema_version !== "lunarnav-dataset-1") throw new Error("Choose a terrain export for the shared model run.");
      const next = input?.schema_version === "lunarnav-dataset-1" ? parseTerrainSummary(input, pin?.request) : validateDataset(input);
      if (generation === loadGeneration.current) {
        if ("schema_version" in next) {
          const params = new URLSearchParams(window.location.search);
          if (!selection && sharedDatasetVersion(params) !== null) throw new Error(needsRelease);
          if (pin?.target) {
            if (next.run.run_id !== pin.target.run_id) throw new Error("The returned model run differs from the shared link.");
            if (next.sites.map(site => site.id).join(",") !== (pin.target.site_id ?? defaultTerrainSites))
              throw new Error("The returned sites do not match the requested comparison.");
            // A series may retain transitions between its regular samples. The range step is the native grid.
            const spacing = Math.max(1, Math.floor(pin.request.resolutionSeconds / next.range.step_s)) * next.range.step_s;
            if (next.sites.some(site => site.coverage_in_range !== "missing" && site.series?.step_s !== spacing))
              throw new Error("The export does not contain the observation series at the shared sampling step.");
          }
          // Local recovery restores the pinned observation without offering live actions.
          acceptTerrain(next, !pin);
          if (pin) setRequestWindow(pin.request);
          setRetryLoad(null);
        } else {
          setRetryLoad(null); setSharedJobId("");
          if (!acceptDataset(next, false)) return;
        }
        setMessage("Dataset imported locally. Structural checks passed; scientific validity is not verified. No file was uploaded.");
      }
    } catch (e) {
      if (generation === loadGeneration.current) setError({ importReason: e instanceof Error ? e.message : "Invalid JSON.", syntax: e instanceof SyntaxError });
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
    setSelection({ ...selection, mode, tick: 0, a: nextA.id, b: compatible.find((s) => s.id === nextB)?.id ?? compatible[0]?.id ?? "" });
    setPlaying(false); setShareUrl(""); setMessage(""); setError("");
    replaceUrl(window.location.pathname);
  }

  async function share() {
    if (!data || !selection || !b) return;
    const url = new URL(window.location.href);
    url.search = selectionParams(data, selection).toString(); url.hash = "";
    if (qaEnabled) url.searchParams.set("qa", "true");
    for (const key of ["from", "to", "resolutionSeconds"] as const) url.searchParams.set(key, String(requestWindow[key]));
    if (sharedJobId) url.searchParams.set("job", sharedJobId);
    setShareUrl(url.href); replaceUrl(url.href);
    try {
      await navigator.clipboard.writeText(url.href);
      setMessage("Selection link copied. Imported datasets must be supplied separately; a localhost link opens only on this computer.");
    } catch { setMessage("Copy the selection link below. Imported datasets must be supplied separately; a localhost link opens only on this computer."); }
  }

  const reportShell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shell = reportShell.current;
    if (!shell) return;
    const openedForPrint = new Set<HTMLDetailsElement>();
    const beforePrint = () => {
      if (!shell.dataset.printReport) {
        shell.dataset.printReport = isSavedResultLink(window.location) ? "saved" : "workspace";
      }
      const selector = shell.dataset.printReport === "saved" ? "#observed-week details:not([open])" : "details:not([open])";
      for (const details of shell.querySelectorAll<HTMLDetailsElement>(selector)) {
        openedForPrint.add(details);
        details.open = true;
      }
    };
    const afterPrint = () => {
      for (const details of openedForPrint) details.open = false;
      openedForPrint.clear();
      delete shell.dataset.printReport;
    };
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
      afterPrint();
    };
  }, []);

  function printReport(report: "saved" | "workspace") {
    setPlaying(false);
    if (reportShell.current) reportShell.current.dataset.printReport = report;
    window.print();
  }

  function findMatch() {
    if (!data || !a || !selection) return;
    const result = laterMatch(data, a, selection.h);
    if (result.candidate) {
      choose(a, "dates", result.candidate.id);
      setMessage(result.unresolvedBefore ? "A later published window meets the criterion. Earlier candidates have unresolved assessments, so this is not a confirmed first match." : "Selected the first later match in the published candidate set. Dates outside this dataset were not searched.");
    } else setMessage(result.unresolvedBefore ? "No definite later match. Some published candidates have missing or near-threshold assessments." : "No later published candidate meets this criterion. Dates outside this dataset were not searched.");
  }

  return <div className="app-shell" ref={reportShell}>
    <SkyBackground />
    <a className="skip-link" href={comparisonHref}>{t("Skip to comparison")}</a>
    <SiteHeader comparisonHref={comparisonHref} showSources={Boolean((data || terrain) && !loading)} />
    <div className="comparison-toolbar">
      <h1 className="comparison-heading">{t("Comparison tool")}</h1>
      <button className="button outline" type="button" aria-haspopup="dialog" aria-controls="import-dialog" disabled={loading} onClick={() => { recoverPinnedImport.current = false; importDialog.current?.showModal(); }}>{t("Import data")}</button>
    </div>
    <ImportDialog ref={importDialog} onImport={importFile} />
    <ObservedWeek selection={savedResult} onSelect={chooseSavedResult} onPrint={() => printReport("saved")}>
      <MoonGlobe savedResult={savedResult} primary={!loading && a ? data?.sites.find(site => site.id === a.siteId) : undefined}
        alternative={!loading && b ? data?.sites.find(site => site.id === b.siteId) : undefined} evidence={data?.evidence} showSky={setSkyAlternative} />
    </ObservedWeek>

    <div className="workspace-notice">
      <p className="muted text-sm">{isMock ? t("Synthetic mock API · draft contract, pending backend agreement") : t("Team API · terrain horizon model")} · <a href="/api-docs">{t("API explorer")}</a></p>
      <p className="data-notice">{terrain ? t("Terrain-model results use the supplied surface horizon. Visibility alone does not establish power or a radio link.") : !data ? isMock ? t("No scientific dataset connected. Use the demonstration or import a release.") : t("Waiting for a valid API dataset. You can also import a release.") : data.evidence === "synthetic-fixture" ? t("Demonstration data — fictional sites and values. Not for mission planning.") : t("Supplied data — scientific validity has not been independently verified. Not for mission planning.")}</p>
    </div>
    <ApiControls request={requestWindow} loading={loading} onTerrainResult={(request, target) => void loadDemo(true, request, "", target)} onLoad={(request) => void loadDemo(true, request)} onResult={(next, range, jobId) => { loadGeneration.current++; setLoading(false); setRetryLoad(null); setRequestWindow({ from: range.from, to: range.to, resolutionSeconds: range.resolutionSeconds }); setSharedJobId(isMock ? "" : jobId); acceptDataset(next, true); setMessage(isMock ? "Mock job finished. These are synthetic fixture results; your coordinates were not calculated." : "Job result received. Shared links depend on backend job retention. Scientific validity is not independently verified."); }} />
    {!loading && data && selection && a && qaEnabled ? <QaInspector data={data} active={a} onSelect={(scenario) => choose(scenario, "dates")} /> : null}
    {error ? <div id="data-error" tabIndex={-1} role="alert" className="error-state"><h2>{t("We could not use that data or selection.")}</h2><p>{typeof error === "string" ? t(error) : t("Import rejected: {reason} The previous dataset has not changed.", { reason: t(locale === "vi" && error.syntax ? "JSON syntax error. Check the file before trying again." : error.importReason) })}</p><div className="flex flex-wrap gap-3 mt-4">{data && !selection ? <button className="button primary" onClick={() => { acceptDataset(data, true); setMessage("Saved selection cleared. Using the loaded dataset’s default windows."); }}>{t("Use loaded dataset")}</button> : null}{retryLoad ? <button className="button outline" onClick={() => void loadDemo(retryLoad.reset, retryLoad.request, retryLoad.jobId, retryLoad.target, true)}>{t("Retry API request")}</button> : null}{isMock ? <button className="button outline" onClick={() => void loadDemo(true, defaultWindow)}>{t("Reset to demonstration")}</button> : null}<button className="button outline" aria-haspopup="dialog" aria-controls="import-dialog" onClick={() => { recoverPinnedImport.current = true; importDialog.current?.showModal(); }}>{t("Import the correct dataset")}</button></div></div> : null}
    <div className="live-status" role="status" aria-live="polite">{loading ? t("Loading dataset…") : t(message)}</div>

    {loading ? <main id="workspace" className="loading-state" aria-busy="true"><div className="loading-line" /><h2>{t("Opening the dataset")}</h2><p className="muted">{t("Checking the schema, UTC windows and coverage before displaying results.")}</p></main> : terrain ? <TerrainResult onDisplayedPair={setDisplayedPair} result={terrain} liveWindow={terrainView.link && terrain.sites.length ? requestWindow : undefined} view={terrainView} onSelect={(siteIndex, sample) => showObservation(terrain, siteIndex, sample, terrainView.link ? new URL(terrainView.link) : undefined, Boolean(terrainView.link))} onPrint={() => printReport("workspace")} /> : data && selection && a ? <main id="workspace" className="workspace" tabIndex={-1}>
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
        <div className="control-actions"><button type="button" className="button primary share-comparison" disabled={!b} onClick={() => void share()}>{t("Share comparison")}</button><button className="button outline" onClick={() => printReport("workspace")}>{t("Print report")}</button></div>
        {shareUrl ? <label className="field share-field">{t("Selection link")}<input readOnly value={shareUrl} onFocus={(e) => e.target.select()} /></label> : null}
        <p className="muted text-xs mt-5">{t("Only supplied windows are selectable. Requests include a bounded UTC range and desired resolution; the server supplies the observations.")}</p>
        <button className="text-button mt-4" onClick={() => void loadDemo(true, requestWindow, sharedJobId)}>{t("Reload current window")}</button>
      </aside>
      <div className="results">
        {selection.mode === "sites" && siteWindow && <SiteAssessments data={data} scenarios={siteWindow} h={selection.h} />}
        <div className="window-labels"><p><strong>{t("Primary")}</strong> {data.sites.find((s) => s.id === a.siteId)?.name}<span>{formatUtc(a.startUtc, locale)} → {formatUtc(a.endUtc, locale)}</span></p>{b ? <p><strong>{t("Alternative")}</strong> {data.sites.find((s) => s.id === b.siteId)?.name}<span>{formatUtc(b.startUtc, locale)} → {formatUtc(b.endUtc, locale)}</span></p> : <p>{t("No compatible alternative in this release. The primary remains visible.")}</p>}</div>
        {a.coverage !== "complete" || b && b.coverage !== "complete" ? <p className="coverage-notice">{t("Incomplete coverage: unavailable totals are not zero. Gaps are not bridged, and no definite threshold result is inferred.")}</p> : null}
        <Timeline a={a} b={b} mode={selection.mode} offset={offset} clearanceDeg={clearanceDeg} />
        <div className="playback"><button className="button play-button" aria-label={playing ? t("Pause timeline") : t("Play timeline")} disabled={offsets.length < 2 || reducedMotion} onClick={() => { if (tick === offsets.length - 1) selectTick(0); setPlaying((v) => !v); }}><svg viewBox="0 0 20 20" aria-hidden="true">{playing ? <path d="M5 3h3v14H5zm7 0h3v14h-3z" /> : <path d="m6 3 11 7-11 7z" />}</svg></button>
          <label className="slider-label"><span className="sr-only">{t("Timeline sample")}</span><input aria-label={t("Timeline sample")} aria-valuetext={offsets.length ? t(offset === 3600000 ? "1 hour elapsed. Primary {primary}{alternative}" : "{hours} hours elapsed. Primary {primary}{alternative}", { hours: offset / 3600000, primary: formatUtc(new Date(Date.parse(a.startUtc) + offset).toISOString(), locale), alternative: b ? t(". Alternative {time}", { time: formatUtc(new Date(Date.parse(b.startUtc) + offset).toISOString(), locale) }) : "" }) : t("No shared samples")} type="range" min="0" max={Math.max(0, offsets.length - 1)} step="1" value={Math.min(tick, Math.max(0, offsets.length - 1))} disabled={offsets.length === 0} onChange={(e) => { selectTick(Number(e.target.value)); setPlaying(false); }} /></label><output className="mono">{offsets.length ? `+${(offset / 3600000).toFixed(1)} h` : t("No shared samples")}</output>
        </div>
        <p className="sample-time">{offsets.length ? <>{t("Primary:")}{" "}{formatUtc(new Date(Date.parse(a.startUtc) + offset).toISOString(), locale)}{b ? <> · {t("Alternative:")}{" "}{formatUtc(new Date(Date.parse(b.startUtc) + offset).toISOString(), locale)}</> : null}</> : t("The pair has no shared sample times. Exact observations are available in the sample table where present.")}</p>
        {reducedMotion ? <p className="muted text-sm">{t("Reduced motion is on. Use the slider to select samples without playback.")}</p> : null}
        <LocalSky data={data} a={a} b={b} alternative={skyAlternative} setAlternative={setSkyAlternative} offset={offsets.length ? offset : undefined} clearanceDeg={clearanceDeg} setClearanceDeg={setClearanceDeg} />
        <div className="detail-row"><SkyPosition scenario={a} offset={offsets.length ? offset : -1} clearanceDeg={clearanceDeg} /><Comparison a={a} b={b} h={selection.h} /></div>
        <SampleTable a={a} b={b} /><Windows a={a} b={b} />
      </div>
    </main> : !loading && data && data.scenarios.length === 0 ? <main id="workspace" className="empty-state" tabIndex={-1}><h2>{t("No observation windows in this dataset")}</h2><p>{isMock ? t("Import a release containing scenarios, or explore the clearly labeled demonstration.") : t("Request another UTC range above, or import a release containing scenarios.")}</p><button className="button primary" onClick={() => void loadDemo(true, defaultWindow)}>{isMock ? t("Explore demonstration") : t("Load default date range")}</button></main> : null}
    {data && !loading ? <Sources data={data} a={a} b={b} /> : null}
    <AstronautGuide savedResult={savedResult} terrain={loading || error ? null : terrain} onSaved={chooseSavedResult}
      pair={!loading && displayedPair && displayedPair.terrain === terrain ? displayedPair.context : undefined}
      workspace={guideContext} workspaceActions={{ workspace: comparisonHref, saved: "#observed-week",
        sources: !loading && (data || terrain) ? "#sources" : undefined,
        compareSites: guideMode("sites"), compareDates: guideMode("dates") }} />
    <LunarResources />
    <SiteFooter />
  </div>;
}

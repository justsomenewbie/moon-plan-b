"use client";

import { ApiProblemText, useRetryCountdown, useProblemFields } from "./api-problem-text";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ExtraField } from "../lib/planner-source";
import { findAltDates, landingDelayHours, landingGridBounds, type AltDatesRequest, type AltDatesResponse } from "../lib/api/alt-dates";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import { useLanguage } from "./language";
import { TimeRange } from "./terrain-site-result";

const objectives = {
  earliest: "Earliest feasible landing",
  balanced: "Balanced Sun and Earth visibility",
  both: "Highest joint visibility",
  sun: "Highest sunlight percentage",
  earth: "Highest Earth visibility percentage",
  energy: "Highest mean tracking power",
} as const;

const rejectionLabels: Record<string, string> = {
  min_both_pct: "Minimum joint visibility (%)",
  require_sun_at_landing: "Require sunlight at landing",
  min_sun_pct: "Minimum sunlight",
  min_earth_pct: "Minimum Earth visibility",
  require_earth_at_landing: "Require Earth visibility at landing",
  min_continuous_sun_h: "Minimum continuous sunlight",
  min_continuous_earth_h: "Minimum continuous Earth visibility",
  max_dark_gap_h: "Maximum dark gap",
  max_comms_gap_h: "Maximum Earth visibility gap",
  min_sun_el_at_landing_deg: "Minimum Sun elevation at landing",
};

function utcInput(value: FormDataEntryValue | null) {
  const raw = String(value ?? "");
  return (raw.length === 16 ? raw + ":00" : raw) + "Z";
}

function candidateLink(candidate: AltDatesResponse["candidates"][number], search: AltDatesResponse) {
  const long = search.mission_duration_h > 366 * 24;
  if (search.step_s !== 3600 || (long && (search.run_id.startsWith("job_") || search.site_id.startsWith("custom:")))) return null;
  return "/compare?" + new URLSearchParams({
    from: candidate.landing_utc, to: candidate.mission_end_utc, resolutionSeconds: String(search.step_s),
    run_id: search.run_id, site_id: search.site_id, view_site: search.site_id,
  }) + (long ? "#workspace" : "#terrain-observations");
}

type SearchSite = { id: string; name: string };
export type LandingSearchProps = {
  runId: string; sites: readonly SearchSite[]; initialSiteId?: string;
  stepSeconds: number; from: string; to: string; coverageStart?: string; coverageEnd?: string;
  initialMissionHours?: number; initialObjective?: "both" | "sun" | "earth" | "earliest" | "balanced"; planner?: boolean;
  initialEarliest?: string; initialLatest?: string; initialExtras?: Partial<Record<ExtraField, string>>;
  initialSunAtLanding?: boolean; initialEarthAtLanding?: boolean;
};

export function LandingSearch({ runId, sites, initialSiteId, stepSeconds, from, to, coverageStart, coverageEnd, initialMissionHours, initialObjective, initialEarliest, initialLatest, initialExtras, initialSunAtLanding, initialEarthAtLanding, planner }: LandingSearchProps) {
  const { t } = useLanguage();
  const stepHours = stepSeconds / 3600;
  const defaultHours = Math.min((Date.parse(to) - Date.parse(from)) / 3600000, Math.max(1, Math.floor(24 / stepHours)) * stepHours);
  const duration = initialMissionHours ?? defaultHours;
  const lastAllowed = Date.parse(coverageEnd ?? to) - duration * 3600000;
  const latest = new Date(Math.min(lastAllowed, Math.max(Date.parse(from), Date.parse(to) - duration * 3600000))).toISOString().slice(0, 19);
  const lastSample = coverageEnd && new Date(Date.parse(coverageEnd) - stepSeconds * 1000).toISOString().slice(0, 19);
  const gridStart = coverageStart ?? from;
  const [completed, setCompleted] = useState<{ request: AltDatesRequest; search: AltDatesResponse }>();
  const search = completed?.search;
  const request = completed?.request;
  const grid = request && landingGridBounds(request.earliest, request.latest, stepSeconds, gridStart);
  const showGrid = request && grid && grid.first <= grid.last
    && (grid.first !== Date.parse(request.earliest) || grid.last !== Date.parse(request.latest));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | Error>("");
  const wait = useRetryCountdown(error);
  const { prefix, fieldAttributes } = useProblemFields(error);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  function clearSearch() {
    active.current?.abort();
    setCompleted(undefined);
    setPending(false);
    if (!wait) setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || wait) return;
    clearSearch();
    const inputs = new FormData(event.currentTarget);
    const objective = String(inputs.get("objective") ?? "");
    if (!Object.hasOwn(objectives, objective)) {
      setError("Choose valid landing search constraints.");
      return;
    }
    const siteId = planner ? String(inputs.get("landingSite") ?? "") : sites[0]?.id;
    if (!siteId || !sites.some(site => site.id === siteId)) { setError("Choose a site"); return; }
    const payload: AltDatesRequest = {
      run_id: runId, site_id: siteId,
      earliest: utcInput(inputs.get("earliest")), latest: utcInput(inputs.get("latest")),
      mission_h: Number(inputs.get("missionHours")), max_results: Number(inputs.get("maxResults")),
      constraints: { min_sun_pct: Number(inputs.get("minSunPct")), min_earth_pct: Number(inputs.get("minEarthPct")),
        max_dark_gap_h: inputs.get("maxDarkGap") ? Number(inputs.get("maxDarkGap")) : null,
        max_comms_gap_h: inputs.get("maxEarthGap") ? Number(inputs.get("maxEarthGap")) : null,
        min_both_pct: Number(inputs.get("minBothPct")), require_sun_at_landing: inputs.has("sunAtLanding"), require_earth_at_landing: inputs.has("earthAtLanding"),
        objective: objective as keyof typeof objectives, min_separation_h: Number(inputs.get("separationHours")) },
    };
    if (Date.parse(payload.latest) < Date.parse(payload.earliest)) {
      setError("Choose whole-second UTC landing bounds in chronological order.");
      return;
    }
    const missionEnd = Date.parse(payload.latest) + payload.mission_h * 3600000;
    if (coverageEnd && missionEnd > Date.parse(coverageEnd)) {
      setError("The mission must finish by the end of the model run. Choose an earlier latest landing or a shorter mission.");
      return;
    }
    const bounds = landingGridBounds(payload.earliest, payload.latest, stepSeconds, gridStart);
    if (bounds.first > bounds.last) {
      setError("This interval contains no landing time on the model grid. Widen the interval or select a model sample.");
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    try {
      const response = await findAltDates(payload, stepSeconds, controller.signal, gridStart);
      if (!controller.signal.aborted) setCompleted({ request: payload, search: response });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause : "The request could not be completed. Retry or check the connection.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return <>
    {!planner && <p>{sites[0]?.name}</p>}
    {planner && <p className="muted text-sm">{t("To test one landing time, use the same UTC time for both bounds. The model evaluates starts every {hours} h.", { hours: stepHours })}</p>}
    <form className="request-fields my-4 print:hidden" onSubmit={submit} onChange={clearSearch}>
      {planner && <label className="field">{t("Site")}
        <select name="landingSite" {...fieldAttributes("site_id")} defaultValue={initialSiteId ?? sites[0]?.id ?? ""} required>
          <option value="">{t("Choose a site")}</option>
          {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select></label>}
      <label className="field">{t("Earliest landing (UTC, inclusive)")}<input name="earliest" {...fieldAttributes("earliest")} type="datetime-local" step="1" min={coverageStart?.slice(0, 19)} max={lastSample} defaultValue={initialEarliest ?? from.slice(0, 19)} required /></label>
      <label className="field">{t("Latest landing (UTC, inclusive)")}<input name="latest" {...fieldAttributes("latest")} type="datetime-local" step="1" min={coverageStart?.slice(0, 19)} max={lastSample} defaultValue={initialLatest ?? latest} required /></label>
      <label className="field">{t("Mission duration (h)")}<input name="missionHours" {...fieldAttributes("mission_h")} type="number" min={stepHours} step="any" defaultValue={duration} required /></label>
      <label className="field">{t("Minimum joint visibility (%)")}<input name="minBothPct" {...fieldAttributes("constraints.min_both_pct")} type="number" min="0" max="100" step="any" defaultValue={initialExtras?.minBothPct ?? "0"} required /></label>
      <label className="field">{t("Minimum spacing between proposals (h)")}<input name="separationHours" {...fieldAttributes("constraints.min_separation_h")} type="number" min="0" step="any" defaultValue={initialExtras?.separationHours ?? "12"} required /></label>
      <label className="field">{t("Maximum proposals")}<input name="maxResults" {...fieldAttributes("max_results")} type="number" min="1" max="50" step="1" defaultValue={initialExtras?.maxResults ?? "5"} required /></label>
      <label className="field">{t("Order proposals by")}<select name="objective" {...fieldAttributes("constraints.objective")} defaultValue={initialObjective ?? (planner ? "both" : "earliest")}>
        {Object.entries(objectives).filter(([key]) => !planner || key !== "energy").map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
      </select></label>
      <label className="flex items-center gap-2"><input name="sunAtLanding" {...fieldAttributes("constraints.require_sun_at_landing")} type="checkbox" defaultChecked={initialSunAtLanding ?? !planner} />{t("Require sunlight at landing")}</label>
      <label className="flex items-center gap-2"><input name="earthAtLanding" {...fieldAttributes("constraints.require_earth_at_landing")} type="checkbox" defaultChecked={initialEarthAtLanding} />{t("Require Earth visibility at landing")}</label>
      {planner && <details className="basis-full">
        <summary>{t("Additional visibility requirements")}</summary>
        <div className="request-fields my-4">
          <label className="field">{t("Minimum sunlight (%)")}<input name="minSunPct" {...fieldAttributes("constraints.min_sun_pct")} type="number" min="0" max="100" step="any" defaultValue={initialExtras?.minSunPct ?? "0"} /></label>
          <label className="field">{t("Minimum Earth visibility (%)")}<input name="minEarthPct" {...fieldAttributes("constraints.min_earth_pct")} type="number" min="0" max="100" step="any" defaultValue={initialExtras?.minEarthPct ?? "0"} /></label>
          <label className="field">{t("Maximum dark gap (h)")}<input name="maxDarkGap" {...fieldAttributes("constraints.max_dark_gap_h")} defaultValue={initialExtras?.maxDarkGap} type="number" min="0" step="any" /></label>
          <label className="field">{t("Maximum Earth visibility gap (h)")}<input name="maxEarthGap" {...fieldAttributes("constraints.max_comms_gap_h")} defaultValue={initialExtras?.maxEarthGap} type="number" min="0" step="any" /></label>
        </div>
      </details>}
      <p className="basis-full muted text-sm">{t("Use whole {step} s steps for the mission duration.", { step: stepSeconds })}</p>
      <button className="button outline" type="submit" disabled={pending || wait > 0}>{wait ? t("Try again in {seconds} s", { seconds: wait }) : t("Search landing dates")}</button>
    </form>
    {pending && <p role="status">{t("Searching landing dates…")}</p>}
    {error && <p role="alert"><ApiProblemText error={error} fieldPrefix={prefix} /></p>}
    {search && request && <section data-landing-results={planner ? "" : undefined} aria-label={t("Landing search results")}>
      {planner && <h3>{sites.find(site => site.id === search.site_id)?.name}</h3>}
      <p role="status">{t("{feasible} of {evaluated} landing times meet the constraints. Showing {count}.", {
        feasible: search.n_feasible, evaluated: search.n_evaluated, count: search.candidates.length,
      })}</p>
      <p className="muted text-sm">{t("Requested landing window (inclusive)")} · <TimeRange start={request.earliest} end={request.latest} /><br />
        {showGrid && <>{t("First and last landing times on the model grid")} · <TimeRange start={new Date(grid.first).toISOString().replace(".000Z", "Z")} end={new Date(grid.last).toISOString().replace(".000Z", "Z")} /><br /></>}
        {t("Mission duration (h)")} · {search.mission_duration_h} · {t("Boundary precision")} ±{search.precision_h} h<br />
        {t("Run ID")} · <code className="break-all">{search.run_id}</code></p>
      <p className="muted text-sm">{t(objectives[search.constraints.objective])} · {t("Minimum joint visibility (%)")} {search.constraints.min_both_pct} · {t("Require sunlight at landing")} {t(search.constraints.require_sun_at_landing ? "Yes" : "No")} · {t("Require Earth visibility at landing")} {t(search.constraints.require_earth_at_landing ? "Yes" : "No")} · {t("Minimum spacing between proposals (h)")} {search.constraints.min_separation_h}</p>
      {(search.constraints.min_sun_pct > 0 || search.constraints.min_earth_pct > 0 || search.constraints.max_dark_gap_h !== null || search.constraints.max_comms_gap_h !== null) &&
        <ul className="muted text-sm">
          {search.constraints.min_sun_pct > 0 && <li>{t("Minimum sunlight (%)")} · {search.constraints.min_sun_pct}</li>}
          {search.constraints.min_earth_pct > 0 && <li>{t("Minimum Earth visibility (%)")} · {search.constraints.min_earth_pct}</li>}
          {search.constraints.max_dark_gap_h !== null && <li>{t("Maximum dark gap (h)")} · {search.constraints.max_dark_gap_h}</li>}
          {search.constraints.max_comms_gap_h !== null && <li>{t("Maximum Earth visibility gap (h)")} · {search.constraints.max_comms_gap_h}</li>}
        </ul>}
      {search.candidates.length > 0 && <ol className="interval-list list-decimal space-y-3">
        {search.candidates.map(candidate => {
          const link = candidateLink(candidate, search);
          return <li key={candidate.rank} value={candidate.rank} className="break-inside-avoid">
            <TimeRange start={candidate.landing_utc} end={candidate.mission_end_utc} />
            <p className="muted text-sm">{t("{hours} h after the earliest landing time", { hours: Number(landingDelayHours(candidate.landing_utc, request.earliest).toFixed(6)) })}</p>
            <p>{t("Sun visible")} {candidate.sun_pct}% · {t("Earth visible")} {candidate.earth_pct}% · {t("Both visible")} {candidate.both_pct}%</p>
            {link && <a className="print:hidden" href={link} target="_blank" rel="noreferrer">{t("Inspect this mission window")}</a>}
          </li>;
        })}
      </ol>}
      {Object.values(search.rejected_by).some(count => count > 0) && <details className="mt-3">
        <summary>{t("Why landing times were rejected")}</summary>
        <p className="muted text-sm">{t("One landing time can fail more than one constraint.")}</p>
        <ul>{Object.entries(search.rejected_by).filter(([, count]) => count > 0).map(([reason, count]) =>
          <li key={reason}>{t(rejectionLabels[reason] ?? reason)} · {count}</li>)}</ul>
      </details>}
    </section>}
  </>;
}

export default function AlternativeDates({ result, site }: { result: TerrainSummary; site: TerrainSummary["sites"][number] }) {
  const { t } = useLanguage();
  return <details id="alternative-dates" className="details-section">
    <summary>{t("Find alternative landing dates")}</summary>
    <LandingSearch runId={result.run.run_id} sites={[site]} from={result.range.start} to={result.range.end}
      stepSeconds={result.range.step_s} />
  </details>;
}

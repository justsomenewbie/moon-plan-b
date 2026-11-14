"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { findAltDates, type AltDatesRequest, type AltDatesResponse } from "../lib/api/alt-dates";
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
  // Current pinned single-site viewer accepts hourly runs over at most 366 days.
  if (search.step_s !== 3600 || search.mission_duration_h > 366 * 24) return null;
  return "/compare?" + new URLSearchParams({
    from: candidate.landing_utc, to: candidate.mission_end_utc, resolutionSeconds: String(search.step_s),
    run_id: search.run_id, site_id: search.site_id, view_site: search.site_id,
  }) + "#terrain-observations";
}

export default function AlternativeDates({ result, site }: { result: TerrainSummary; site: TerrainSummary["sites"][number] }) {
  const { t } = useLanguage();
  const { range } = result;
  const stepHours = range.step_s / 3600;
  const duration = Math.min(range.n_samples, Math.max(1, Math.floor(24 / stepHours))) * stepHours;
  const latest = new Date(Date.parse(range.end) - duration * 3600000).toISOString().slice(0, 19);
  const [search, setSearch] = useState<AltDatesResponse>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  function clearSearch() {
    active.current?.abort();
    setSearch(undefined);
    setPending(false);
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearSearch();
    const inputs = new FormData(event.currentTarget);
    const objective = String(inputs.get("objective") ?? "");
    if (!Object.hasOwn(objectives, objective)) {
      setError("Choose valid landing search constraints.");
      return;
    }
    const payload: AltDatesRequest = {
      run_id: result.run.run_id, site_id: site.id,
      earliest: utcInput(inputs.get("earliest")), latest: utcInput(inputs.get("latest")),
      mission_h: Number(inputs.get("missionHours")), max_results: Number(inputs.get("maxResults")),
      constraints: { min_both_pct: Number(inputs.get("minBothPct")), require_sun_at_landing: inputs.has("sunAtLanding"), require_earth_at_landing: inputs.has("earthAtLanding"),
        objective: objective as keyof typeof objectives, min_separation_h: Number(inputs.get("separationHours")) },
    };
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    try {
      const response = await findAltDates(payload, range.step_s, controller.signal, range.start);
      if (!controller.signal.aborted) setSearch(response);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The request could not be completed. Retry or check the connection.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return <details id="alternative-dates" className="details-section">
    <summary>{t("Find alternative landing dates")}</summary>
    <p>{site.name}</p>
    <form className="request-fields my-4 print:hidden" onSubmit={submit} onChange={clearSearch}>
      <label className="field">{t("Earliest landing (UTC, inclusive)")}<input name="earliest" type="datetime-local" step="1" defaultValue={range.start.slice(0, 19)} required /></label>
      <label className="field">{t("Latest landing (UTC, inclusive)")}<input name="latest" type="datetime-local" step="1" defaultValue={latest} required /></label>
      <label className="field">{t("Mission duration (h)")}<input name="missionHours" type="number" min={stepHours} step="any" defaultValue={duration} required /></label>
      <label className="field">{t("Minimum joint visibility (%)")}<input name="minBothPct" type="number" min="0" max="100" step="any" defaultValue="0" required /></label>
      <label className="field">{t("Minimum spacing between proposals (h)")}<input name="separationHours" type="number" min="0" step="any" defaultValue="12" required /></label>
      <label className="field">{t("Maximum proposals")}<input name="maxResults" type="number" min="1" max="50" step="1" defaultValue="5" required /></label>
      <label className="field">{t("Order proposals by")}<select name="objective" defaultValue="earliest">
        {Object.entries(objectives).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
      </select></label>
      <label className="flex items-center gap-2"><input name="sunAtLanding" type="checkbox" defaultChecked />{t("Require sunlight at landing")}</label>
      <label className="flex items-center gap-2"><input name="earthAtLanding" type="checkbox" />{t("Require Earth visibility at landing")}</label>
      <p className="basis-full muted text-sm">{t("Use whole {step} s steps for the mission duration.", { step: range.step_s })}</p>
      <button className="button outline" type="submit" disabled={pending}>{t("Search landing dates")}</button>
    </form>
    {pending && <p role="status">{t("Searching landing dates…")}</p>}
    {error && <p role="alert">{t(error)}</p>}
    {search && <section aria-label={t("Landing search results")}>
      <p role="status">{t("{feasible} of {evaluated} landing times meet the constraints. Showing {count}.", {
        feasible: search.n_feasible, evaluated: search.n_evaluated, count: search.candidates.length,
      })}</p>
      <p className="muted text-sm">{t("Landing search window")} · <TimeRange start={search.earliest_utc} end={search.latest_utc} /><br />
        {t("Mission duration (h)")} · {search.mission_duration_h} · {t("Boundary precision")} ±{search.precision_h} h<br />
        {t("Run ID")} · <code className="break-all">{search.run_id}</code></p>
      <p className="muted text-sm">{t(objectives[search.constraints.objective])} · {t("Minimum joint visibility (%)")} {search.constraints.min_both_pct} · {t("Require sunlight at landing")} {t(search.constraints.require_sun_at_landing ? "Yes" : "No")} · {t("Require Earth visibility at landing")} {t(search.constraints.require_earth_at_landing ? "Yes" : "No")} · {t("Minimum spacing between proposals (h)")} {search.constraints.min_separation_h}</p>
      {search.candidates.length > 0 && <ol className="interval-list list-decimal space-y-3">
        {search.candidates.map(candidate => {
          const link = candidateLink(candidate, search);
          return <li key={candidate.rank} value={candidate.rank} className="break-inside-avoid">
            <TimeRange start={candidate.landing_utc} end={candidate.mission_end_utc} />
            <p className="muted text-sm">{t("{hours} h after the earliest landing time", { hours: candidate.slip_h })}</p>
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
  </details>;
}

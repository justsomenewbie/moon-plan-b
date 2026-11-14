"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { getTerrainDates, type TerrainDateRequest } from "../lib/api/terrain-dates";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import { missionSites } from "../lib/globe-sites";
import { terrainDatesHref } from "../lib/terrain-date-link";
import { useLanguage } from "./language";
import { SiteResult, TimeRange } from "./terrain-site-result";

type Bounds = TerrainDateRequest["first"];
type Props = ({ result: TerrainSummary; baseWindow?: Bounds; initialRequest?: never }
  | { initialRequest: TerrainDateRequest; result?: never; baseWindow?: never })
  & { onCompared?: (request: TerrainDateRequest) => void };

function shiftUtc(value: string, milliseconds: number) {
  const shifted = new Date(Date.parse(value) + milliseconds);
  if (!Number.isFinite(shifted.getTime()) || shifted.getUTCFullYear() > 9999) return "";
  return shifted.toISOString().replace(".000Z", "Z");
}

export default function TerrainDates({ result, baseWindow, initialRequest, onCompared }: Props) {
  const { t } = useLanguage();
  const base = initialRequest?.first ?? baseWindow ?? { from: result!.range.requested_start, to: result!.range.requested_end };
  const [inputs, setInputs] = useState(() => ({
    site: initialRequest?.siteId ?? missionSites[0].id,
    from: base.from.slice(0, -1), to: base.to.slice(0, -1),
    other: (initialRequest?.second.from ?? base.to).slice(0, -1),
  }));
  const [completed, setCompleted] = useState<{ request: TerrainDateRequest; first: TerrainSummary; second: TerrainSummary }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const from = inputs.from + "Z", to = inputs.to + "Z", other = inputs.other + "Z";
  const span = Date.parse(to) - Date.parse(from);
  const otherEnd = span > 0 ? shiftUtc(other, span) : "";
  const stale = completed && (completed.request.siteId !== inputs.site || Date.parse(completed.request.first.from) !== Date.parse(from)
    || Date.parse(completed.request.first.to) !== Date.parse(to) || Date.parse(completed.request.second.from) !== Date.parse(other));

  function edit(key: keyof typeof inputs, value: string) {
    active.current?.abort();
    setPending(false);
    setError("");
    setInputs(previous => ({ ...previous, [key]: value }));
  }

  async function compare(request: TerrainDateRequest) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError("");
    try {
      const pair = await getTerrainDates(request, controller.signal);
      if (!controller.signal.aborted) {
        const pinned = { ...request, runId: pair.first.run.run_id };
        setCompleted({ request: pinned, ...pair });
        onCompared?.(pinned);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The request could not be completed. Retry or check the connection.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  const reopen = useEffectEvent((request: TerrainDateRequest) => { void compare(request); });
  useEffect(() => {
    if (initialRequest) reopen(initialRequest);
    return () => active.current?.abort();
  }, [initialRequest]);

  return <section id="terrain-dates" aria-label={t("Compare dates")} tabIndex={-1}>
    <details className="details-section" open={initialRequest ? true : undefined}>
      <summary>{t("Compare dates")}</summary>
      <form className="request-fields my-4 print:hidden" onSubmit={event => {
        event.preventDefault();
        if (!otherEnd) { setError("Choose valid UTC bounds for both windows."); return; }
        void compare({
          siteId: inputs.site, runId: initialRequest?.runId ?? result?.run.run_id,
          first: { from: shiftUtc(from, 0), to: shiftUtc(to, 0) },
          second: { from: shiftUtc(other, 0), to: otherEnd },
        });
      }}>
        <label className="field">{t("First start (UTC)")}<input name="firstStart" type="datetime-local" step="any" required value={inputs.from} onChange={e => edit("from", e.target.value)} /></label>
        <label className="field">{t("First end (UTC, exclusive)")}<input name="firstEnd" type="datetime-local" step="any" required value={inputs.to} onChange={e => edit("to", e.target.value)} /></label>
        <label className="field">{t("Second start (UTC)")}<input name="secondStart" type="datetime-local" step="any" required value={inputs.other} onChange={e => edit("other", e.target.value)} /></label>
        <label className="field">{t("Second end (UTC, exclusive)")}<input name="secondEnd" type="datetime-local" step="any" readOnly value={otherEnd.slice(0, -1)} /></label>
        <label className="field">{t("Site")}<select name="dateSite" value={inputs.site} onChange={e => edit("site", e.target.value)}>
          {missionSites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select></label>
        <button className="button outline" disabled={pending}>{t("Compare these dates")}</button>
      </form>
      {Number.isFinite(span) && span > 0 && <p className="muted text-sm print:hidden">{t("Duration")} · {span / 3600000} h</p>}
      {pending && <p role="status">{t("Loading dataset…")}</p>}
      {error && <p role="alert">{t(error)}</p>}
      {completed && <>
        {stale && <p className="data-notice" role="status">{t("Showing the previous comparison. Submit the edited dates to update the results.")}</p>}
        <p className="muted text-sm">{t("Model")} · {completed.first.model.label}<br />
          {t("Run ID")} · <code className="break-all">{completed.first.run.run_id}</code></p>
        <p className="muted text-sm">{completed.first.attribution}</p>
        <div className="week-sites">{(["first", "second"] as const).map(key => {
          const response = completed[key], request = completed.request[key];
          const adjusted = Date.parse(request.from) !== Date.parse(response.range.requested_start) || Date.parse(request.to) !== Date.parse(response.range.requested_end);
          return <section key={key} className="min-w-0">
            <h3>{t(key === "first" ? "First window" : "Second window")}</h3>
            <p className="text-sm">{t("Requested UTC range")} · <TimeRange start={request.from} end={request.to} /></p>
            {adjusted && <p className="muted text-sm">{t("Requested UTC range on the model grid")} · <TimeRange start={response.range.requested_start} end={response.range.requested_end} /></p>}
            <p className="muted text-sm">{t("Evaluated UTC range")} · <TimeRange start={response.range.start} end={response.range.end} /></p>
            <p className="muted text-sm">{t("Times use an exclusive end. The model evaluated {count} samples at {step} s intervals.", { count: response.range.n_samples, step: response.range.step_s })}</p>
            <SiteResult site={response.sites[0]} />
          </section>;
        })}</div>
        <a className="print:hidden" href={terrainDatesHref(completed.request)} target="_blank" rel="noreferrer">{t("Open date comparison in a new tab")}</a>
      </>}
    </details>
  </section>;
}

import { ApiProblemText } from "./api-problem-text";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { getSiteInstant, type SiteInstant } from "../lib/api/site-instant";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import { useLanguage } from "./language";

type Lookup = { status: "idle" | "pending" } | { status: "error"; message: Error | string } | { status: "ready"; value: SiteInstant };

export default function TerrainInstant({ runId, site, range, initialUtc }: {
  runId: string; site: TerrainSummary["sites"][number]; range: TerrainSummary["range"]; initialUtc: string;
}) {
  const { t, locale } = useLanguage();
  const [lookup, setLookup] = useState<Lookup>({ status: "idle" });
  const active = useRef<AbortController | null>(null);
  const timeInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => active.current?.abort(), []);
  function clear() {
    active.current?.abort();
    setLookup({ status: "idle" });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = String(new FormData(event.currentTarget).get("instantUtc") ?? "");
    const at = Date.parse(input + "Z");
    if (!Number.isFinite(at) || at < Date.parse(range.start) || at >= Date.parse(range.end)) {
      clear();
      setLookup({ status: "error", message: "Choose a time within the evaluated UTC range, before its end." });
      return;
    }
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLookup({ status: "pending" });
    try {
      const value = await getSiteInstant(runId, site.id, input, range.step_s, range.start, controller.signal, site.series);
      if (!controller.signal.aborted) setLookup({ status: "ready", value });
    } catch (error) {
      if (!controller.signal.aborted) setLookup({ status: "error", message: error instanceof Error ? error : "The request could not be completed. Retry or check the connection." });
    }
  }
  const value = lookup.status === "ready" ? lookup.value : null;
  return <details className="details-section">
    <summary onClick={() => {
      if (!timeInput.current) return;
      if (timeInput.current.closest("details")?.open) clear();
      else timeInput.current.value = initialUtc.slice(0, 19);
    }}>{t("Look up a UTC instant")}</summary>
    <form className="request-fields my-4 print:hidden" onSubmit={submit}>
      <label className="field">{t("Requested time (UTC)")}
        <input ref={timeInput} name="instantUtc" type="datetime-local" step="1" required onChange={clear}
          defaultValue={initialUtc.slice(0, 19)} min={range.start.slice(0, 19)}
          max={new Date(Date.parse(range.end) - 1000).toISOString().slice(0, 19)} /></label>
      <button className="button outline" type="submit" disabled={lookup.status === "pending"}>
        {t(lookup.status === "error" ? "Retry observation lookup" : "Look up observation")}</button>
    </form>
    {lookup.status === "pending" && <p role="status">{t("Loading observation…")}</p>}
    {lookup.status === "error" && <p role="alert"><ApiProblemText error={lookup.message} /></p>}
    {value && <section aria-labelledby="instant-heading">
      <h4 id="instant-heading">{t("Observation at the requested time")}</h4>
      <p>{site.name}</p>
      <dl className="metadata">
        <div><dt>{t("Run ID")}</dt><dd className="break-all">{value.run_id}</dd></div>
        <div><dt>{t("Requested time (UTC)")}</dt><dd><time dateTime={value.t}>{value.t}</time></dd></div>
        <div><dt>{t("Model sample (UTC)")}</dt><dd><time dateTime={value.sample_utc}>{value.sample_utc}</time></dd></div>
      </dl>
      <p className="muted text-sm">{t("Angles and visibility come from the model sample. Each sample covers {step} seconds.", { step: value.step_s })}</p>
      <div className="week-sites">{(["sun", "earth"] as const).map(body => <div key={body}>
        <h5>{t(body === "sun" ? "Sun" : "Earth")}</h5>
        <dl className="metadata">
          <div><dt>{t("Azimuth")}</dt><dd>{value[body].az_deg}°</dd></div>
          <div><dt>{t("Elevation angle")}</dt><dd>{value[body].el_deg}°</dd></div>
          <div><dt>{t("Horizon elevation at this azimuth")}</dt><dd>{value[body].horizon_el_deg}°</dd></div>
          <div><dt>{t("Body centre above horizon")}</dt><dd>{value[body].clearance_deg}°</dd></div>
          <div><dt>{t("Visibility")}</dt><dd>{t(value[body].visible ? "Visible" : "Hidden")}</dd></div>
          {body === "sun" && value.sun.fraction !== undefined && <div><dt>{t("Visible share of the solar disc")}</dt>
            <dd>{value.sun.fraction.toLocaleString(locale, { style: "percent", maximumFractionDigits: 4 })}</dd></div>}
          {body === "sun" && value.sun.irradiance_tracking_wm2 !== undefined && <div><dt>{t("Modeled irradiance on a Sun-facing surface")}</dt>
            <dd>{value.sun.irradiance_tracking_wm2.toLocaleString(locale, { maximumFractionDigits: 3 })} W/m²</dd></div>}
        </dl>
        {body === "earth" && <p className="muted text-sm">{t("Earth visibility describes a line of sight. Radio signal strength is unavailable.")}</p>}
      </div>)}</div>
      {value.sun.visible && value.sun.clearance_deg < 0 && <p>{t("Part of the Sun is visible while its centre is below the local horizon.")}</p>}
      <p>{t("Both visible")} · {t(value.both_visible ? "Yes" : "No")}</p>
    </section>}
  </details>;
}

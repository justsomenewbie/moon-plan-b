import { ApiProblemText } from "./api-problem-text";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { getSiteInstant, type SiteInstant } from "../lib/api/site-instant";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import { instantEventText } from "../lib/instant-events";
import { useLanguage } from "./language";

// Sector boundaries follow the producer's clockwise 16-point compass.
const headings = [
  "north", "north-northeast", "northeast", "east-northeast", "east", "east-southeast", "southeast", "south-southeast",
  "south", "south-southwest", "southwest", "west-southwest", "west", "west-northwest", "northwest", "north-northwest",
] as const;

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
  const angles = new Intl.NumberFormat(locale, { maximumSignificantDigits: 21, useGrouping: false });
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
      <p className="muted text-sm">{t("Azimuth tells you which way to look: 0° is north, 90° is east. Elevation is the angle above the horizontal. A negative value points below it.")}</p>
      <div className="week-sites instant-bodies">{(["sun", "earth"] as const).map(body => <div key={body}>
        <h5>{t(body === "sun" ? "Sun" : "Earth")}</h5>
        <p className="instant-bearing">
          <svg aria-hidden="true" viewBox="0 0 36 36" width="36" height="36">
            <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" opacity=".5" />
            <path d="M18 2v4" stroke="currentColor" strokeWidth="2" />
            <path d="M18 8l4 7-3 -1v12h-2V14l-3 1z" fill="currentColor" transform={`rotate(${value[body].az_deg} 18 18)`} />
          </svg>
          <span>{t("Direction from the site")} · <strong>{t(headings[Math.round(value[body].az_deg / 22.5) % 16])}</strong>
            {` (${value[body].az_deg.toLocaleString(locale, { maximumFractionDigits: 2 })}°)`}
          </span>
        </p>
        {body === "sun" &&
          <fieldset className="panel-sunlight">
            <legend>{t("Relative sunlight on two panel orientations")}</legend>
            {(value.sun.power_horizontal !== undefined || value.sun.power_tracking !== undefined) &&
              <p>{t("100% is the sunlight reaching an unobstructed panel facing the Sun at this time.")}</p>}
            {([["power_horizontal", "Horizontal panel"], ["power_tracking", "Sun-facing panel"]] as const).map(([field, title]) => {
              const fraction = value.sun[field];
              if (fraction === undefined) return <p className="panel-missing" key={field}>{t(title)} · {t("No data for this sample")}</p>;
              const percent = fraction.toLocaleString(locale, { style: "percent", maximumFractionDigits: 2 });
              return <label key={field}>
                <span>{t(title)}</span><strong aria-hidden="true">{percent}</strong>
                <meter min={0} max={1} value={fraction} aria-label={t(title)} aria-valuetext={percent}>{percent}</meter>
              </label>;
            })}
          </fieldset>}
        {body === "earth" && <p className="muted text-sm">{t("Earthrise and Earthset track the centre crossing the clearance threshold. Radio signal strength is unavailable.")}</p>}
        <dl className="metadata">
          <div><dt>{t("Azimuth")}</dt><dd>{angles.format(value[body].az_deg)}°</dd></div>
          <div><dt>{t("Elevation angle")}</dt><dd>{angles.format(value[body].el_deg)}°</dd></div>
          <div><dt>{t("Horizon elevation at this azimuth")}</dt><dd>{angles.format(value[body].horizon_el_deg)}°</dd></div>
          <div><dt>{t("Body centre above horizon")}</dt><dd>{angles.format(value[body].clearance_deg)}°</dd></div>
          {body === "earth" ? <>
            <div><dt>{t("Earth’s centre exceeds the run’s clearance threshold")}</dt><dd>{t(value.earth.visible ? "Yes" : "No")}</dd></div>
            {value.earth.fraction !== undefined && <div><dt>{t("Share of Earth’s disc above the local horizon")}</dt>
              <dd>{value.earth.fraction.toLocaleString(locale, { style: "percent", maximumFractionDigits: 4 })}</dd></div>}
          </> : <div><dt>{t("Visibility")}</dt><dd>{t(value.sun.visible ? "Visible" : "Hidden")}</dd></div>}
          {(body === "sun" ? ["sunset", "sunrise"] as const : ["earthset", "earthrise"] as const).map(key => {
            const { label, text, at } = instantEventText(locale, key, value);
            return <div key={key}><dt>{label}</dt><dd>{text}{at && <> · <time dateTime={at}>{at}</time></>}</dd></div>;
          })}
          {body === "sun" && value.sun.fraction !== undefined && <div><dt>{t("Visible share of the solar disc")}</dt>
            <dd>{value.sun.fraction.toLocaleString(locale, { style: "percent", maximumFractionDigits: 4 })}</dd></div>}
          {body === "sun" && value.sun.irradiance_tracking_wm2 !== undefined && <div><dt>{t("Modeled irradiance on a Sun-facing surface")}</dt>
            <dd>{value.sun.irradiance_tracking_wm2.toLocaleString(locale, { maximumFractionDigits: 3 })} W/m²</dd></div>}
        </dl>
      </div>)}</div>
      {value.sun.visible && value.sun.clearance_deg < 0 && <p>{t("Part of the Sun is visible while its centre is below the local horizon.")}</p>}
      <p>{t("Both visible")} · {t(value.both_visible ? "Yes" : "No")}</p>
    </section>}
  </details>;
}

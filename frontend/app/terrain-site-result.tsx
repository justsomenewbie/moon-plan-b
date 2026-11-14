import type { TerrainSummary } from "../lib/api/terrain-summary";
import type { operations } from "../lib/api/producer";
import { useLanguage } from "./language";

function UtcTime({ value }: { value: string }) {
  return <time dateTime={value}>{value.replace("T", " ").replace(/Z$/, " UTC")}</time>;
}

export function TimeRange({ start, end }: { start: string; end: string }) {
  return <><UtcTime value={start} /> → <UtcTime value={end} /></>;
}

const criterionLabels = {
  meets: "Meets the criterion", below: "Below the criterion", borderline: "Near the threshold",
};

type ExportRange = Pick<TerrainSummary["range"], "start" | "end">;

export function SiteSourceLinks({ siteId, runId, range }: { siteId: string; runId: string; range: ExportRange }) {
  const { t } = useLanguage();
  const bounds = { run_id: runId, start: range.start, end: range.end };
  const series = {
    ...bounds, fields: "sun_az_deg,sun_el_deg,sun_visible,earth_az_deg,earth_el_deg,earth_visible,both_visible",
  } satisfies NonNullable<operations["exportSiteSeriesCsv"]["parameters"]["query"]>;
  const windows = { ...bounds, kinds: "sun,earth,both" } satisfies NonNullable<operations["exportSiteWindowsCsv"]["parameters"]["query"]>;
  if (siteId === "." || siteId === "..") return null;
  const path = "/api/v1/sites/" + encodeURIComponent(siteId);
  const siteQuery = { run_id: runId } satisfies NonNullable<operations["getSite"]["parameters"]["query"]>;
  return <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 print:hidden">
    <a href={path + "?" + new URLSearchParams(siteQuery)}
      target="_blank" rel="noreferrer">{t("Open site record (full run, JSON)")}</a>
    <a href={path + "/export/series.csv?" + new URLSearchParams(series)} target="_blank" rel="noreferrer">{t("Download observations (CSV)")}</a>
    <a href={path + "/export/windows.csv?" + new URLSearchParams(windows)} target="_blank" rel="noreferrer">{t("Download visibility windows (CSV)")}</a>
  </div>;
}

export function RunSourceLinks({ run }: { run: TerrainSummary["run"] }) {
  const { t } = useLanguage();
  if (run.run_id === "." || run.run_id === "..") return null;
  const runPath = "/api/v1/runs/" + encodeURIComponent(run.run_id);
  return <div className="flex flex-wrap gap-x-4 gap-y-1 print:hidden">
    <a href={runPath} target="_blank" rel="noreferrer">{t("Open run details (JSON)")}</a>
    {run.manifest_url === runPath + "/files/manifest.json" &&
      <a href={run.manifest_url} target="_blank" rel="noreferrer">{t("Download run manifest (JSON)")}</a>}
  </div>;
}

export function SiteHorizonSource({ method, source }: { method: string; source: string }) {
  const { t } = useLanguage();
  return <p className="muted text-sm break-words">{t("Site horizon method")} · {method}<br />
    {t("Terrain elevation model")} · {source}
    {source.startsWith("none:outside-") && <><br />{t("Outside elevation-map coverage. This site uses a smooth-sphere horizon and omits local terrain shadows.")}</>}
  </p>;
}

export function SiteResult({ site, source, liveResult }: {
  source: Pick<TerrainSummary, "run" | "conventions">;
  site: TerrainSummary["sites"][number];
  liveResult?: Pick<TerrainSummary, "run" | "range">;
}) {
  const { t } = useLanguage();
  const complete = site.coverage_in_range === "complete";
  const metrics = complete ? site.metrics : null;
  const intervals = site.windows.both;
  const criteria = site.criteria;
  return <article className="min-w-0">
    <h3>{site.name}</h3>
    <p className="muted text-sm">{t("Requested coverage")} · {t(site.coverage)}<br />
      {t("Evaluated coverage")} · {t(site.coverage_in_range)}</p>
    {(site.lat_deg !== null || site.lon_deg !== null || site.surface_height_m !== null) && <details className="my-2">
      <summary>{t("Site location")}</summary>
      <dl className="metadata">
        {site.lat_deg !== null && <div><dt>{t("Planetocentric latitude")}</dt><dd>{site.lat_deg}°</dd></div>}
        {site.lon_deg !== null && <div><dt>{t("East longitude")}</dt><dd>{site.lon_deg}°</dd></div>}
        {site.surface_height_m !== null && <div><dt>{t("Model surface height")}</dt><dd>{site.surface_height_m} m</dd></div>}
        <div><dt>{t("Observer height above surface")}</dt><dd>{source.run.observer_height_m} m</dd></div>
      </dl>
      {source.conventions.longitude && <p className="muted text-sm">{source.conventions.longitude}</p>}
      {source.conventions.latitude && <p className="muted text-sm">{source.conventions.latitude}</p>}
      {source.conventions.height && <p className="muted text-sm">{source.conventions.height}</p>}
    </details>}
    {site.horizon && <SiteHorizonSource method={site.horizon.method} source={site.horizon.dem_source} />}
    {metrics ? <dl className="metadata mt-4">
      <div><dt>{t("Total time with both visible")}</dt><dd><strong>{metrics.both_hours} h</strong> / {metrics.duration_h} h</dd></div>
      <div><dt>{t("Longest joint window")}</dt><dd>{metrics.longest_both_h} h</dd></div>
      <div><dt>{t("Sun visible")}</dt><dd>{metrics.sun_hours} h</dd></div>
      <div><dt>{t("Earth visible")}</dt><dd>{metrics.earth_hours} h</dd></div>
    </dl> : <p className="data-notice my-4">{t("Coverage is incomplete. The total and longest overlap for the evaluated range are unknown.")}</p>}
    {criteria && criteria.length > 0 && <section className="my-4" aria-label={t("Continuous Sun and Earth visibility requirements")}>
      <h4 className="font-semibold">{t("Continuous Sun and Earth visibility requirements")}</h4>
      <p className="muted text-sm">{t(complete ? "Longest overlap in the evaluated range: {hours} h" : "Longest observed overlap: {hours} h", { hours: criteria[0].value_h })}</p>
      {criteria[0].value_clipped && <p className="muted text-sm">{t("A boundary clips the longest overlap. It may continue outside the evaluated range.")}</p>}
      <ul className="mt-2">{criteria.map(criterion => <li key={criterion.minimum_hours} className="break-inside-avoid">
        <details><summary>{t("At least {hours} h", { hours: criterion.minimum_hours })} · {complete || criterion.result === "meets" ? <span className={criterion.result}>{t(criterionLabels[criterion.result])}</span> : t("Unknown across observation gaps")}</summary>
          <p className="muted text-sm">{!complete && <strong>{t("Assessment of the observed intervals")} · </strong>}{criterion.reason}</p>
        </details>
      </li>)}</ul>
    </section>}
    <h4 className="font-semibold">{t("Sun and Earth overlap intervals")}</h4>
    {intervals.length ? <ol className="interval-list list-decimal space-y-2">
      {intervals.map(window => <li key={window.start} className="break-inside-avoid">
        <TimeRange start={window.start} end={window.end} /> · <b>{window.duration_h} h</b>
        {window.clipped_start && <p className="muted">{t("Start clipped. The overlap may have begun earlier.")}</p>}
        {window.clipped_end && <p className="muted">{t("End clipped. The overlap may have continued later.")}</p>}
      </li>)}
    </ol> : <p className="muted">{t(complete ? "No simultaneous visibility in the evaluated range." : "No overlap intervals were supplied for the available coverage.")}</p>}
    {liveResult && <SiteSourceLinks siteId={site.id} runId={liveResult.run.run_id} range={liveResult.range} />}
  </article>;
}

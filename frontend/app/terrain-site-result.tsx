import type { TerrainSummary } from "../lib/api/terrain-summary";
import { useLanguage } from "./language";

function UtcTime({ value }: { value: string }) {
  return <time dateTime={value}>{value.replace("T", " ").replace(/Z$/, " UTC")}</time>;
}

export function TimeRange({ start, end }: { start: string; end: string }) {
  return <><UtcTime value={start} /> → <UtcTime value={end} /></>;
}

export function SiteResult({ site }: { site: TerrainSummary["sites"][number] }) {
  const { t } = useLanguage();
  const complete = site.coverage_in_range === "complete";
  const metrics = complete ? site.metrics : null;
  const intervals = site.windows.both;
  return <article className="min-w-0">
    <h3>{site.name}</h3>
    <p className="muted text-sm">{t("Requested coverage")} · {t(site.coverage)}<br />
      {t("Evaluated coverage")} · {t(site.coverage_in_range)}</p>
    {metrics ? <dl className="metadata mt-4">
      <div><dt>{t("Total time with both visible")}</dt><dd><strong>{metrics.both_hours} h</strong> / {metrics.duration_h} h</dd></div>
      <div><dt>{t("Longest joint window")}</dt><dd>{metrics.longest_both_h} h</dd></div>
      <div><dt>{t("Sun visible")}</dt><dd>{metrics.sun_hours} h</dd></div>
      <div><dt>{t("Earth visible")}</dt><dd>{metrics.earth_hours} h</dd></div>
    </dl> : <p className="data-notice my-4">{t("Coverage is incomplete. The total and longest overlap for the evaluated range are unknown.")}</p>}
    <h4 className="font-semibold">{t("Sun and Earth overlap intervals")}</h4>
    {intervals.length ? <ol className="interval-list list-decimal space-y-2">
      {intervals.map(window => <li key={window.start} className="break-inside-avoid">
        <TimeRange start={window.start} end={window.end} /> · <b>{window.duration_h} h</b>
        {window.clipped_start && <p className="muted">{t("Start clipped. The overlap may have begun earlier.")}</p>}
        {window.clipped_end && <p className="muted">{t("End clipped. The overlap may have continued later.")}</p>}
      </li>)}
    </ol> : <p className="muted">{t(complete ? "No simultaneous visibility in the evaluated range." : "No overlap intervals were supplied for the available coverage.")}</p>}
  </article>;
}

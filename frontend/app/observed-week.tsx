import week from "../lib/odysseus-athena-week.json";
import { useLanguage } from "./language";
import { formatUtc } from "./observations";

export default function ObservedWeek() {
  const { t, locale } = useLanguage();
  const start = Date.parse(week.startUtc);
  const span = Date.parse(week.endUtc) - start;

  return <section id="observed-week" className="observed-week" aria-labelledby="observed-week-title" tabIndex={-1}>
    <h2 id="observed-week-title">{t("Odysseus and Athena · Sun and Earth visibility")}</h2>
    <p className="muted">{t("Saved team model results")} · <time dateTime={week.startUtc}>{formatUtc(week.startUtc, locale)}</time> → <time dateTime={week.endUtc}>{formatUtc(week.endUtc, locale)}</time> · {t("Interval boundaries ±{hours} h", { hours: week.precisionHours })}</p>
    <div className="week-sites">{week.sites.map(site => {
      const interval = site.overlap;
      const left = 100 * (Date.parse(interval.start) - start) / span;
      const width = 100 * (Date.parse(interval.end) - Date.parse(interval.start)) / span;
      return <article key={site.id}>
        <h3>{site.name}</h3>
        <p><strong className="week-hours">{interval.duration_h} h</strong> {t("with both visible")}</p>
        <div className="week-track" aria-hidden="true"><span style={{ left: `${left}%`, width: `${width}%` }} /></div>
        <p><time dateTime={interval.start}>{formatUtc(interval.start, locale)}</time> → <time dateTime={interval.end}>{formatUtc(interval.end, locale)}</time></p>
        <p className="muted">{t("Sun visible")} · {site.sunHours} h · {t("Earth visible")} · {site.earthHours} h</p>
      </article>;
    })}</div>
    <details>
      <summary>{t("How the team obtained these hours")}</summary>
      <p>{t("Each site has one continuous overlap in the selected week. Both intervals reach the end of the query. Their full durations beyond that boundary are unknown.")}</p>
      <p>{t("The team sampled once per hour with SPICE and a PGDA terrain horizon for an observer 2 m above the surface. Sun visibility uses the upper limb. Earth visibility uses clearance above the local horizon.")}</p>
      <p>{t("Source run")} · <code>{week.runId}</code> · <a href="https://github.com/justsomenewbie/moon-plan-b/blob/8fe8f4d25cfc0fc0d799c1e70f16199012f2cebb/docs/BACKEND_RECONCILIATION.md#reproduce-the-odysseus-and-athena-week" target="_blank" rel="noreferrer">{t("Source and interval checks")} ↗</a></p>
    </details>
  </section>;
}

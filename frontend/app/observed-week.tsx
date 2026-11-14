import snapshot from "../lib/odysseus-athena-weeks.json";
import { useLanguage } from "./language";
import { formatUtc } from "./observations";

const { weeks, precisionHours, runId } = snapshot;
const savedChoices: string[] = [...weeks.map(week => week.startUtc), ...weeks[0].sites.map(site => site.id)];
export function savedResultFromUrl(params: URLSearchParams) {
  const [value, duplicate] = params.getAll("saved");
  return duplicate === undefined && savedChoices.includes(value) ? value : weeks[0].startUtc;
}

function weekLabel(week: typeof weeks[number]) {
  // The exclusive midnight endpoint belongs to the following week.
  const lastDay = new Date(Date.parse(week.endUtc) - 1).toISOString().slice(0, 10);
  return `${week.startUtc.slice(0, 10)} → ${lastDay} UTC`;
}

export default function ObservedWeek({ selection, onSelect, onPrint }: { selection: string; onSelect: (value: string) => void; onPrint: () => void }) {
  const { t, locale } = useLanguage();
  const selectedWeek = weeks.find(week => week.startUtc === selection);

  return <section id="observed-week" className="observed-week saved-comparison" aria-labelledby="observed-week-title" tabIndex={-1}>
    <div>
      <h2 id="observed-week-title">{t("Odysseus and Athena · Sun and Earth visibility")}</h2>
      <p className="muted">{t("Saved team model results")} · {t("Interval boundaries ±{hours} h", { hours: precisionHours })}</p>
      <label className="field week-selection">{t("Compare saved results")}
        <select value={selection} onChange={event => onSelect(event.target.value)}>
          <optgroup label={t("Two sites in one week")}>{weeks.map(week =>
            <option key={week.startUtc} value={week.startUtc}>{weekLabel(week)}</option>)}</optgroup>
          <optgroup label={t("Two weeks at one site")}>{weeks[0].sites.map(site =>
            <option key={site.id} value={site.id}>{site.name}</option>)}</optgroup>
        </select>
      </label>
      <div className="week-actions">
        <button className="button outline" type="button" onClick={onPrint}>{t("Print saved result")}</button>
        <a href="#lunar-reference">{t("View lunar globe")}</a>
        <a href={`?saved=${encodeURIComponent(selection)}#observed-week`} target="_blank" rel="noreferrer">{t("Open this saved result in a new tab")} ↗</a>
      </div>
      <div className="week-sites" aria-live="polite">
        {(selectedWeek ? [selectedWeek] : weeks).map(week => week.sites.filter(site => selectedWeek || site.id === selection).map(site => {
          const interval = site.overlap;
          const start = Date.parse(week.startUtc);
          const span = Date.parse(week.endUtc) - start;
          const left = 100 * (Date.parse(interval.start) - start) / span;
          const width = 100 * (Date.parse(interval.end) - Date.parse(interval.start)) / span;
          return <article key={week.startUtc + site.id}>
            <h3>{selectedWeek ? site.name : weekLabel(week)}</h3>
            <p className="muted">{selectedWeek ? weekLabel(week) : site.name}</p>
            <p><strong className="week-hours">{interval.duration_h} h</strong> {t("with both visible")}</p>
            <div className="week-track" aria-hidden="true"><span style={{ left: `${left}%`, width: `${width}%` }} /></div>
            <p><time dateTime={interval.start}>{formatUtc(interval.start, locale)}</time> → <time dateTime={interval.end}>{formatUtc(interval.end, locale)}</time></p>
            <p className="muted">{t("Sun visible")} · {site.sunHours} h · {t("Earth visible")} · {site.earthHours} h</p>
            <p className="muted text-sm">{t(interval.clipped_start ? "Visible throughout the queried week." : "Still visible at the end of the queried week.")}</p>
          </article>;
        }))}
      </div>
      <details id="saved-model-source">
        <summary>{t("How the team obtained these hours")}</summary>
        <p>{t("Each site has one continuous overlap per week. The total shown is also the longest overlap inside that week. The bars share a scale of 168 hours from the start of each week.")}</p>
        <p>{t("The team sampled once per hour with SPICE and a PGDA terrain horizon for an observer 2 m above the surface. Sun visibility uses the upper limb. Earth visibility uses clearance above the local horizon.")}</p>
        <p>{t("Source run")} · <code>{runId}</code> · <a href="https://github.com/justsomenewbie/moon-plan-b/blob/953a39cf1b5ac7e8b61d82d6b0dc5bc0469807f1/docs/BACKEND_RECONCILIATION.md#reproduce-the-odysseus-and-athena-weeks" target="_blank" rel="noreferrer">{t("Source and interval checks")} ↗</a></p>
      </details>
    </div>
  </section>;
}

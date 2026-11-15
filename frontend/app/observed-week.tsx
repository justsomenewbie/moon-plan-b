import { useEffect, useRef } from "react";
import snapshot from "../lib/odysseus-athena-weeks.json";
import { useLanguage } from "./language";
import { formatUtc } from "./observations";

const { weeks, precisionHours, runId } = snapshot;
const savedChoices: string[] = [...weeks.map(week => week.startUtc), ...weeks[0].sites.map(site => site.id)];
export function savedResultFromUrl(params: URLSearchParams) {
  const [value, duplicate] = params.getAll("saved");
  return duplicate === undefined && savedChoices.includes(value) ? value : weeks[0].startUtc;
}

export function isSavedResultLink({ hash, search }: Pick<Location, "hash" | "search">) {
  if (hash === "#observed-week" || hash === "#saved-model-source") return true;
  const params = new URLSearchParams(search);
  const [value, duplicate] = params.getAll("saved");
  const validSaved = duplicate === undefined && savedChoices.includes(value);
  return validSaved && ((!hash && params.size === 1) || hash === "#lunar-reference");
}

function weekLabel(week: typeof weeks[number]) {
  // The exclusive midnight endpoint belongs to the following week.
  const lastDay = new Date(Date.parse(week.endUtc) - 1).toISOString().slice(0, 10);
  return `${week.startUtc.slice(0, 10)} → ${lastDay} UTC`;
}

function savedComparisonRows(selection: string) {
  const selectedWeek = weeks.find(week => week.startUtc === selection);
  const readings = (selectedWeek ? [selectedWeek] : weeks).flatMap(week =>
    week.sites.filter(site => selectedWeek || site.id === selection).map(site => ({ site, week })));
  return { selectedWeek, readings };
}

function SavedResultSelect({ selection, onSelect }: { selection: string; onSelect: (value: string) => void }) {
  const { t, ready } = useLanguage();
  return <label className="field week-selection">{t("Compare saved results")}
    <select disabled={!ready} value={selection} onChange={event => onSelect(event.target.value)}>
      <optgroup label={t("Two sites in one week")}>{weeks.map(week =>
        <option key={week.startUtc} value={week.startUtc}>{weekLabel(week)}</option>)}</optgroup>
      <optgroup label={t("Two weeks at one site")}>{weeks[0].sites.map(site =>
        <option key={site.id} value={site.id}>{site.name}</option>)}</optgroup>
    </select>
  </label>;
}

function WeekTrack({ week, site }: { week: typeof weeks[number]; site: typeof weeks[number]["sites"][number] }) {
  const start = Date.parse(week.startUtc);
  const span = Date.parse(week.endUtc) - start;
  const left = 100 * (Date.parse(site.overlap.start) - start) / span;
  const width = 100 * (Date.parse(site.overlap.end) - Date.parse(site.overlap.start)) / span;
  return <div className="week-track" aria-hidden="true"><span style={{ left: `${left}%`, width: `${width}%` }} /></div>;
}

export function ComparisonExample({ selection, onSelect, comparisonPath }: {
  selection: string; onSelect: (value: string) => void; comparisonPath: string;
}) {
  const { t } = useLanguage();
  const { selectedWeek, readings } = savedComparisonRows(selection);

  return <section className="home-comparison-example" aria-labelledby="comparison-example-title">
    <h3 id="comparison-example-title">{t("How do I compare two sites or two weeks?")}</h3>
    <p>{t("Choose a week to compare two sites. Choose a site to compare two weeks there.")}</p>
    <SavedResultSelect selection={selection} onSelect={onSelect} />
    <p>{t("Each bar spans one week. The colored part shows when both the Sun and Earth are visible from the site.")}</p>
    <ul aria-live="polite" aria-atomic="true">
      {readings.map(({ week, site }) => {
        const totalHours = (Date.parse(week.endUtc) - Date.parse(week.startUtc)) / 3600000;
        return <li key={week.startUtc + site.id}>
          <span>{selectedWeek ? site.name : weekLabel(week)}</span>
          <strong>{t("{hours} of {total} h", { hours: site.overlap.duration_h, total: totalHours })}</strong>
          <WeekTrack week={week} site={site} />
        </li>;
      })}
    </ul>
    <small>{t("Earlier model · run B")}</small>
    <a href={comparisonPath + "#observed-week"}>{t("Open this comparison")}</a>
  </section>;
}

export default function ObservedWeek({ selection, onSelect, onPrint, children }: { selection: string; onSelect: (value: string) => void; onPrint: () => void; children: React.ReactNode }) {
  const { t, locale } = useLanguage();
  const { selectedWeek, readings } = savedComparisonRows(selection);
  const sourceDetails = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function revealLinkedSource() {
      if (window.location.hash === "#saved-model-source" && sourceDetails.current) {
        sourceDetails.current.open = true;
      }
    }
    revealLinkedSource();
    window.addEventListener("hashchange", revealLinkedSource);
    return () => window.removeEventListener("hashchange", revealLinkedSource);
  }, []);

  return <section id="observed-week" className="observed-week saved-comparison" aria-labelledby="observed-week-title" tabIndex={-1}>
    <div>
      <h2 id="observed-week-title">{t("Odysseus and Athena · Sun and Earth visibility")}</h2>
      <p>{t("Imagine standing at the landing site. The hours below count the time when you could see both the Sun and Earth above the local terrain.")}</p>
      <p className="muted">{t("Earlier model · run B")} · {t("Start and end times are approximate (±{hours} h).", { hours: precisionHours })}</p>
      <SavedResultSelect selection={selection} onSelect={onSelect} />
      <p className="week-reading" aria-live="polite" aria-atomic="true">{selectedWeek
        ? t("In this week, both are visible for {firstHours} h at {firstSite} and {secondHours} h at {secondSite}.", {
            firstSite: readings[0].site.name, firstHours: readings[0].site.overlap.duration_h,
            secondSite: readings[1].site.name, secondHours: readings[1].site.overlap.duration_h })
        : t("At {site}, both are visible for {firstHours} h in the first week shown and {secondHours} h in the second.", {
            site: readings[0].site.name, firstHours: readings[0].site.overlap.duration_h, secondHours: readings[1].site.overlap.duration_h })}</p>
      <div className="week-actions">
        <button className="button outline" type="button" onClick={onPrint}>{t("Print saved result")}</button>
        <a href="#lunar-reference">{t("View lunar globe")}</a>
        <a href={`?saved=${encodeURIComponent(selection)}#observed-week`} target="_blank" rel="noreferrer">{t("Open this saved result in a new tab")} ↗</a>
      </div>
      <div className="week-sites">
        {readings.map(({ week, site }) => {
          const interval = site.overlap;
          return <article key={week.startUtc + site.id}>
            <h3>{selectedWeek ? site.name : weekLabel(week)}</h3>
            <p className="muted">{selectedWeek ? weekLabel(week) : site.name}</p>
            <p>{t("Time with both the Sun and Earth in view")}<br /><strong className="week-hours"><span className="run-tag">{t("Run B (archive)")} · </span>{interval.duration_h} h</strong></p>
            <WeekTrack week={week} site={site} />
            <p><time dateTime={interval.start}>{formatUtc(interval.start, locale)}</time> → <time dateTime={interval.end}>{formatUtc(interval.end, locale)}</time></p>
            <p className="muted">{t("Sun visible")} · {site.sunHours} h · {t("Earth visible")} · {site.earthHours} h</p>
            <p className="muted text-sm">{t(interval.clipped_start ? "Visible throughout the queried week." : "Still visible at the end of the queried week.")}</p>
          </article>;
        })}
      </div>
      <details ref={sourceDetails}>
        <summary>{t("How the team obtained these hours")}</summary>
        <p id="saved-model-source" tabIndex={-1}>{t("Each site has one continuous overlap per week. The total shown is also the longest overlap inside that week. The bars share a scale of 168 hours from the start of each week.")}</p>
        <p>{t("The team sampled once per hour with SPICE and a PGDA terrain horizon for an observer 2 m above the surface. Sun visibility uses the upper limb. Earth visibility uses clearance above the local horizon.")}</p>
        <p>{t("Source run")} · <code>{runId}</code> · <a href="https://github.com/justsomenewbie/moon-plan-b/blob/953a39cf1b5ac7e8b61d82d6b0dc5bc0469807f1/docs/BACKEND_RECONCILIATION.md#reproduce-the-odysseus-and-athena-weeks" target="_blank" rel="noreferrer">{t("Source and interval checks")} ↗</a></p>
      </details>
    </div>
    {children}
  </section>;
}

import type { TerrainSummary } from "../lib/api/terrain-summary";
import TerrainObservations from "./terrain-observations";
import { useLanguage } from "./language";

function UtcTime({ value }: { value: string }) {
  return <time dateTime={value}>{value.replace("T", " ").replace(/Z$/, " UTC")}</time>;
}

function TimeRange({ start, end }: { start: string; end: string }) {
  return <><UtcTime value={start} /> → <UtcTime value={end} /></>;
}

function SiteResult({ site }: { site: TerrainSummary["sites"][number] }) {
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

export default function TerrainResult({ result, onPrint, permalink }: { result: TerrainSummary; onPrint: () => void; permalink?: string }) {
  const { t } = useLanguage();
  const { range, run, model, sources } = result;
  const clippedRange = range.start !== range.requested_start || range.end !== range.requested_end;
  return <main id="workspace" className="terrain-result" aria-labelledby="terrain-title" tabIndex={-1}>
    <div className="section-heading">
      <h2 id="terrain-title">{t("Sun and Earth visibility above the terrain horizon")}</h2>
      <div className="terrain-print flex flex-wrap items-center gap-3">
        {permalink && <a href={permalink} target="_blank" rel="noreferrer">{t("Open comparison in a new tab")}</a>}
        <button type="button" className="button outline terrain-print" onClick={onPrint}>{t("Print report")}</button>
      </div>
    </div>
    <p>{t("Evaluated UTC range")} · <TimeRange start={range.start} end={range.end} /></p>
    {clippedRange && <p>{t("Requested UTC range on the model grid")} · <TimeRange start={range.requested_start} end={range.requested_end} /></p>}
    <p className="muted text-sm">{t("Times use an exclusive end. The model evaluated {count} samples at {step} s intervals.", { count: range.n_samples, step: range.step_s })}</p>
    {result.sites.length ? <div className="week-sites">{result.sites.map(site => <SiteResult key={site.id} site={site} />)}</div>
      : <p className="data-notice my-4">{t("The dataset contains no site results for this range.")}</p>}

    {result.sites.length > 0 && <TerrainObservations key={result.dataset_id} result={result} />}

    <section id="sources" className="sources-section" aria-labelledby="terrain-sources" tabIndex={-1}>
      <h2 id="terrain-sources">{t("Sources & method")}</h2>
      <p className="muted text-sm">{t("Supplied scientific text, source names and technical diagnostics remain in their original language.")}</p>
      <div className="source-columns">
        <div>
          <h3>{t("Model")}</h3>
          <p>{model.label} · <code>{model.id}</code></p>
          <p className="mt-2">{model.definition}</p>
          <h3 className="mt-4">{t("Model limits")}</h3>
          <ul className="list-disc space-y-1 pl-5">{model.limits.map((limit, i) => <li key={i}>{limit}</li>)}</ul>
        </div>
        <div>
          <h3>{t("Source run")}</h3>
          <p>{run.label}</p>
          <dl className="metadata">
            <div><dt>{t("Run ID")}</dt><dd><code>{run.run_id}</code></dd></div>
            <div><dt>{t("Run time (UTC)")}</dt><dd>{run.run_timestamp_utc}</dd></div>
            <div><dt>{t("Ephemeris provider")}</dt><dd>{run.provider}</dd></div>
            <div><dt>{t("Terrain elevation model")}</dt><dd>{run.dem}</dd></div>
            <div><dt>{t("Horizon method")}</dt><dd>{run.horizon_method}</dd></div>
            <div><dt>{t("Observer height above surface")}</dt><dd>{run.observer_height_m} m</dd></div>
            <div><dt>{t("Minimum Earth clearance")}</dt><dd>{run.min_earth_clearance_deg}°</dd></div>
            <div><dt>{t("Code version")}</dt><dd>{run.code_version}</dd></div>
            {run.git_commit && <div><dt>Git</dt><dd><code>{run.git_commit}</code></dd></div>}
            <div><dt>{t("Dataset")}</dt><dd><code>{result.dataset_id}</code></dd></div>
            <div><dt>{t("Schema")}</dt><dd><code>{result.schema_version}</code></dd></div>
            <div><dt>{t("Evidence")}</dt><dd><code>{result.evidence}</code></dd></div>
          </dl>
          <p>{t("Manifest path on the source server")} · <code>{run.manifest_url}</code></p>
          <code className="hash">SHA-256 {run.manifest_sha256}</code>
        </div>
      </div>
      <h3>{t("Data sources")}</h3>
      <p className="muted">{result.attribution}</p>
      {sources.length ? <ul className="source-list">{sources.map(source => <li key={source.id}>
        {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : <span>{source.title}</span>}
        <p className="muted text-sm"><code>{source.id}</code></p>
        {source.sha256 && <code className="hash">SHA-256 {source.sha256}</code>}
      </li>)}</ul> : <p>{t("No source entries were supplied.")}</p>}
    </section>
  </main>;
}

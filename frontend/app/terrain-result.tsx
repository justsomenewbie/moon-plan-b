import type { TerrainSummary } from "../lib/api/terrain-summary";
import TerrainObservations from "./terrain-observations";
import { useLanguage } from "./language";
import { RunSourceLinks, SiteResult, TimeRange } from "./terrain-site-result";
import TerrainDates from "./terrain-dates";
import TerrainPair, { type DisplayedPair } from "./terrain-pair";
import AlternativeDates from "./alternative-dates";
import { ComparisonDownload, RunDownloads } from "./terrain-downloads";

export default function TerrainResult({ result, view, onSelect, onPrint, liveWindow, printingPair, replayPair, onDisplayedPair }: {
  onDisplayedPair: (pair: DisplayedPair | null) => void;
  liveWindow?: { from: string; to: string; resolutionSeconds: number }; replayPair: boolean; printingPair: boolean;
  result: TerrainSummary; view: { siteIndex: number; sample: number; link: string };
  onSelect: (siteIndex: number, sample: number) => void; onPrint: () => void;
}) {
  const { t } = useLanguage();
  const { range, run, model, sources } = result;
  const observationSite = result.sites[view.siteIndex];
  const clippedRange = range.start !== range.requested_start || range.end !== range.requested_end;
  return <main id="workspace" className="terrain-result" aria-labelledby="terrain-title" tabIndex={-1}>
    <div className="section-heading">
      <h2 id="terrain-title">{t("Sun and Earth visibility above the site horizon")}</h2>
      <div className="terrain-print flex flex-wrap items-center gap-3">
        {view.link && <a href={view.link} target="_blank" rel="noreferrer">{t("Open selected observation in a new tab")}</a>}
        {liveWindow && <ComparisonDownload result={result} />}
        <button type="button" className="button outline terrain-print" onClick={onPrint}>{t(printingPair ? "Print ranked pair" : "Print report")}</button>
      </div>
    </div>
    {liveWindow && (liveWindow.from !== range.requested_start || liveWindow.to !== range.requested_end) &&
      <p>{t("Requested UTC range")} · <TimeRange start={liveWindow.from} end={liveWindow.to} /></p>}
    <p>{t("Evaluated UTC range")} · <TimeRange start={range.start} end={range.end} /></p>
    {clippedRange && <p>{t("Requested UTC range on the model grid")} · <TimeRange start={range.requested_start} end={range.requested_end} /></p>}
    <p className="muted text-sm">{t("Times use an exclusive end. The model evaluated {count} samples at {step} s intervals.", { count: range.n_samples, step: range.step_s })}</p>
    {result.sites.length ? <div className="week-sites">{result.sites.map(site => <SiteResult key={site.id} site={site} source={result} liveResult={liveWindow ? result : undefined} />)}</div>
      : <p className="data-notice my-4">{t("The dataset contains no site results for this range.")}</p>}

    {liveWindow && <TerrainPair replay={replayPair} resolutionSeconds={liveWindow.resolutionSeconds} onDisplayedPair={onDisplayedPair} key={JSON.stringify([result.dataset_id, run.run_id, range.start, range.end])} result={result} />}
    {liveWindow && <TerrainDates key={result.dataset_id} result={result} baseWindow={liveWindow} />}

    {result.sites.length > 0 && <TerrainObservations live={Boolean(liveWindow)} result={result} siteIndex={view.siteIndex} sample={view.sample} onSelect={onSelect} />}

    {view.link && observationSite && <AlternativeDates key={result.dataset_id + "/" + observationSite.id} result={result} site={observationSite} />}

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
          {view.link && <><RunSourceLinks run={run} /><RunDownloads key={run.run_id + run.manifest_sha256} run={run} /></>}
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

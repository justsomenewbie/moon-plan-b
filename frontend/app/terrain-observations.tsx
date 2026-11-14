import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { terrainSkyScenario } from "../lib/terrain-sky";
import LocalSky from "./local-sky";
import { SampleTable, SkyPosition, Timeline } from "./observations";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import { useLanguage } from "./language";
import { EarthSightTimes, VisibilityPrecision } from "./terrain-site-result";
import { clipEarthWindows } from "../lib/earth-windows";
import TerrainInstant from "./terrain-instant";
import styles from "./terrain-observations.module.css";

type Site = TerrainSummary["sites"][number];
type Range = TerrainSummary["range"];
const bodies = ["sun", "earth"] as const;
const labels = { sun: "Sun", earth: "Earth", both: "Both visible" } as const;
const utc = (stamp: string) => stamp.replace("T", " ").replace("Z", " UTC");

function SkyTracks({ site, sample, sourceStep }: { site: Site; sample: number; sourceStep: number }) {
  const { t } = useLanguage();
  const { horizon, series } = site;
  const chart = useMemo(() => {
    let low = 0, high = 0;
    for (const column of [horizon?.el_deg, series?.sun_el_deg, series?.earth_el_deg]) {
      for (const el of column ?? []) { low = Math.min(low, el); high = Math.max(high, el); }
    }
    const unit = high - low > 50 ? 15 : 5;
    low = Math.max(-90, Math.floor(low / unit) * unit - unit);
    high = Math.min(90, Math.ceil(high / unit) * unit + unit);
    const y = (el: number) => 100 * (high - el) / (high - low);
    const point = (az: number, el: number) => `${az.toFixed(3)},${y(el).toFixed(3)}`;
    const mask = horizon?.az_deg.map((az, i) => (i ? "L" : "M") + point(az, horizon.el_deg[i])).join(" ");
    const times = series?.t.map(stamp => Date.parse(stamp)) ?? [];
    const tracks = series && bodies.map(body => {
      const az = series[`${body}_az_deg`], el = series[`${body}_el_deg`];
      const points = az.map((angle, i) => point(angle, el[i]));
      // A thinned series with partial coverage cannot prove continuity across omitted source samples.
      const maxGap = (site.coverage_in_range === "complete" ? series.step_s : sourceStep) * 1000;
      const path = points.map((p, i) => {
        const join = i > 0 && times[i] - times[i - 1] <= maxGap && Math.abs(az[i] - az[i - 1]) <= 180;
        return (join ? "L" : "M") + p;
      }).join(" ");
      return { body, path, dots: points.map(p => "M" + p + "h0").join(" ") };
    });
    return { low, high, y, mask, tracks };
  }, [horizon, series, site.coverage_in_range, sourceStep]);
  if (!horizon && !series?.t.length) return null;

  const horizonLabel = horizon?.method === "flat" ? "Smooth-sphere horizon" : "Site horizon";
  return <figure className={styles.sky}>
    <figcaption><h4>{t("Site horizon and apparent body positions")}</h4>
      <p className="muted text-sm">{t("Body tracks show centre elevation. Visibility uses the flags returned by the model.")}</p></figcaption>
    <div className={styles.legend}>
      {horizon && <span>━ {t(horizonLabel)}</span>}
      {series?.t.length ? <><span className="sun">● {t("Sun")}</span><span className="earth">■ {t("Earth")}</span></> : null}
    </div>
    <p className="muted text-xs">{t("Elevation · degrees")}</p>
    <div className={`plot-frame ${styles.frame}`}>
      <div className="y-ticks" aria-hidden="true"><span>{chart.high}°</span><span>{(chart.high + chart.low) / 2}°</span><span>{chart.low}°</span></div>
      <div className="plot-area"><svg className="timeline-svg" viewBox="0 0 360 100" preserveAspectRatio="none" role="img" aria-label={t("Site horizon and apparent body positions")}>
        {[0, 50, 100].map(y => <line key={y} x1="0" x2="360" y1={y} y2={y} className="grid-line" />)}
        {[0, 90, 180, 270, 360].map(x => <line key={x} x1={x} x2={x} y1="0" y2="100" className="grid-line" />)}
        {chart.mask && <path data-horizon="" d={chart.mask} className={styles.mask} />}
        {chart.tracks?.map(({ body, path, dots }) => <g key={body} className={body}>
          <path data-body={body} d={path} className={styles.trail} strokeDasharray={body === "earth" ? "5 3" : undefined} />
          <path d={dots} className={styles.dots} />
        </g>)}
        {series && series.t[sample] && <>
          <circle className="sun" cx={series.sun_az_deg[sample]} cy={chart.y(series.sun_el_deg[sample])} r="2" fill="currentColor" />
          <rect className="earth" x={series.earth_az_deg[sample] - 2} y={chart.y(series.earth_el_deg[sample]) - 2} width="4" height="4" fill="currentColor" />
        </>}
      </svg></div>
      <div className="x-ticks" aria-hidden="true">{[0, 90, 180, 270, 360].map(x => <span key={x}>{x}°</span>)}</div>
    </div>
    <p className="muted text-xs">{t("Azimuth clockwise from north · degrees")}</p>
  </figure>;
}

function VisibilityBands({ site, range, selected }: { site: Site; range: Range; selected?: string }) {
  const { t } = useLanguage();
  const start = Date.parse(range.start), span = Date.parse(range.end) - start;
  const x = (stamp: string) => (Date.parse(stamp) - start) / span * 800;
  const describe = (window: Site["windows"]["both"][number]) => [
    `${utc(window.start)} → ${utc(window.end)} · ${window.duration_h} h`,
    window.clipped_start && t("Start clipped"),
    window.clipped_end && t("End clipped"),
  ].filter(Boolean).join(" ");
  return <section className="visibility-bands"><h4>{t("Visibility intervals")}</h4>
    <p className="muted text-sm"><time dateTime={range.start}>{utc(range.start)}</time> → <time dateTime={range.end}>{utc(range.end)}</time></p>
    <VisibilityPrecision series={[site.windows.sun, site.windows.earth]} range={range} />
    {(["sun", "earth", "both"] as const).map(body => {
      const label = t(labels[body]), windows = site.windows[body];
      return <div key={body} className={`visibility-row ${body === "both" ? "simultaneous" : body}`}>
        <span>{label}</span>
        <svg role="img" aria-label={t("{body} visibility intervals", { body: label })} viewBox="0 0 800 16" preserveAspectRatio="none">
          <desc>{[t("{count} supplied intervals", { count: windows.length }), ...windows.map(describe)].join(". ")}</desc>
          <rect width="800" height="16" fill="none" stroke="var(--line)" />
          {windows.map(w => <rect key={w.start} x={x(w.start)} width={x(w.end) - x(w.start)} y="2" height="12" fill="currentColor">
            <title>{describe(w)}</title></rect>)}
          {selected && <line x1={x(selected)} x2={x(selected)} y1="0" y2="16" className="cursor-line" />}
        </svg>
      </div>;
    })}
    <EarthSightTimes range={range} windows={site.coverage_in_range === "complete" ? clipEarthWindows(site.windows.earth, range.start, range.end) : undefined} />
    {site.coverage_in_range !== "complete" && <p className="muted text-xs">{t("Coverage is incomplete. Unmarked time may have no data.")}</p>}
  </section>;
}

function SiteObservations({ site, range, sample }: { site: Site; range: Range; sample: number }) {
  const { t } = useLanguage();
  const series = site.series, selected = series?.t[sample];
  return <>
    <p className={styles.printSite}>{site.name}</p>
    <SkyTracks site={site} sample={sample} sourceStep={range.step_s} />
    <VisibilityBands site={site} range={range} selected={selected} />
    {series && selected ? <section className={styles.inspector}><h4>{t("Selected observation")}</h4>
      <div className="table-scroll"><table aria-label={t("Selected observation")}>
        <thead><tr>{["Body", "Azimuth", "Elevation angle", "Visibility"].map(key => <th key={key} scope="col">{t(key)}</th>)}</tr></thead>
        <tbody>{bodies.map(body => <tr key={body}><th scope="row">{t(labels[body])}</th>
          <td>{series[`${body}_az_deg`][sample]}°</td><td>{series[`${body}_el_deg`][sample]}°</td>
          <td>{t(series[`${body}_visible`][sample] ? "Visible" : "Hidden")}</td></tr>)}</tbody>
      </table></div>
      <p>{t("Both visible")} · {t(series.both_visible[sample] ? "Yes" : "No")}</p>
    </section> : <p className="muted text-sm">{t("No angular samples were supplied for this site.")}</p>}
  </>;
}

export default function TerrainObservations({ result, siteIndex, sample, onSelect, onSelectSite, fallbackUtc, live, reducedMotion }: {
  result: TerrainSummary; siteIndex: number; sample: number; live: boolean; reducedMotion: boolean;
  onSelect: (siteIndex: number, sample: number) => void; onSelectSite: (index: number) => void; fallbackUtc?: string;
}) {
  const { t, locale } = useLanguage();
  const [clearance, setClearance] = useState(0);
  const [playingSite, setPlayingSite] = useState<number | null>(null);
  const playing = playingSite === siteIndex;
  const site = result.sites[siteIndex];
  const count = site?.series?.t.length ?? 0;
  const at = site?.series?.t[sample];
  // A ranked pair keeps stable A/B identities. Larger catalogs render only the selected site's tracks.
  const indices = useMemo(() => result.sites.length === 2 ? [0, 1] : [siteIndex], [result, siteIndex]);
  const views = useMemo(() => indices.flatMap(index => {
    const sky = terrainSkyScenario(result, result.sites[index]);
    return sky ? [{ index, sky }] : [];
  }), [result, indices]);
  const current = views.find(view => view.index === siteIndex);
  const a = views[0]?.sky, b = views[1]?.sky;
  const offset = at && a ? Date.parse(at) - Date.parse(a.startUtc) : undefined;
  const advance = useEffectEvent(() => onSelect(siteIndex, sample + 1));
  useEffect(() => {
    if (playingSite === null) return;
    if (!playing || reducedMotion || sample + 1 >= count) { setPlayingSite(null); return; }
    const timer = window.setTimeout(advance, 900);
    return () => window.clearTimeout(timer);
  }, [playing, playingSite, reducedMotion, siteIndex, sample, count]);
  if (!site) return null;
  function chooseSite(index: number) {
    setPlayingSite(null);
    onSelectSite(index);
  }
  return <section id="terrain-observations" className={styles.observations} aria-labelledby="terrain-observations-title">
    <h3 id="terrain-observations-title">{t("Sky observations and visibility")}</h3>
    {result.sites.length > 1 ? <label className={`field ${styles.control}`}>{t("Observation site")}
      <select value={site.id} onChange={event => chooseSite(event.currentTarget.selectedIndex)}>
        {result.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select></label> : <p className={styles.screenSite}>{site.name}</p>}
    {fallbackUtc && <p role="status" className="muted text-sm">{locale === "vi"
      ? <>Tại {site.name}, không có mẫu cho thời điểm {utc(fallbackUtc)}. {at ? `Đang hiển thị mẫu đầu tiên, lúc ${utc(at)}.` : "Không có mẫu nào trong khoảng đã chọn."}</>
      : <>{site.name} has no sample at {utc(fallbackUtc)}. {at ? `Showing the first available sample at ${utc(at)}.` : "No samples are available in the selected range."}</>}</p>}
    {a && current && at && offset !== undefined ? <>
      <div className="print:hidden">
        <Timeline a={a} b={b} mode="sites" offset={offset} clearanceDeg={clearance} angularOnly />
      </div>
      <p className="muted text-sm">{t("{count} returned samples · regular spacing {step} s", { count, step: site.series!.step_s })}
        {site.series!.decimated && <> · {t("Downsampled with transition samples retained")}</>}</p>
      <div className="playback print:hidden">
        <button className="button outline" type="button" disabled={count < 2 || reducedMotion} onClick={() => {
          if (!playing && sample + 1 === count) onSelect(siteIndex, 0);
          setPlayingSite(playing ? null : siteIndex);
        }}>{t(playing ? "Pause timeline" : "Play timeline")}</button>
        <label className="slider-label"><span className="sr-only">{t("Observation sample")}</span>
          <input type="range" min="0" max={count - 1} step="1" value={sample} disabled={count < 2}
            aria-valuetext={utc(at)} onChange={event => { setPlayingSite(null); onSelect(siteIndex, Number(event.target.value)); }} /></label>
      </div>
      <time id="terrain-sample-utc" className="mono" dateTime={at}>{utc(at)}</time>
      <div className="print:hidden">
        <LocalSky sites={result.sites} source={result.run.run_id} terrainVisibility={{ sun: site.series!.sun_visible[sample], earth: site.series!.earth_visible[sample] }}
          a={a} b={b} offset={offset}
          alternative={current === views[1]} setAlternative={useSecond => chooseSite(views[useSecond ? 1 : 0].index)}
          clearanceDeg={clearance} setClearanceDeg={setClearance} />
        <SkyPosition scenario={current.sky} offset={offset} clearanceDeg={clearance} siteName={site.name} />
        <SampleTable a={a} b={b} terrain />
      </div>
    </> : result.sites.some(entry => entry.series?.t.length) && <p id="local-sky" tabIndex={-1}>{t("Choose a site with angular samples to view its 3D sky.")}</p>}
    <SiteObservations site={site} range={result.range} sample={sample} />
    {live && site.coverage_in_range !== "missing" && <TerrainInstant
      key={JSON.stringify([result.dataset_id, result.run.run_id, site.id, result.range.start, result.range.end])}
      runId={result.run.run_id} site={site} range={result.range} initialUtc={at ?? result.range.start} />}
  </section>;
}

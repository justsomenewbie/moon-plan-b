import { useCallback, useState } from "react";
import { lrocSiteUrl, type MapPoint, type PairLocation } from "../../lib/globe-sites";
import SiteGlobe from "./site-globe";
import { useLanguage } from "../language";

type MapSite = PairLocation & { hours: number[] | null; longest?: number };

function project(point: MapPoint) {
  // The north-up NASA mosaic spans 180°W to 180°E with the prime meridian in its center.
  return { x: ((point.longitude + 180) % 360) * 2, y: (90 - point.latitude) * 2 };
}

export default function SiteMap({ sites, leaders, column, selected, focusRequest, onSelect, detailsHref }: {
  sites: MapSite[]; leaders: string[]; column: number; selected: MapSite; focusRequest: number; onSelect: (id: string) => void; detailsHref: string;
}) {
  const { t } = useLanguage();
  const [flat, setFlat] = useState(false);
  const useFlatMap = useCallback(() => setFlat(true), []);
  const [zoom, setZoom] = useState(1);
  const [imageFailed, setImageFailed] = useState(false);
  const isLeader = (site: MapSite) => leaders.includes(site.id) && (site.hours?.[column] ?? 0) > 0;
  const point = "point" in selected.location ? selected.location.point : null;
  const focus = point ? project(point) : { x: 360, y: 180 };
  const width = 720 / zoom, height = 360 / zoom;
  const left = Math.max(0, Math.min(720 - width, focus.x - width / 2));
  const top = Math.max(0, Math.min(360 - height, focus.y - height / 2));
  function select(site: MapSite) {
    onSelect(site.id);
    if (!("point" in site.location)) setZoom(1);
  }
  const mapped = sites.filter(site => "point" in site.location);
  // The selected pin gets the top hit target when polar sites overlap.
  const ordered = mapped.sort((a, b) => Number(a.id === selected.id) - Number(b.id === selected.id) || Number(isLeader(a)) - Number(isLeader(b)));
  return <figure className="plan-site-map" aria-labelledby="plan-site-map-title">
    <h4 id="plan-site-map-title">{t("Sites on the Moon")}</h4>
    <div className="plan-map-layout">
      <div>
        {!flat ? <SiteGlobe sites={sites} leaders={sites.filter(isLeader).map(site => site.id)}
          selectedId={selected.id} focusRequest={focusRequest} onSelect={onSelect} zoom={zoom} onZoom={setZoom} onUnavailable={useFlatMap} /> : imageFailed ? <p role="status">{t("The map image could not load. Select a site to see its coordinates.")}</p> :
          <svg className="plan-map-surface" viewBox={`${left} ${top} ${width} ${height}`} role="group" aria-labelledby="plan-site-map-title">
            <image width="720" height="360" href="/images/lroc-color-2k.jpg" onError={() => setImageFailed(true)} />
            <path d="M0 180H720 M360 0V360" stroke="white" opacity=".3" fill="none" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
            {ordered.map(site => {
              if (!("point" in site.location)) return null;
              const { x, y } = project(site.location.point);
              const leader = isLeader(site);
              return <g key={site.id} className="plan-map-point" data-site={site.id} transform={`translate(${x} ${y}) scale(${1 / zoom})`}
                role="button" aria-label={t("Inspect {site}", {site: site.name})} aria-pressed={site.id === selected.id}
                onClick={() => select(site)} tabIndex={-1} onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(site); }
                }}>
                <title>{site.name}</title>
                <circle r="11" fill="transparent" />
                {leader ? <path className="map-leader" d="M0 -8 8 0 0 8 -8 0Z" /> : <circle className="map-other" r="4.5" />}
              </g>;
            })}
            {point && <circle cx={focus.x} cy={focus.y} r={12 / zoom} fill="none" stroke="white" strokeWidth="1.5" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
          </svg>}
        {mapped.length < sites.length && <p>{t("Verified map positions: {mapped} of {count}.", {mapped: mapped.length, count: sites.length})}</p>}
        <div className="map-legend"><span><b aria-hidden="true">◆</b> {t("Top for this window")}</span><span><b aria-hidden="true">●</b> {t("Other sites")}</span></div>
      </div>
      <div className="plan-map-inspector">
        <label className="field">{t("Inspect a site")}<select value={selected.id} onChange={event => {
          const site = sites.find(s => s.id === event.target.value);
          if (site) select(site);
        }}>{sites.map(site => <option key={site.id} value={site.id}>{isLeader(site) ? "◆ " : ""}{site.name}</option>)}</select></label>
        <div aria-live="polite">
          <strong>{selected.name}</strong>
          {selected.hours ? <dl className="plan-site-metrics">{["Sun visible", "Earth visible", "Both visible"].map((key, i) =>
            <div key={key}><dt>{t(key)}</dt><dd>{selected.hours![i]} h</dd></div>)}
            {selected.longest !== undefined && <div><dt>{t("Longest joint window")}</dt><dd>{selected.longest} h</dd></div>}
          </dl> : <p>{t("Incomplete coverage")}</p>}
          {point ? <p>{point.latitude}° {t("latitude")} · {point.longitude}° {t("east longitude")}</p> :
            "reason" in selected.location && <p>{t(selected.location.reason)}</p>}
        </div>
        <a className="button primary plan-site-details" href={detailsHref}>{t("Site details")}</a>
        {point && <>
          {!imageFailed && <div className="plan-map-zoom">
            <button type="button" aria-label={t("Zoom out")} disabled={zoom === 1} onClick={() => setZoom(zoom / 2)}>−</button>
            <span>{zoom}×</span>
            <button type="button" aria-label={t("Zoom in")} disabled={zoom === 8} onClick={() => setZoom(zoom * 2)}>+</button>
          </div>}
          <a href={lrocSiteUrl(point)} target="_blank" rel="noreferrer">{t("View this site in LROC imagery ↗")}</a>
        </>}
      </div>
    </div>
    <figcaption>{t("Ranking measures visibility. Landing safety requires a separate assessment.")} <a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">NASA’s Scientific Visualization Studio</a></figcaption>
  </figure>;
}

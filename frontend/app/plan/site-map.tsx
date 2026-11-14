import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { lrocRegionalImageUrl, lrocSiteUrl, type MapPoint, type PairLocation } from "../../lib/globe-sites";
import { compassHeading } from "../../lib/compass";
import { plannerSunAt, plannerSunSource, sunBearing } from "../../lib/planner-sunlight";
import { EarthSightTimes } from "../terrain-site-result";
import type { EarthWindow } from "../../lib/earth-windows";
import { useLanguage } from "../language";
import { SitePinPicker, sitesAtPointer } from "../site-pin-picker";

const MoonGlobe = dynamic(() => import("../moon-globe"));

type MapSite = PairLocation & { smoothSphere: boolean; hours: number[] | null; earthWindows?: EarthWindow[]; missionWindow?: EarthWindow; longest?: number; trackingPower?: number };

// Each bin is a quarter of unobstructed sunlight on a Sun-facing panel.
const sunlightBins = [
  { color: "#44517b", label: "0–<25%" },
  { color: "#29a3a2", label: "25–<50%" },
  { color: "#ef9b42", label: "50–<75%" },
  { color: "#fff192", label: "75–100%" },
];
const sunlightText = {
  en: {
    layer: "Color site rings by sunlight", key: "Average sunlight on a Sun-facing panel",
    help: "The percentage compares the modelled sunlight at each site with full, unobstructed sunlight. The average includes dark hours in the selected UTC window.",
    unavailable: "This result has no average sunlight values for the evaluated sites and times.", missing: "Unavailable",
  },
  vi: {
    layer: "Tô màu vòng quanh địa điểm theo mức nắng", key: "Ánh sáng trung bình trên tấm pin luôn hướng về Mặt Trời",
    help: "Tỷ lệ cho biết mỗi địa điểm nhận được bao nhiêu ánh sáng theo mô hình so với khi Mặt Trời chiếu sáng hoàn toàn. Giá trị trung bình tính cả giờ tối trong khoảng UTC đã chọn.",
    unavailable: "Kết quả này chưa có mức nắng trung bình cho các địa điểm và thời gian đã xét.", missing: "Chưa có dữ liệu",
  },
};
function sunlightColor(value: number) {
  return sunlightBins[Math.min(3, Math.floor(value * 4))].color;
}

function project(point: MapPoint) {
  // The north-up NASA mosaic spans 180°W to 180°E with the prime meridian in its center.
  return { x: ((point.longitude + 180) % 360) * 2, y: (90 - point.latitude) * 2 };
}

function RegionalImage({ url, name }: { url: string; name: string }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  if (status === "error") return <div>
    <p role="status">{t("The surface image could not load.")}</p>
    <button type="button" className="button outline" onClick={() => setStatus("loading")}>{t("Retry image")}</button>
  </div>;
  return <div className="plan-regional-image">
    <img src={url} width={512} height={512} referrerPolicy="no-referrer"
      alt={t("Lunar surface around {site}", {site: name})}
      onLoad={() => setStatus("ready")} onError={() => setStatus("error")} />
    {status === "ready" ? <span className="plan-regional-center" aria-hidden="true" /> :
      <span className="plan-regional-loading" role="status">{t("Loading surface image…")}</span>}
  </div>;
}

function SurfaceCloseUp({ point, name }: { point: MapPoint | null; name: string }) {
  const { t } = useLanguage();
  const [widthKm, setWidthKm] = useState(80);
  const [relief, setRelief] = useState(false);
  if (!point) return <p role="status">{t("Select a site with verified coordinates to view its surface.")}</p>;
  const url = lrocRegionalImageUrl(point, widthKm, relief);
  return <figure className="plan-regional-view">
    <div className="plan-map-modes" role="group" aria-label={t("Surface layer")}>
      <button type="button" aria-pressed={!relief} onClick={() => setRelief(false)}>{t("Orbital image")}</button>
      <button type="button" aria-pressed={relief} onClick={() => setRelief(true)}>{t("Terrain relief")}</button>
    </div>
    <RegionalImage key={url} url={url} name={name} />
    <figcaption>
      <strong>{name}</strong>
      <div className="plan-map-zoom">
        <button type="button" aria-label={t("Zoom out")} disabled={widthKm === 160} onClick={() => setWidthKm(widthKm * 2)}>−</button>
        <output>{t("{km} km across", {km: widthKm})}</output>
        <button type="button" aria-label={t("Zoom in")} disabled={widthKm === 40} onClick={() => setWidthKm(widthKm / 2)}>+</button>
      </div>
      <p>{t(relief ? "Color shows elevation. Shading shows the shape of the terrain under fixed lighting." :
        "Some crater floors appear dark in this mosaic. Switch to terrain relief to see their shape.")} {t("The ring marks the selected coordinates.")}</p>
      <p><a href={lrocSiteUrl(point, relief)} target="_blank" rel="noreferrer">{t("Open this area in the LROC map ↗")}</a></p>
      <a href="https://www.lroc.im-ldi.com/about/terms" target="_blank" rel="noreferrer">NASA/GSFC/Arizona State University</a>
    </figcaption>
  </figure>;
}

export default function SiteMap({ sites, leaders, column, criterion, initialSite, detailHref, startUtc, endUtc, stepSeconds, evaluatedHours }: {
  startUtc: string; endUtc: string; stepSeconds: number; evaluatedHours: number; sites: MapSite[]; leaders: string[]; column: number | "longest"; criterion: string; initialSite: string | null;
  detailHref: (siteId: string) => string | undefined;
}) {
  const { t, locale } = useLanguage();
  const solar = sunlightText[locale];
  const sun = useMemo(() => plannerSunAt(startUtc), [startUtc]);
  const [sunlight, setSunlight] = useState(false);
  const [selectedId, setSelectedId] = useState(initialSite);
  const [overlap, setOverlap] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState<"globe" | "flat" | "surface">("globe");
  const [customPoint, setCustomPoint] = useState<MapPoint | null>(null);
  const surfaceButton = useRef<HTMLButtonElement>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const value = (site: MapSite) => column === "longest" ? site.longest : site.hours?.[column];
  const isLeader = (site: MapSite) => leaders.includes(site.id) && (value(site) ?? 0) > 0;
  const selected = sites.find(site => site.id === selectedId) ?? sites.find(isLeader) ?? sites[0];
  if (!selected) return null;
  const details = detailHref(selected.id);
  const hours = value(selected);
  const duration = hours === undefined ? t("Incomplete coverage") : column === 1
    ? t("{hours} of {total} h", { hours, total: evaluatedHours }) : `${hours} h`;
  const reading = `${criterion} · ${duration}`;
  const point = "point" in selected.location ? selected.location.point : null;
  const bearing = point && sun ? sunBearing(point, sun) : undefined;
  const flatSun = sun ? project(sun) : undefined;
  const focus = point ? project(point) : { x: 360, y: 180 };
  const width = 720 / zoom, height = 360 / zoom;
  const left = Math.max(0, Math.min(720 - width, focus.x - width / 2));
  const top = Math.max(0, Math.min(360 - height, focus.y - height / 2));
  function inspectPoint(location: MapPoint) {
    const sameSite = point && Math.abs(location.latitude - point.latitude) < 1e-8 &&
      Math.abs(((location.longitude - point.longitude + 540) % 360) - 180) < 1e-8;
    setCustomPoint(sameSite ? null : location);
    setView("surface");
    surfaceButton.current?.focus({preventScroll: true});
  }
  function select(site: MapSite) {
    setCustomPoint(null);
    setSelectedId(site.id);
    if (!("point" in site.location)) setZoom(1);
  }
  const mapped = sites.filter(site => "point" in site.location);
  const hasSunlight = mapped.some(site => site.trackingPower !== undefined);
  const markerColors = sunlight && hasSunlight ? new Map(mapped.flatMap(site =>
    site.trackingPower === undefined ? [] : [[site.id, sunlightColor(site.trackingPower)] as const])) : undefined;
  // Give the selected site the top hit target when polar markers overlap.
  const ordered = mapped.sort((a, b) => Number(a.id === selected.id) - Number(b.id === selected.id) || Number(isLeader(a)) - Number(isLeader(b)));
  return <figure className="plan-site-map" aria-labelledby="plan-site-map-title">
    <h4 id="plan-site-map-title">{t("Sites on the Moon")}</h4>
    <div className="plan-map-layout">
      <div>
        {mapped.length > 0 && <div className="plan-map-modes" role="group" aria-label={t("Map view")}>
          <button type="button" aria-pressed={view === "globe"} onClick={() => setView("globe")}>{t("3D globe")}</button>
          <button type="button" aria-pressed={view === "flat"} onClick={() => setView("flat")}>{t("Flat map")}</button>
          <button type="button" ref={surfaceButton} aria-pressed={view === "surface"} disabled={!point && !customPoint}
            onClick={() => { setCustomPoint(null); setView("surface"); }}>{t("Surface close-up")}</button>
        </div>}
        {mapped.length > 0 && view !== "surface" && <div className="plan-sun-layer">
          {hasSunlight ? <label><input type="checkbox" checked={sunlight} onChange={event => setSunlight(event.target.checked)} /> {solar.layer}</label> :
            <small>{solar.unavailable}</small>}
          {markerColors && <div className="plan-sun-legend">
            <strong>{solar.key}</strong>
            <p>{solar.help}</p>
            <ul>{sunlightBins.map(bin => <li key={bin.color}><i aria-hidden="true" style={{ borderColor: bin.color }} />{bin.label}</li>)}
              {mapped.some(site => site.trackingPower === undefined) && <li><i aria-hidden="true" />{solar.missing}</li>}
            </ul>
          </div>}
        </div>}
        {view === "surface" ? <SurfaceCloseUp point={customPoint ?? point} name={customPoint
          ? t("Map location · {lat}° latitude, {lon}° east longitude", {
            lat: Number(customPoint.latitude.toFixed(3)), lon: Number(((customPoint.longitude + 360) % 360).toFixed(3)),
          }) : selected.name} /> :
          view === "globe" && mapped.length > 0 ? <MoonGlobe plannerSun={sun} pairSites={sites} terrainView={{
          siteId: selected.id, reading, onSelect: setSelectedId, onCloseUp: inspectPoint, markerColors, plannerLeaders: sites.filter(isLeader).map(site => site.id),
        }} /> : imageFailed ? <p role="status">{t("The map image could not load. Select a site to see its coordinates.")}</p> :
          <svg className="plan-map-surface" viewBox={`${left} ${top} ${width} ${height}`} role="group" aria-labelledby="plan-site-map-title">
            <image width="720" height="360" href="/images/lroc-color-2k.jpg" onError={() => setImageFailed(true)}
              onClick={event => {
                const matrix = event.currentTarget.getScreenCTM();
                if (!matrix) return;
                const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
                inspectPoint({ longitude: p.x / 2 - 180, latitude: 90 - p.y / 2 });
              }} />
            <path pointerEvents="none" d="M0 180H720 M360 0V360" stroke="white" opacity=".3" fill="none" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
            {flatSun && <g className="plan-subsolar" transform={`translate(${flatSun.x} ${flatSun.y}) scale(${1 / zoom})`}
              pointerEvents="none" aria-hidden="true"><circle r="9" /><circle r="3" /></g>}
            {ordered.map(site => {
              if (!("point" in site.location)) return null;
              const { x, y } = project(site.location.point);
              const leader = isLeader(site);
              return <g key={site.id} className="plan-map-point" data-site={site.id} transform={`translate(${x} ${y}) scale(${1 / zoom})`}
                role="button" aria-label={t("Inspect {site}", {site: site.name})} aria-pressed={site.id === selected.id}
                onClick={event => {
                  const hits = sitesAtPointer(event);
                  if (hits.length > 1) { event.currentTarget.focus({ preventScroll: true }); setOverlap(hits); }
                  else select(site);
                }} tabIndex={-1} onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(site); }
                }}>
                <title>{site.name}</title>
                <circle r="11" fill="transparent" />
                {markerColors && <circle r="9.5" fill="none" stroke={markerColors.get(site.id) ?? "#a7abb4"} strokeWidth="3"
                  strokeDasharray={markerColors.has(site.id) ? undefined : "2 2"} pointerEvents="none" />}
                {leader ? <path className="map-leader" d="M0 -8 8 0 0 8 -8 0Z" /> : <circle className="map-other" r="4.5" />}
              </g>;
            })}
            {point && <circle cx={focus.x} cy={focus.y} r={12 / zoom} fill="none" stroke="white" strokeWidth="1.5" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
          </svg>}
        {view === "flat" && overlap.length > 1 && <SitePinPicker sites={mapped.filter(site => overlap.includes(site.id)).map(site => ({
          id: site.id, name: site.name, select: () => select(site),
        }))}
          onClose={() => setOverlap([])} />}
        {view === "flat" && !imageFailed && mapped.length > 0 && <p>{t("Tap the map for a close-up, or choose a site and open Surface close-up.")}</p>}
        {mapped.length < sites.length && <p>{t("Verified map positions: {mapped} of {count}.", {mapped: mapped.length, count: sites.length})}</p>}
        {view !== "surface" && <div className="map-legend"><span><b aria-hidden="true">◆</b> {t("Top for this window")}</span><span><b aria-hidden="true">●</b> {t("Other sites")}</span></div>}
      </div>
      <div className="plan-map-inspector">
        <label className="field">{t("Inspect a site")}<select value={selected.id} onChange={event => {
          const site = sites.find(s => s.id === event.target.value);
          if (site) select(site);
        }}>{sites.map(site => <option key={site.id} value={site.id}>{isLeader(site) ? "◆ " : ""}{site.name}</option>)}</select></label>
        {sun && mapped.length > 0 && view !== "surface" && <div id="plan-sun-direction" className="plan-sun-direction">
          <strong>{t("Sun direction")} · <time dateTime={startUtc}>{startUtc.slice(0, 10)} 00:00 UTC</time></strong>
          <p>{t("☉ marks where the Sun appears directly overhead.")} {t("This snapshot shows the start of your date range.")}</p>
          {point && <p>{t("From {site}", {site: selected.name})} · {bearing === undefined ? t("No unique compass bearing.") :
            <><span className="plan-bearing-arrow" aria-hidden="true" style={{transform: `rotate(${bearing}deg)`}}>↑</span>{" "}
              <strong>{t(compassHeading(bearing))}</strong> · {t("{angle}° clockwise from local north", {angle: new Intl.NumberFormat(locale, {maximumFractionDigits: 1}).format(Math.round(bearing * 10) % 3600 / 10)})}</>}</p>}
          <a href={plannerSunSource} target="_blank" rel="noreferrer">NASA/JPL Horizons ↗</a>
        </div>}
        <div aria-live="polite">
          <strong>{selected.name}</strong>
          {markerColors && view !== "surface" && <p>{solar.key} · <strong>{selected.trackingPower === undefined ? solar.missing :
            new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(selected.trackingPower)}</strong></p>}
          <p>{reading}</p>
          {selected.smoothSphere && <p>{t("Outside elevation-map coverage. This site uses a smooth-sphere horizon and omits local terrain shadows.")}</p>}
          {point ? <p>{point.latitude}° {t("latitude")} · {point.longitude}° {t("east longitude")}</p> :
            "reason" in selected.location && <p>{t(selected.location.reason)}</p>}
        </div>
        <EarthSightTimes range={{ start: selected.missionWindow?.start ?? startUtc, end: selected.missionWindow?.end ?? endUtc, step_s: stepSeconds }} windows={selected.earthWindows} />
        {details && <a href={details}>{t("Site details")}</a>}
        {point && <>
          {!imageFailed && view === "flat" && <div className="plan-map-zoom">
            <button type="button" aria-label={t("Zoom out")} disabled={zoom === 1} onClick={() => setZoom(zoom / 2)}>−</button>
            <span>{zoom}×</span>
            <button type="button" aria-label={t("Zoom in")} disabled={zoom === 8} onClick={() => setZoom(zoom * 2)}>+</button>
          </div>}
          {view !== "surface" && <a href={lrocSiteUrl(point)} target="_blank" rel="noreferrer">{t("View this site in LROC imagery ↗")}</a>}
        </>}
      </div>
    </div>
    <figcaption>{t("Ranking measures visibility. Landing safety requires a separate assessment.")} <a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">NASA’s Scientific Visualization Studio</a></figcaption>
  </figure>;
}

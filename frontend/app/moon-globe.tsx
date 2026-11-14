import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { drawGlobe, globeCenter } from "../lib/moon-globe";
import { comparisonLocation, diskPosition, missionSites } from "../lib/globe-sites";
import type { GlobeSite, MapPoint } from "../lib/globe-sites";
import type { Dataset } from "../lib/dataset";
import { useLanguage } from "./language";
import saved from "../lib/odysseus-athena-weeks.json";
import "./globe-comparison.css";

const origin = { longitude: 15, latitude: -58 };
function coordinates(c: MapPoint, rounded = true) {
  const magnitude = (value: number) => rounded ? Math.abs(value).toFixed(0) : Math.abs(value);
  return `${magnitude(c.latitude)}°${c.latitude < 0 ? "S" : "N"} · ${magnitude(c.longitude)}°${c.longitude < 0 ? "W" : "E"}`;
}

type GlobeProps = {
  primary?: GlobeSite;
  alternative?: GlobeSite;
  evidence?: Dataset["evidence"];
  savedResult?: string;
  showSky: (alternative: boolean) => void;
};

type Target = {
  key: string;
  identity: GlobeSite | typeof missionSites[number];
  name: string;
  location: { point: MapPoint } | { reason: string };
  source?: string;
  missionId?: string;
};

export default function MoonGlobe({ primary, alternative, evidence, savedResult, showSky }: GlobeProps) {
  const { t } = useLanguage();
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState(origin);
  const [announced, setAnnounced] = useState<typeof origin | null>(null);
  const [chosen, setChosen] = useState<Pick<Target, "key" | "identity"> | null>(null);
  const targets: Target[] = [];
  if (evidence) {
    for (const [key, site] of [["Primary", primary], ["Alternative", alternative]] as const) {
      if (site) targets.push({ key, identity: site, name: site.name, location: comparisonLocation(site, evidence) });
    }
  }
  for (const mission of missionSites) {
    targets.push({ key: mission.name, identity: mission, name: mission.name, location: { point: mission }, source: mission.source, missionId: mission.id });
  }
  const target = targets.find(item => item.key === chosen?.key && item.identity === chosen.identity);
  const point = target && "point" in target.location ? target.location.point : undefined;
  const comparisonPins = targets.filter(item => !item.source && "point" in item.location);
  const pins = (target && !target.source) || (!savedResult && !target && comparisonPins.length)
    ? comparisonPins : targets.filter(item => item.source);
  const marker = point && ready ? diskPosition(point, center, zoom) : null;
  const selectedWeek = saved.weeks.find(week => week.startUtc === savedResult);
  const displayedWeeks = selectedWeek ? [selectedWeek] : saved.weeks;
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<{ context: CanvasRenderingContext2D; texture: ImageData; frame: ImageData } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; scale: number; center: typeof origin } | null>(null);

  useEffect(() => {
    const mission = missionSites.find(item => item.id === savedResult);
    if (mission) {
      setChosen({ key: mission.name, identity: mission }); setCenter(mission);
    } else if (!savedResult && evidence && primary) {
      const location = comparisonLocation(primary, evidence);
      if ("point" in location) {
        setChosen({ key: "Primary", identity: primary }); setCenter(location.point);
      } else { setChosen(null); setCenter(origin); }
    } else { setChosen(null); setCenter(origin); }
    setZoom(1); setAnnounced(null);
  }, [savedResult, primary, evidence]);

  const currentCenter = useEffectEvent(() => ({ ...center, zoom }));
  useEffect(() => { setEnabled(true); }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const surface = canvas.current;
    function unavailable() {
      if (active) { setFailed(true); setReady(false); setEnabled(false); }
    }
    surface?.addEventListener("contextlost", unavailable);
    const map = new Image();
    map.src = "/images/lroc-color-2k.jpg";
    async function load() {
      try {
        await map.decode();
        if (!active) return;
        const buffer = document.createElement("canvas");
        buffer.width = map.naturalWidth; buffer.height = map.naturalHeight;
        const source = buffer.getContext("2d", { willReadFrequently: true });
        const context = surface?.getContext("2d");
        if (!source || !context) throw Error("Canvas unavailable");
        source.drawImage(map, 0, 0);
        const texture = source.getImageData(0, 0, buffer.width, buffer.height);
        const frame = context.createImageData(context.canvas.width, context.canvas.height);
        const initial = currentCenter();
        drawGlobe(texture, frame, initial.longitude, initial.latitude, initial.zoom);
        context.putImageData(frame, 0, 0);
        renderer.current = { context, texture, frame };
        setReady(true);
      } catch { unavailable(); }
    }
    void load();
    return () => {
      active = false; renderer.current = null; drag.current = null;
      surface?.removeEventListener("contextlost", unavailable);
    };
  }, [enabled]);

  useEffect(() => {
    const view = renderer.current;
    if (!view) return;
    const id = requestAnimationFrame(() => {
      drawGlobe(view.texture, view.frame, center.longitude, center.latitude, zoom);
      view.context.putImageData(view.frame, 0, 0);
    });
    return () => cancelAnimationFrame(id);
  }, [center, zoom]);

  function startDrag(event: PointerEvent<HTMLCanvasElement>) {
    if (!ready || !event.isPrimary || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setAnnounced(null);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, scale: 150 / (zoom * event.currentTarget.getBoundingClientRect().width), center };
  }
  function moveDrag(event: PointerEvent<HTMLCanvasElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    setCenter(globeCenter(start.center.longitude - (event.clientX - start.x) * start.scale,
      start.center.latitude + (event.clientY - start.y) * start.scale));
  }
  function endDrag(event: PointerEvent<HTMLCanvasElement>) {
    if (drag.current?.id === event.pointerId) drag.current = null;
  }
  function selectCenter(next: typeof origin) {
    setCenter(next); setAnnounced(next);
  }

  function locate(item: Target | undefined) {
    setChosen(item ? { key: item.key, identity: item.identity } : null);
    if (item && "point" in item.location) selectCenter(item.location.point);
  }

  return <figure className="lunar-figure" id="lunar-reference" tabIndex={-1}>
    <div className="lunar-frame">
      <img src="/images/moon-mosaic.jpg" width="1024" height="1024" alt={ready ? "" : t("Photographic mosaic of the Moon, assembled from Lunar Reconnaissance Orbiter images.")} fetchPriority="high" />
      {enabled && <canvas ref={canvas} width={384} height={384} hidden={!ready} role="img" aria-label={t("Lunar surface globe")}
        onPointerDown={startDrag} onPointerMove={moveDrag}
        onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} />}
      {ready && pins.map((item, index) => {
        if (!("point" in item.location)) return null;
        const position = diskPosition(item.location.point, center, zoom);
        if (!position) return null;
        return <span key={item.key} className="site-pin" data-pin={index} style={{ left: `${(1 + position.x) * 50}%`, top: `${(1 + position.y) * 50}%` }}>
          <button type="button" title={item.name} aria-label={t("Inspect {site}", {site: item.name})}
            aria-pressed={target?.key === item.key} onClick={() => locate(item)}>{index + 1}</button>
        </span>;
      })}
    </div>
    <figcaption>
      <button type="button" className="button outline" aria-expanded={enabled} onClick={() => {
        setCenter(point ?? origin); setZoom(1); setAnnounced(null); setReady(false); setFailed(false); setEnabled(!enabled);
      }}>{t(failed ? "Retry globe" : enabled ? "Return to photograph" : "Rotate the Moon")}</button>
      {ready && <div className="globe-controls" role="group" aria-label={t("Rotate the lunar globe")}>
        {([["←", "Look west", -30, 0], ["→", "Look east", 30, 0], ["↑", "Look north", 0, 30], ["↓", "Look south", 0, -30]] as const).map(([icon, label, dx, dy]) =>
          <button type="button" key={label} aria-label={t(label)} title={t(label)} onClick={() => selectCenter(globeCenter(center.longitude + dx, center.latitude + dy))}>{icon}</button>)}
        <button type="button" aria-label={t("Zoom out")} disabled={zoom === 1} onClick={() => setZoom(zoom / 2)}>−</button>
        <button type="button" aria-label={t("Zoom in")} disabled={zoom === 4} onClick={() => setZoom(zoom * 2)}>+</button>
        <button type="button" onClick={() => { setZoom(1); selectCenter(origin); }}>{t("Reset view")}</button>
      </div>}
      {ready && <p className="globe-center">{t("View center")} · {coordinates(center)} · {zoom}×</p>}
      <p role="status">{failed ? t("Globe unavailable. The photograph is shown. Try again to reload the map.") : enabled && !ready ? t("Loading lunar surface map…") :
        ready && announced ? <span className="sr-only">{t("View center")} · {coordinates(announced)}</span> : ""}</p>
      {ready ? <><a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">{t("LRO surface map")} · NASA’s Scientific Visualization Studio</a><br />{t("Reference imagery with fixed lighting. Drag or use the arrows to rotate. This globe does not model terrain or calculate Sun/Earth visibility.")}</> :
        <><a href="https://svs.gsfc.nasa.gov/5001/" target="_blank" rel="noreferrer">LRO Moon mosaic · NASA’s Scientific Visualization Studio</a><br />{t("Context image, not current illumination or a selected-site view.")}</>}
      <div className="globe-locator">
        <div className="site-pin-key" role="group" aria-label={t("Locate a site")}>
          {pins.map((item, index) => <button type="button" key={item.key} data-pin={index}
            aria-pressed={target?.key === item.key} onClick={() => locate(item)}>
            <b>{index + 1}</b> {item.name}
            {"point" in item.location && <small>{coordinates(item.location.point, false)}</small>}
          </button>)}
        </div>
        <label htmlFor="globe-site">{t("Location on the reference globe")}</label>
        <select id="globe-site" value={target?.key ?? ""} onChange={event => locate(targets.find(item => item.key === event.target.value))}>
          <option value="">{t("Choose a location")}</option>
          {primary && <optgroup label={t("Current comparison")}>{targets.filter(item => !item.source).map(item =>
            <option key={item.key} value={item.key}>{t(item.key)} · {item.name}</option>)}</optgroup>}
          <optgroup label={t("Mission references")}>{missionSites.map(mission => <option key={mission.name}>{mission.name}</option>)}</optgroup>
        </select>
        {target && <div className="globe-place">
          {"reason" in target.location ? <p>{t(target.location.reason)}</p> : <p>{t("Reported location")} · {target.location.point.latitude}° {t("latitude")} · {target.location.point.longitude}° {t("east longitude")}</p>}
          {point && ready && <><button type="button" className="button outline" onClick={() => selectCenter(point)}>{t("Center on site")}</button>
            <p>{t(marker ? "The marker shows the approximate site location." : "This location is outside the current view.")}</p></>}
          {target.missionId && <div className="site-week-readings">
            <strong>{t("Saved team model results")}</strong>
            {displayedWeeks.map(week => {
              const site = week.sites.find(s => s.id === target.missionId);
              return site && <p key={week.startUtc}><time dateTime={week.startUtc}>{t("Week of {date} UTC", { date: week.startUtc.slice(0, 10) })}</time><br />
                {t("Sun visible")} · {site.sunHours} h · {t("Earth visible")} · {site.earthHours} h · {site.overlap.duration_h} h {t("with both visible")}</p>;
            })}
            <p>{t("Earth visibility describes a line of sight. Radio signal strength is unavailable.")}</p>
            <a href="#observed-week">{t("Source and interval checks")}</a>
          </div>}
          {target.source ? <a href={target.source} target="_blank" rel="noreferrer">{t("Landing site source")} ↗</a> :
            <><a href="#local-sky" onClick={() => showSky(target.key === "Alternative")}>{t("Open this observation in 3D")}</a>{" · "}
              <a href="#sources">{t("Sources & method")}</a></>}
        </div>}
      </div>
    </figcaption>
  </figure>;
}

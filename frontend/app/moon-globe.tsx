import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { drawGlobe, globeCenter, globePointAt, globeCenterForAnchor } from "../lib/moon-globe";
import { comparisonLocation, diskPosition, missionSites, pairCenter } from "../lib/globe-sites";
import type { GlobeSite, MapPoint, PairLocation } from "../lib/globe-sites";
import type { Dataset } from "../lib/dataset";
import { useLanguage } from "./language";
import saved from "../lib/odysseus-athena-weeks.json";
import sunlight from "../lib/horizons-weekly-sunlight.json";
import "./globe-comparison.css";

function clampZoom(value: number) { return Math.max(1, Math.min(4, Math.round(value * 100) / 100)); }

const origin = { longitude: 15, latitude: -58 };
const directions = [
  ["ArrowLeft", "←", "Look west", -30, 0], ["ArrowRight", "→", "Look east", 30, 0],
  ["ArrowUp", "↑", "Look north", 0, 30], ["ArrowDown", "↓", "Look south", 0, -30],
] as const;
function coordinates(c: MapPoint, rounded = true) {
  const magnitude = (value: number) => rounded ? Math.abs(value).toFixed(0) : Math.abs(value);
  return `${magnitude(c.latitude)}°${c.latitude < 0 ? "S" : "N"} · ${magnitude(c.longitude)}°${c.longitude < 0 ? "W" : "E"}`;
}

type GlobeProps = {
  home?: boolean;
  orbit?: { site: typeof missionSites[number]; weekUtc: string; onSite: (id: string) => void };
  primary?: GlobeSite;
  alternative?: GlobeSite;
  evidence?: Dataset["evidence"];
  savedResult?: string;
  pairSites?: readonly PairLocation[];
  terrainView?: { siteId: string; onSelect: (id: string) => void; plannerLeaders?: readonly string[] };
  showSky?: (alternative: boolean) => void;
};

type Target = {
  key: string;
  identity: GlobeSite | PairLocation | typeof missionSites[number];
  name: string;
  location: { point: MapPoint } | { reason: string };
  source?: string;
  missionId?: string;
};

export default function MoonGlobe({ home = false, orbit, primary, alternative, evidence, savedResult, pairSites, terrainView, showSky }: GlobeProps) {
  const { t } = useLanguage();
  const terrainSiteId = terrainView?.siteId;
  const plannerLeaders = terrainView?.plannerLeaders;
  const zoomHelpId = terrainView ? "terrain-globe-zoom-help" : pairSites ? "pair-globe-zoom-help" : "globe-zoom-help";
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState(origin);
  const [rotating, setRotating] = useState(!orbit);
  const [sunUtc, setSunUtc] = useState("");
  const [reducedMotion, setReducedMotion] = useState(true);
  const [announced, setAnnounced] = useState<typeof origin | null>(null);
  const [chosen, setChosen] = useState<Pick<Target, "key" | "identity"> | null>(null);
  const targets: Target[] = [];
  if (evidence) {
    for (const [key, site] of [["Primary", primary], ["Alternative", alternative]] as const) {
      if (site) targets.push({ key, identity: site, name: site.name, location: comparisonLocation(site, evidence) });
    }
  }
  if (pairSites) {
    for (const site of pairSites) targets.push({ key: site.id, identity: site, name: site.name, location: site.location });
  } else {
    for (const mission of missionSites) {
      targets.push({ key: mission.name, identity: mission, name: mission.name, location: { point: mission }, source: mission.source, missionId: mission.id });
    }
  }
  const target = targets.find(item => item.key === chosen?.key && item.identity === chosen.identity);
  const point = target && "point" in target.location ? target.location.point : undefined;
  const comparisonPins = targets.filter(item => !item.source && "point" in item.location);
  const pins = pairSites ? targets : target && !target.source ? comparisonPins : targets.filter(item => item.source);
  const marker = point && ready ? diskPosition(point, center, zoom) : null;
  const selectedWeek = saved.weeks.find(week => week.startUtc === savedResult);
  const displayedWeeks = selectedWeek ? [selectedWeek] : saved.weeks;
  // The sunlight selector belongs to the saved comparison, separately from any imported observation.
  const savedSite = saved.weeks.some(week => week.sites.some(site => site.id === savedResult));
  const solarChoices = home || pairSites || (target && !target.missionId) ? [] : sunlight.samples.filter(sample =>
    sample.utc === selectedWeek?.startUtc || (savedSite && !selectedWeek));
  const sun = orbit ? sunlight.samples.find(sample => sample.utc === orbit.weekUtc) : solarChoices.find(sample => sample.utc === sunUtc);
  const sunMarker = sun ? diskPosition(sun, center, zoom) : null;
  const viewer = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [rasterSize, setRasterSize] = useState(384);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<{ context: CanvasRenderingContext2D; texture: ImageData; frame: ImageData } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinGesture = useRef(false);
  const pinch = useRef<{ distance: number; zoom: number; anchor: MapPoint | null; center: MapPoint } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; scale: number; center: typeof origin } | null>(null);

  useEffect(() => {
    const mission = missionSites.find(item => item.id === savedResult);
    if (pairSites) {
      const first = terrainSiteId ? pairSites.find(site => site.id === terrainSiteId) : pairSites.find(site => "point" in site.location);
      const second = !terrainSiteId && pairSites.find(site => site !== first && "point" in site.location);
      setChosen(first ? { key: first.id, identity: first } : null);
      setCenter(first && "point" in first.location ? pairCenter(first.location.point,
        second && "point" in second.location ? second.location.point : undefined) : origin);
      setRotating(false);
    } else if (mission) {
      setChosen({ key: mission.name, identity: mission }); setCenter(mission); setRotating(false);
    } else { setChosen(null); setCenter(origin); }
    setZoom(1); setAnnounced(null); setSunUtc("");
  }, [savedResult, pairSites, terrainSiteId]);

  const orbitSite = orbit?.site;
  useEffect(() => {
    if (orbitSite) { setCenter(orbitSite); setZoom(1); setRotating(false); }
  }, [orbitSite]);

  const currentCenter = useEffectEvent(() => ({ ...center, zoom, sun }));
  useEffect(() => { setEnabled(true); }, []);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const surface = canvas.current;
    if (!ready || !surface || !rotating || reducedMotion) return;
    let timer: number | undefined;
    let visible = false;
    function update() {
      window.clearInterval(timer);
      if (visible && !document.hidden) {
        // The CPU-projected reference map turns slowly, at twelve updates per second.
        timer = window.setInterval(() => {
          setCenter(c => globeCenter(c.longitude + 0.24, c.latitude));
        }, 1000 / 12);
      }
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    });
    observer.observe(surface);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.clearInterval(timer);
    };
  }, [ready, rotating, reducedMotion]);

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
        drawGlobe(texture, frame, initial.longitude, initial.latitude, initial.zoom, initial.sun);
        context.putImageData(frame, 0, 0);
        renderer.current = { context, texture, frame };
        setReady(true);
      } catch { unavailable(); }
    }
    void load();
    return () => {
      active = false; renderer.current = null; drag.current = null; touches.current.clear(); pinch.current = null;
      surface?.removeEventListener("contextlost", unavailable);
    };
  }, [enabled]);

  useEffect(() => {
    const surface = canvas.current;
    if (!expanded || !surface) { setRasterSize(384); return; }
    function resize() {
      const width = surface!.getBoundingClientRect().width;
      setRasterSize(Math.max(384, Math.min(896, Math.round(width * window.devicePixelRatio))));
    }
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [expanded]);

  useEffect(() => {
    const view = renderer.current;
    if (!view) return;
    const id = requestAnimationFrame(() => {
      if (view.frame.width !== rasterSize) {
        view.context.canvas.width = view.context.canvas.height = rasterSize;
        view.frame = view.context.createImageData(rasterSize, rasterSize);
      }
      drawGlobe(view.texture, view.frame, center.longitude, center.latitude, zoom, sun);
      view.context.putImageData(view.frame, 0, 0);
    });
    return () => cancelAnimationFrame(id);
  }, [center, zoom, sun, rasterSize, ready]);

  function diskCoordinates(clientX: number, clientY: number) {
    const box = canvas.current!.getBoundingClientRect();
    return { x: 2 * (clientX - box.left) / box.width - 1, y: 2 * (clientY - box.top) / box.height - 1 };
  }

  const wheelZoom = useEffectEvent((event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || !event.deltaY) return;
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.current!.clientHeight : 1);
    const scale = clampZoom(zoom * Math.exp(-Math.max(-400, Math.min(400, pixels)) * 0.003));
    if (scale === zoom) return;
    if (!home) {
      const position = diskCoordinates(event.clientX, event.clientY);
      const anchor = globePointAt(center, zoom, position);
      if (!anchor) return;
      setCenter(globeCenterForAnchor(anchor, position, scale, center));
    }
    event.preventDefault();
    setRotating(false); setZoom(scale);
  });
  useEffect(() => {
    const surface = canvas.current?.parentElement;
    if (!surface || !ready) return;
    const wheel = (event: WheelEvent) => wheelZoom(event);
    surface.addEventListener("wheel", wheel, { passive: false });
    return () => surface.removeEventListener("wheel", wheel);
  }, [ready]);

  function fingerSpan() {
    const [a, b] = touches.current.values();
    return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      position: diskCoordinates((a.x + b.x) / 2, (a.y + b.y) / 2) };
  }
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!ready || event.button !== 0 || (event.pointerType !== "touch" && !event.isPrimary)) return;
    const element = event.target as HTMLElement;
    if (!touches.current.size) pinGesture.current = false;
    const onPin = !!element.closest(".site-pin");
    if (onPin && event.pointerType !== "touch") return;
    if (event.pointerType === "touch") {
      if (touches.current.size >= 2) return;
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    setRotating(false);
    element.setPointerCapture(event.pointerId);
    setAnnounced(null);
    if (touches.current.size === 2) {
      pinGesture.current = true;
      drag.current = null;
      const { distance, position } = fingerSpan();
      pinch.current = { distance, zoom, center, anchor: home ? null : globePointAt(center, zoom, position) };
      return;
    }
    if (onPin) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, scale: 150 / (zoom * event.currentTarget.getBoundingClientRect().width), center };
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch.current && touches.current.size === 2) {
        const { distance, position } = fingerSpan();
        const next = clampZoom(pinch.current.zoom * distance / pinch.current.distance);
        if (pinch.current.anchor) setCenter(globeCenterForAnchor(pinch.current.anchor, position, next, pinch.current.center));
        setZoom(next);
        return;
      }
    }
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    setCenter(globeCenter(start.center.longitude - (event.clientX - start.x) * start.scale,
      start.center.latitude + (event.clientY - start.y) * start.scale));
  }
  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (touches.current.delete(event.pointerId)) pinch.current = null;
    const start = drag.current;
    if (start?.id !== event.pointerId) return;
    drag.current = null;
    if (!home && event.type === "pointerup" && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 4) {
      const location = globePointAt(start.center, zoom, diskCoordinates(event.clientX, event.clientY));
      if (location) selectCenter(location);
    }
  }
  function selectCenter(next: typeof origin) {
    setRotating(false);
    setCenter(next); setAnnounced(next);
  }

  function turnWithKeyboard(event: KeyboardEvent<HTMLCanvasElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (["+", "=", "-"].includes(event.key)) {
      event.preventDefault(); setRotating(false);
      setZoom(value => clampZoom(value * (event.key === "-" ? 0.5 : 2)));
      return;
    }
    if (event.shiftKey) return;
    const direction = directions.find(([key]) => key === event.key);
    if (!direction) return;
    const [, , , dx, dy] = direction;
    event.preventDefault();
    selectCenter(globeCenter(center.longitude + dx, center.latitude + dy));
  }

  function locate(item: Target | undefined) {
    setRotating(false);
    setChosen(item ? { key: item.key, identity: item.identity } : null);
    if (item) terrainView?.onSelect(item.key);
    if (item && !item.missionId) setSunUtc("");
    if (item && "point" in item.location) selectCenter(item.location.point);
  }

  const frame = <div className={terrainView ? "lunar-frame w-full" : "lunar-frame"}
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      <img src="/images/moon-mosaic.jpg" width="1024" height="1024" alt={ready ? "" : t("Photographic mosaic of the Moon, assembled from Lunar Reconnaissance Orbiter images.")} fetchPriority="high" />
      {enabled && <canvas ref={canvas} width={384} height={384} hidden={!ready} role="img" aria-label={t("Lunar surface globe")}
        tabIndex={0} onKeyDown={turnWithKeyboard}
        aria-describedby={expanded ? zoomHelpId + "-expanded" : orbit ? "orbit-help" : home ? "home-globe-instructions globe-zoom-help" : sun ? "globe-sunlight-description globe-zoom-help" : zoomHelpId} />}
      {ready && !orbit && sunMarker && <span className="subsolar-marker" aria-hidden="true"
        style={{ left: `${(1 + sunMarker.x) * 50}%`, top: `${(1 + sunMarker.y) * 50}%` }}>☉</span>}
      {ready && (!home || orbit) && pins.map((item, index) => {
        if (!("point" in item.location)) return null;
        const position = diskPosition(item.location.point, center, zoom);
        if (!position) return null;
        const selectedPin = terrainView && target?.key === item.key;
        return <span key={item.key} className="site-pin" data-pin={index} data-site={item.key} data-leading={plannerLeaders?.includes(item.key)} style={{ left: `${(1 + position.x) * 50}%`, top: `${(1 + position.y) * 50}%`, zIndex: selectedPin ? 1 : undefined }}>
          <button type="button" title={item.name} aria-label={t("Inspect {site}", {site: item.name})}
            aria-pressed={orbit ? orbit.site.id === item.missionId : target?.key === item.key}
            onClick={event => {
              if (event.detail && pinGesture.current) return;
              if (orbit && item.missionId) orbit.onSite(item.missionId);
              locate(item);
            }}>{orbit ? item.name.split(" · ")[0] : plannerLeaders ? null : index + 1}</button>
        </span>;
      })}
    </div>;

  function expandGlobe() {
    const dialog = viewer.current;
    if (!dialog) return;
    dialog.close();
    dialog.showModal();
    setZoom(1);
    setRotating(false);
    setExpanded(true);
    dialog.querySelector<HTMLButtonElement>(".globe-close")?.focus();
  }

  function collapseGlobe() {
    const dialog = viewer.current;
    if (!dialog) return;
    dialog.close();
    dialog.show();
    setExpanded(false);
    expandButton.current?.focus({ preventScroll: true });
  }

  return <figure className={terrainView && !plannerLeaders ? "lunar-figure grid items-center gap-6 py-6 md:grid-cols-2" : "lunar-figure"}
    id={plannerLeaders ? "planner-lunar-globe" : terrainView ? "terrain-lunar-reference" : pairSites ? "pair-lunar-reference" : "lunar-reference"} tabIndex={-1}>
    {home ? frame : <div className="globe-view-slot">
      <dialog open ref={viewer} className="globe-view" role={expanded ? undefined : "group"} aria-label={t("Lunar surface globe")}
        onCancel={event => { event.preventDefault(); collapseGlobe(); }}>
        <div className="globe-full-bar">
          <strong>{target?.name ?? t("Lunar surface globe")}</strong>
          <button className="globe-close button outline" type="button" onClick={collapseGlobe}>{t(plannerLeaders ? "Back to planner" : "Close expanded view")}</button>
        </div>
        <div className="globe-viewport">{frame}</div>
        <div className="globe-full-footer">
          <div className="globe-controls">
            <button type="button" aria-label={t("Zoom out")} disabled={zoom === 1} onClick={() => setZoom(value => clampZoom(value / 2))}>−</button>
            <output>{zoom}×</output>
            <button type="button" aria-label={t("Zoom in")} disabled={zoom === 4} onClick={() => setZoom(value => clampZoom(value * 2))}>+</button>
          </div>
          <p id={zoomHelpId + "-expanded"}>{t("Tap a location to center it. Drag to rotate, or scroll or pinch over a location to zoom.")}</p>
        </div>
      </dialog>
      {ready && <button ref={expandButton} type="button" className="button outline globe-expand" aria-haspopup="dialog" onClick={expandGlobe}>{t("Expand globe")}</button>}
    </div>}
    {orbit ? <figcaption id="orbit-help">
      {ready ? t("Drag or use the arrow keys to rotate. Use + or − to zoom.") : failed ?
        t("Map unavailable. The photograph and site readings are still available.") : t("Lunar reference photograph")}
      {failed && <button type="button" onClick={() => { setFailed(false); setEnabled(true); }}>{t("Retry globe")}</button>}
      {ready && <><button type="button" onClick={() => { selectCenter(orbit.site); setZoom(1); }}>{t("Center on site")}</button>
        <span className="sr-only" role="status">{t("View center")} · {coordinates(center)} · {zoom}×</span></>}
    </figcaption> : <figcaption>
      {(!plannerLeaders || failed) && <button type="button" className="button outline" aria-expanded={enabled} onClick={() => {
        setRotating(false);
        setCenter(point ?? origin); setZoom(1); setAnnounced(null); setSunUtc(""); setReady(false); setFailed(false); setEnabled(!enabled);
      }}>{t(failed ? "Retry globe" : enabled ? "Return to photograph" : "Rotate the Moon")}</button>}
      {ready && <div className="globe-controls" role="group" aria-label={t("Rotate the lunar globe")}>
        {!home && !reducedMotion && <button type="button" onClick={() => setRotating(active => !active)}>{t(rotating ? "Pause rotation" : "Resume rotation")}</button>}
        {!home && directions.map(([, icon, label, dx, dy]) =>
          <button type="button" key={label} aria-label={t(label)} title={t(label)} onClick={() => selectCenter(globeCenter(center.longitude + dx, center.latitude + dy))}>{icon}</button>)}
        <button type="button" aria-label={t("Zoom out")} disabled={zoom === 1} onClick={() => { setRotating(false); setZoom(value => clampZoom(value / 2)); }}>−</button>
        <button type="button" aria-label={t("Zoom in")} disabled={zoom === 4} onClick={() => { setRotating(false); setZoom(value => clampZoom(value * 2)); }}>+</button>
        <button type="button" onClick={() => { setZoom(1); selectCenter(plannerLeaders ? point ?? origin : origin); }}>{t("Reset view")}</button>
      </div>}
      {ready && solarChoices.length > 0 && <div className="globe-sunlight">
        <label>{t("Modeled sunlight")}<select value={sun?.utc ?? ""} onChange={event => {
          const chosen = solarChoices.find(sample => sample.utc === event.target.value);
          setSunUtc(chosen?.utc ?? "");
          if (chosen) { setZoom(1); selectCenter(chosen); }
        }}>
          <option value="">{t("Reference map")}</option>
          {solarChoices.map(sample => <option key={sample.utc} value={sample.utc}>{t("Saved week start")} · {sample.utc.slice(0, 10)} 00:00 UTC</option>)}
        </select></label>
        {sun && <div id="globe-sunlight-description">
          <p>{t("☉ marks where the Sun appears directly overhead.")} {t("Subsolar point")} · {coordinates({ latitude: Number(sun.latitude.toFixed(2)), longitude: Number(sun.longitude.toFixed(2)) }, false)}</p>
          <p>{t("Smooth-sphere lighting at the selected UTC. Local terrain shadows are omitted.")}</p>
          {!sunMarker && <button type="button" onClick={() => { setZoom(1); selectCenter(sun); }}>{t("Show subsolar point")}</button>}
          <a href={sunlight.query} target="_blank" rel="noreferrer">JPL Horizons · {t("Sun direction")} ↗</a>
        </div>}
      </div>}
      {ready && <p id={zoomHelpId}>{t(home ? "Scroll or pinch to zoom the reference map (1–4×). With the globe focused, use + or − to zoom." : "Tap a location to center it. Drag to rotate, or scroll or pinch over a location to zoom.")}</p>}
      {ready && <p className="globe-center">{t("View center")} · {coordinates(center)} · {zoom}×</p>}
      <p role="status">{failed ? t("Globe unavailable. The photograph is shown. Try again to reload the map.") : enabled && !ready ? t("Loading lunar surface map…") :
        ready && announced ? <span className="sr-only">{t("View center")} · {coordinates(announced)}</span> : ""}</p>
      {ready ? <><a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">{t("LRO surface map")} · NASA’s Scientific Visualization Studio</a><br /><span id={home ? "home-globe-instructions" : undefined}>{t(home
          ? "Drag to turn the globe, or focus it and use the arrow keys. Return to the photograph for a still image. Lighting is fixed. This globe does not model terrain or calculate Sun/Earth visibility."
          : sun ? "Drag or use the arrows to rotate the sunlight map."
          : "Reference imagery with fixed lighting. Drag or use the arrows to rotate. This globe does not model terrain or calculate Sun/Earth visibility.")}</span></> :
        <><a href="https://svs.gsfc.nasa.gov/5001/" target="_blank" rel="noreferrer">LRO Moon mosaic · NASA’s Scientific Visualization Studio</a><br />{t("Context image, not current illumination or a selected-site view.")}</>}
      {!home && !plannerLeaders && <div className="globe-locator">
        {terrainView ? <label>{t("Inspect a site")}
          <select value={terrainSiteId} onChange={event => locate(targets.find(item => item.key === event.target.value))}>
            {targets.map((item, index) => <option key={item.key} value={item.key}>{index + 1} · {item.name}</option>)}
          </select>
        </label> : <div className="site-pin-key" role="group" aria-label={t("Locate a site")}>
          {pins.map((item, index) => <button type="button" key={item.key} data-pin={index}
            aria-pressed={target?.key === item.key} onClick={() => locate(item)}>
            <b>{index + 1}</b> {item.name}
            {"point" in item.location && <small>{coordinates(item.location.point, false)}</small>}
          </button>)}
        </div>}
        {!pairSites && <><label htmlFor="globe-site">{t("Location on the reference globe")}</label>
        <select id="globe-site" value={target?.key ?? ""} onChange={event => locate(targets.find(item => item.key === event.target.value))}>
          <option value="">{t("Choose a location")}</option>
          {primary && <optgroup label={t("Current comparison")}>{targets.filter(item => !item.source).map(item =>
            <option key={item.key} value={item.key}>{t(item.key)} · {item.name}</option>)}</optgroup>}
          <optgroup label={t("Mission references")}>{missionSites.map(mission => <option key={mission.name}>{mission.name}</option>)}</optgroup>
        </select></>}
        {target && <div className="globe-place">
          {"reason" in target.location ? <p>{t(target.location.reason)}</p> : <p>{t("Reported location")} · {target.location.point.latitude}° {t("latitude")} · {target.location.point.longitude}° {t("east longitude")}</p>}
          {point && ready && <><button type="button" className="button outline" onClick={() => selectCenter(point)}>{t("Center on site")}</button>
            <p>{t(marker ? "The marker shows the approximate site location." : "This location is outside the current view.")}</p></>}
          {target.missionId && <div className="site-week-readings">
            <strong>{t("Saved team model results")}</strong>
            {displayedWeeks.map(week => {
              const site = week.sites.find(s => s.id === target.missionId);
              if (!site) return null;
              const hours = (Date.parse(week.endUtc) - Date.parse(week.startUtc)) / 3600000;
              return <div className="site-week-range" key={week.startUtc}>
                <time dateTime={week.startUtc}>{t("Week of {date} UTC", { date: week.startUtc.slice(0, 10) })}</time>
                {([["Sun visible", site.sunHours], ["Earth visible", site.earthHours]] as const).map(([label, value]) =>
                  <label key={label}>{t(label)} · {value} / {hours} h
                    <meter min={0} max={hours} value={value} />
                  </label>)}
                <p>{site.overlap.duration_h} h {t("with both visible")}</p>
              </div>;
            })}
            <p>{t("Earth visibility describes a line of sight. Radio signal strength is unavailable.")}</p>
            <a href={showSky ? "#saved-model-source" : "/compare#saved-model-source"}>{t("Source and interval checks")}</a>
          </div>}
          {pairSites ? null : target.source ? <a href={target.source} target="_blank" rel="noreferrer">{t("Landing site source")} ↗</a> :
            <><a href="#local-sky" onClick={() => showSky?.(target.key === "Alternative")}>{t("Open this observation in 3D")}</a>{" · "}
              <a href="#sources">{t("Sources & method")}</a></>}
        </div>}
      </div>}
    </figcaption>}
  </figure>;
}

import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { drawGlobe, globeCenter, globePointAt, globeCenterForAnchor } from "../lib/moon-globe";
import { canvasPixels, createGlobeRenderer, frameScheduler, globeUniforms, viewStore } from "../lib/moon-globe-gl";
import type { GlobeRenderer, GlobeView, ViewStore } from "../lib/moon-globe-gl";
import { comparisonLocation, diskPosition, missionSites, pairCenter } from "../lib/globe-sites";
import type { GlobeSite, MapPoint, PairLocation } from "../lib/globe-sites";
import type { Dataset } from "../lib/dataset";
import { useLanguage } from "./language";
import { SitePinPicker, sitesAtPointer } from "./site-pin-picker";
import saved from "../lib/odysseus-athena-weeks.json";
import sunlight from "../lib/horizons-weekly-sunlight.json";
import catalog from "../public/data/run-b2/catalog.json";
import { sunlightStyle } from "../lib/sunlight-color";
import type { SunlightStyle } from "../lib/sunlight-color";
import SunlightLegend from "./sunlight-legend";
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
  plannerSun?: MapPoint & { utc: string };
  terrainView?: { siteId: string; reading?: string; onSelect: (id: string) => void; plannerLeaders?: readonly string[]; markerColors?: ReadonlyMap<string, string>; onCloseUp?: (point: MapPoint) => void };
  showSky?: (alternative: boolean) => void;
  // Sunlight share (0–100) per pin key for the period the page is showing; null marks a site with no value.
  sunlightPercent?: ReadonlyMap<string, number | null>;
};

// Share of 2026–2030 hours with the Sun above each catalog site's horizon (run B2).
const catalogSunlight = new Map<string, number>(catalog.sites.map(site => [site.id, site.pct_sun]));

type Target = {
  key: string;
  identity: GlobeSite | PairLocation | typeof missionSites[number];
  name: string;
  location: { point: MapPoint } | { reason: string };
  source?: string;
  missionId?: string;
};

// The 2K surface map, shared by every globe on the page. The WebP is about 40% smaller than the JPEG and is decoded
// off the main thread, so the texture upload does not block input; the JPEG through an <img> is the fallback.
let surfaceMap: Promise<ImageBitmap | HTMLImageElement> | undefined;
function loadSurfaceMap() {
  return surfaceMap ??= (async () => {
    try {
      const response = await fetch("/images/lroc-color-2k.webp");
      if (!response.ok) throw Error("Surface map unavailable");
      return await createImageBitmap(await response.blob(), { premultiplyAlpha: "none" });
    } catch {
      const image = new Image();
      image.src = "/images/lroc-color-2k.jpg";
      await image.decode();
      return image;
    }
  })().catch(error => { surfaceMap = undefined; throw error; });
}

type Painter = { gpu: boolean; draw(view: GlobeView, sun: MapPoint | undefined, size: number): void; dispose(): void };

// Overlays that must move with the globe read the live view, so a drag re-renders only this layer.
function LiveLayer({ store, children }: { store: ViewStore<GlobeView>; children: (view: GlobeView) => ReactNode }) {
  return children(useSyncExternalStore(store.subscribe, store.get, store.get));
}

export default function MoonGlobe({ home = false, orbit, primary, alternative, evidence, savedResult, pairSites, plannerSun, terrainView, showSky, sunlightPercent }: GlobeProps) {
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
  const sun = plannerSun ?? (orbit ? sunlight.samples.find(sample => sample.utc === orbit.weekUtc) : solarChoices.find(sample => sample.utc === sunUtc));
  const sunMarker = sun ? diskPosition(sun, center, zoom) : null;
  // Marker brightness: the page's period when it has one (planner results, or the saved week), else the 2026–2030 catalog value.
  const sunlightWeek = orbit ? saved.weeks.find(week => week.startUtc === orbit.weekUtc) : selectedWeek;
  const sunlightPeriod = sunlightPercent || (sunlightWeek && pins.some(item => item.missionId)) ? "period" as const : "average" as const;
  const pinSignature = pins.map(item => item.key + ":" + (item.missionId ?? ("id" in item.identity ? item.identity.id : ""))).join("|");
  // Colours are computed once per data change, never per frame.
  const pinSunlight = useMemo(() => new Map<string, SunlightStyle>(pinSignature.split("|").filter(Boolean).map(entry => {
    const split = entry.lastIndexOf(":"), key = entry.slice(0, split), id = entry.slice(split + 1);
    const weekSite = sunlightWeek?.sites.find(site => site.id === id);
    const percent = sunlightPercent ? sunlightPercent.get(key) ?? null
      : weekSite ? weekSite.sunHours / ((Date.parse(sunlightWeek!.endUtc) - Date.parse(sunlightWeek!.startUtc)) / 3600000) * 100
      : catalogSunlight.get(id) ?? null;
    return [key, sunlightStyle(percent)];
  })), [pinSignature, sunlightPercent, sunlightWeek]);
  const showPins = (!home || Boolean(orbit)) && pins.some(item => "point" in item.location);
  const viewer = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overlap, setOverlap] = useState<string[]>([]);
  const [gpu, setGpu] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const painter = useRef<Painter | null>(null);
  const paintInputs = useRef<{ sun?: MapPoint; expanded: boolean; cssWidth: number }>({ expanded: false, cssWidth: 0 });
  // The live view is what the canvas and pins show; center and zoom state follow it, throttled.
  const [store] = useState(() => viewStore<GlobeView>({ center: origin, zoom: 1 }));
  const synced = useRef<GlobeView>({ center: origin, zoom: 1 });
  const commitTimer = useRef<number | undefined>(undefined);
  const [frames] = useState(() => frameScheduler(() => {
    const view = painter.current;
    if (!view) return;
    const { sun, expanded, cssWidth } = paintInputs.current;
    const ratio = window.devicePixelRatio;
    view.draw(store.get(), sun, view.gpu ? canvasPixels(cssWidth, ratio, 384, 1536) : expanded ? canvasPixels(cssWidth, ratio, 384, 896) : 384);
  }));
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinGesture = useRef(false);
  const pinch = useRef<{ distance: number; zoom: number; anchor: MapPoint | null; center: MapPoint } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; scale: number; center: typeof origin; onPin: boolean } | null>(null);

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
    setZoom(1); setAnnounced(null); setSunUtc(""); setOverlap([]);
  }, [savedResult, pairSites, terrainSiteId]);

  const orbitSite = orbit?.site;
  useEffect(() => {
    if (orbitSite) { setCenter(orbitSite); setZoom(1); setRotating(false); }
  }, [orbitSite]);

  // Center or zoom set through React state (buttons, keys, site choices, props) moves the live view.
  // Values committed from the live view itself are skipped, so a late commit never pulls a drag back.
  useLayoutEffect(() => {
    const live = store.get();
    let next = live;
    if (center !== synced.current.center && center !== live.center) next = { ...next, center };
    if (zoom !== synced.current.zoom && zoom !== live.zoom) next = { ...next, zoom };
    synced.current = { center, zoom };
    if (next !== live) { store.set(next); frames.request(); }
  }, [center, zoom, store, frames]);

  useLayoutEffect(() => {
    paintInputs.current.sun = sun;
    paintInputs.current.expanded = expanded;
    frames.request();
  }, [sun, expanded, ready, frames]);

  useEffect(() => () => { frames.cancel(); window.clearTimeout(commitTimer.current); }, [frames]);

  function commitView() {
    window.clearTimeout(commitTimer.current);
    commitTimer.current = undefined;
    const view = store.get();
    if (view.center === synced.current.center && view.zoom === synced.current.zoom) return;
    if (view.center !== synced.current.center) setCenter(view.center);
    if (view.zoom !== synced.current.zoom) setZoom(view.zoom);
    synced.current = view;
  }
  // Gestures and rotation draw at most once per frame. A drag or pinch commits React state when it ends;
  // wheel zoom and rotation, which have no end event, commit a few times a second.
  function moveView(next: Partial<GlobeView>) {
    store.set({ ...store.get(), ...next });
    frames.request();
    if (commitTimer.current === undefined && !drag.current && !pinch.current) commitTimer.current = window.setTimeout(commitView, 250);
  }

  // On the home page the photograph is the first paint, and the globe (a 2K texture and WebGL setup) starts once the page has loaded.
  useEffect(() => {
    if (!home || document.readyState === "complete") { setEnabled(true); return; }
    const start = () => setEnabled(true);
    window.addEventListener("load", start, { once: true });
    return () => window.removeEventListener("load", start);
  }, [home]);

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
    let frame = 0, last = 0;
    let visible = false;
    function step(time: number) {
      // The reference map turns slowly, 2.88° per second: every frame with WebGL, twelve times a second on the CPU.
      if (last && painter.current?.gpu === false && time - last < 1000 / 12) {
        frame = requestAnimationFrame(step);
        return;
      }
      if (last) {
        const { center: now } = store.get();
        moveView({ center: globeCenter(now.longitude + 2.88 * Math.min(100, time - last) / 1000, now.latitude) });
        frames.flush();
      }
      last = time;
      frame = requestAnimationFrame(step);
    }
    function update() {
      cancelAnimationFrame(frame);
      last = 0;
      if (visible && !document.hidden) frame = requestAnimationFrame(step);
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
      cancelAnimationFrame(frame);
    };
  }, [ready, rotating, reducedMotion]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const surface = canvas.current;
    function unavailable() {
      if (active) { setFailed(true); setReady(false); setEnabled(false); }
    }
    // A lost WebGL context remounts the canvas (new key) and draws with the CPU projection instead.
    function fallBack() {
      if (active) { painter.current = null; setReady(false); setGpu(false); }
    }
    surface?.addEventListener("contextlost", unavailable);
    surface?.addEventListener("webglcontextlost", fallBack);
    async function load() {
      try {
        const map = await loadSurfaceMap();
        if (!active) return;
        if (!surface) throw Error("Canvas unavailable");
        if (gpu) {
          let renderer: GlobeRenderer | null;
          try { renderer = createGlobeRenderer(surface, map); } catch { fallBack(); return; }
          if (renderer) {
            const gl = renderer;
            painter.current = { gpu: true, dispose: () => gl.dispose(), draw: (view, sun, size) =>
              gl.draw(globeUniforms(view.center.longitude, view.center.latitude, view.zoom, size, size, sun), size, size) };
            frames.request(); frames.flush();
            setReady(true);
            return;
          }
        }
        const buffer = document.createElement("canvas");
        buffer.width = map.width; buffer.height = map.height;
        const source = buffer.getContext("2d", { willReadFrequently: true });
        const context = surface.getContext("2d");
        if (!source || !context) throw Error("Canvas unavailable");
        source.drawImage(map, 0, 0);
        const texture = source.getImageData(0, 0, buffer.width, buffer.height);
        let frame = context.createImageData(surface.width, surface.height);
        painter.current = { gpu: false, dispose() {}, draw(view, sun, size) {
          if (frame.width !== size) {
            surface.width = surface.height = size;
            frame = context.createImageData(size, size);
          }
          drawGlobe(texture, frame, view.center.longitude, view.center.latitude, view.zoom, sun);
          context.putImageData(frame, 0, 0);
        } };
        frames.request(); frames.flush();
        setReady(true);
      } catch { unavailable(); }
    }
    void load();
    return () => {
      active = false; drag.current = null; touches.current.clear(); pinch.current = null;
      painter.current?.dispose(); painter.current = null;
      surface?.removeEventListener("contextlost", unavailable);
      surface?.removeEventListener("webglcontextlost", fallBack);
    };
  }, [enabled, gpu, frames]);

  // Canvas pixels follow the displayed size; the next frame resizes and redraws in one step.
  useEffect(() => {
    const surface = canvas.current;
    if (!enabled || !surface) return;
    const observer = new ResizeObserver(([entry]) => {
      paintInputs.current.cssWidth = entry.contentRect.width;
      frames.request();
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [enabled, gpu, frames]);

  function diskCoordinates(clientX: number, clientY: number) {
    const box = canvas.current!.getBoundingClientRect();
    return { x: 2 * (clientX - box.left) / box.width - 1, y: 2 * (clientY - box.top) / box.height - 1 };
  }

  const wheelZoom = useEffectEvent((event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || !event.deltaY) return;
    const { center: now, zoom: current } = store.get();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.current!.clientHeight : 1);
    const scale = clampZoom(current * Math.exp(-Math.max(-400, Math.min(400, pixels)) * 0.003));
    if (scale === current) return;
    let next: GlobeView = { center: now, zoom: scale };
    if (!home) {
      const position = diskCoordinates(event.clientX, event.clientY);
      const anchor = globePointAt(now, current, position);
      if (!anchor) return;
      next = { center: globeCenterForAnchor(anchor, position, scale, now), zoom: scale };
    }
    event.preventDefault();
    setRotating(false); moveView(next);
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
    const live = store.get();
    if (touches.current.size === 2) {
      pinGesture.current = true;
      drag.current = null;
      const { distance, position } = fingerSpan();
      pinch.current = { distance, zoom: live.zoom, center: live.center, anchor: home ? null : globePointAt(live.center, live.zoom, position) };
      return;
    }
    drag.current = { onPin, id: event.pointerId, x: event.clientX, y: event.clientY, scale: 150 / (live.zoom * event.currentTarget.getBoundingClientRect().width), center: live.center };
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch.current && touches.current.size === 2) {
        const { distance, position } = fingerSpan();
        const next = clampZoom(pinch.current.zoom * distance / pinch.current.distance);
        moveView(pinch.current.anchor ? { center: globeCenterForAnchor(pinch.current.anchor, position, next, pinch.current.center), zoom: next } : { zoom: next });
        return;
      }
    }
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (start.onPin && !pinGesture.current) {
      if (Math.hypot(dx, dy) <= 4) return;
      pinGesture.current = true;
    }
    moveView({ center: globeCenter(start.center.longitude - dx * start.scale, start.center.latitude + dy * start.scale) });
  }
  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (touches.current.delete(event.pointerId)) pinch.current = null;
    commitView();
    const start = drag.current;
    if (start?.id !== event.pointerId) return;
    drag.current = null;
    if (!home && !start.onPin && event.type === "pointerup" && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 4) {
      const location = globePointAt(start.center, store.get().zoom, diskCoordinates(event.clientX, event.clientY));
      if (location) selectCenter(location);
    }
  }
  function selectCenter(next: typeof origin) {
    commitView();
    setRotating(false);
    setCenter(next); setAnnounced(next);
  }
  function zoomBy(factor: number) {
    commitView();
    setZoom(value => clampZoom(value * factor));
  }
  function turnBy(dx: number, dy: number) {
    const { center: now } = store.get();
    selectCenter(globeCenter(now.longitude + dx, now.latitude + dy));
  }

  function turnWithKeyboard(event: KeyboardEvent<HTMLCanvasElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (["+", "=", "-"].includes(event.key)) {
      event.preventDefault(); setRotating(false);
      zoomBy(event.key === "-" ? 0.5 : 2);
      return;
    }
    if (event.shiftKey) return;
    const direction = directions.find(([key]) => key === event.key);
    if (!direction) return;
    const [, , , dx, dy] = direction;
    event.preventDefault();
    turnBy(dx, dy);
  }

  function locate(item: Target | undefined) {
    setRotating(false);
    setChosen(item ? { key: item.key, identity: item.identity } : null);
    if (item) terrainView?.onSelect(item.key);
    if (item && !item.missionId) setSunUtc("");
    if (item && "point" in item.location) selectCenter(item.location.point);
  }

  function inspectPin(item: Target) {
    if (orbit && item.missionId) orbit.onSite(item.missionId);
    locate(item);
  }

  const frame = <div className={terrainView ? "lunar-frame w-full" : "lunar-frame"}
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      <img src="/images/moon-mosaic.jpg" srcSet="/images/moon-mosaic-640.webp 640w, /images/moon-mosaic.webp 1024w"
        sizes={home ? "(max-width: 760px) 260px, 380px" : expanded ? "100vw" : "(max-width: 760px) 90vw, 600px"} width="1024" height="1024" alt={ready ? "" : t("Photographic mosaic of the Moon, assembled from Lunar Reconnaissance Orbiter images.")}
        // Only the home and orbit pages open on this picture; elsewhere it sits further down and must not outrank the page's own content.
        fetchPriority={home || orbit ? "high" : "auto"} loading={home || orbit ? "eager" : "lazy"} />
      {enabled && <canvas key={gpu ? "webgl" : "cpu"} ref={canvas} width={384} height={384} hidden={!ready} role="img" aria-label={t("Lunar surface globe")}
        tabIndex={0} onKeyDown={turnWithKeyboard}
        aria-describedby={expanded ? zoomHelpId + "-expanded" + (plannerSun ? " expanded-planner-sun" : "") : orbit ? "orbit-help" : home ? "home-globe-instructions globe-zoom-help" : plannerSun ? "plan-sun-direction " + zoomHelpId : sun ? "globe-sunlight-description globe-zoom-help" : zoomHelpId} />}
      {ready && <LiveLayer store={store}>{view => {
        const sunAt = !orbit && sun ? diskPosition(sun, view.center, view.zoom) : null;
        return <>
      {sunAt && <span className="subsolar-marker" aria-hidden="true"
        style={{ left: `${(1 + sunAt.x) * 50}%`, top: `${(1 + sunAt.y) * 50}%` }}>☉</span>}
      {(!home || orbit) && pins.map((item, index) => {
        if (!("point" in item.location)) return null;
        const position = diskPosition(item.location.point, view.center, view.zoom);
        if (!position) return null;
        const selectedPin = terrainView && target?.key === item.key;
        const light = pinSunlight.get(item.key) ?? sunlightStyle(null);
        const sunText = light.percent === null ? t("Sunlight: no data") : t("Sunlight {percent}%", { percent: light.percent });
        return <span key={item.key} className="site-pin" data-pin={index} data-site={item.key} data-leading={plannerLeaders?.includes(item.key)}
          data-sunlight={light.percent ?? "none"} data-glow={light.glow || undefined}
          style={{ left: `${(1 + position.x) * 50}%`, top: `${(1 + position.y) * 50}%`, zIndex: selectedPin ? 1 : undefined, "--pin-sun": light.color, "--pin-ink": light.ink } as CSSProperties}>
          {terrainView?.markerColors && <i aria-hidden="true" className="plan-pin-sun-ring" style={{ borderColor: terrainView.markerColors.get(item.key) }} />}
          <button type="button" title={item.name + " · " + sunText} aria-label={t("Inspect {site}", {site: item.name}) + " · " + sunText}
            aria-pressed={orbit ? orbit.site.id === item.missionId : target?.key === item.key}
            onClick={event => {
              if (event.detail && pinGesture.current) return;
              const hits = sitesAtPointer(event);
              if (hits.length > 1) {
                setRotating(false);
                event.currentTarget.focus({ preventScroll: true });
                setOverlap(hits);
              } else inspectPin(item);
            }}>{orbit ? item.name.split(" · ")[0] : plannerLeaders ? null : index + 1}</button>
        </span>;
      })}
        </>;
      }}</LiveLayer>}
    </div>;

  const pinPicker = overlap.length > 1 && <SitePinPicker sites={pins.filter(pin => overlap.includes(pin.key)).map(pin => ({
    id: pin.key, name: pin.name, select: () => inspectPin(pin),
  }))} onClose={() => setOverlap([])} />;

  const centerOnSun = ready && plannerSun && !sunMarker && <button type="button" className="text-button" onClick={() => {
    selectCenter(plannerSun); setZoom(1);
  }}>{t("Show subsolar point")}</button>;

  function expandGlobe() {
    const dialog = viewer.current;
    if (!dialog) return;
    dialog.close();
    dialog.showModal();
    commitView();
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

  const closeUpButton = terrainView?.onCloseUp && <button type="button" className="button outline" onClick={() => {
    if (expanded) collapseGlobe();
    terrainView.onCloseUp?.(store.get().center);
  }}>{t("Close-up at map center")}</button>;

  return <figure className={terrainView && !plannerLeaders ? "lunar-figure grid items-center gap-6 py-6 md:grid-cols-2" : "lunar-figure"}
    id={plannerLeaders ? "planner-lunar-globe" : terrainView ? "terrain-lunar-reference" : pairSites ? "pair-lunar-reference" : "lunar-reference"} tabIndex={-1}>
    {home ? <>{frame}{pinPicker}</> : <div className="globe-view-slot">
      <dialog open ref={viewer} className="globe-view" aria-label={t("Lunar surface globe")}
        onCancel={event => { event.preventDefault(); collapseGlobe(); }}>
        <div className="globe-full-bar">
          <div aria-live="polite"><strong>{target?.name ?? t("Lunar surface globe")}</strong>
            {point && <small className="block">{terrainView && terrainView.siteId === target?.key && terrainView.reading
              ? terrainView.reading : coordinates(point, false)}</small>}
          </div>
          <button className="globe-close button outline" type="button" onClick={collapseGlobe}>{t(plannerLeaders ? "Back to planner" : "Close expanded view")}</button>
        </div>
        <div className="globe-viewport">{frame}</div>
        <div className="globe-full-footer">
          <div className="globe-controls">
            <button type="button" aria-label={t("Zoom out")} disabled={zoom === 1} onClick={() => zoomBy(0.5)}>−</button>
            <output>{zoom}×</output>
            <button type="button" aria-label={t("Zoom in")} disabled={zoom === 4} onClick={() => zoomBy(2)}>+</button>
          </div>
          {plannerSun && <p id="expanded-planner-sun">{t("☉ marks where the Sun appears directly overhead.")}{" "}
            <time dateTime={plannerSun.utc}>{plannerSun.utc.slice(0, 10)} 00:00 UTC</time> {centerOnSun}</p>}
          {closeUpButton}
          <p id={zoomHelpId + "-expanded"}>{t("Tap a location to center it. Drag to rotate, or scroll or pinch over a location to zoom.")}</p>
        </div>
        {pinPicker}
      </dialog>
      {ready && <button ref={expandButton} type="button" className="button outline globe-expand" aria-haspopup="dialog" onClick={expandGlobe}>{t("Expand globe")}</button>}
    </div>}
    {orbit ? <figcaption id="orbit-help">
      {ready ? t("Drag or use the arrow keys to rotate. Use + or − to zoom.") : failed ?
        t("Map unavailable. The photograph and site readings are still available.") : t("Lunar reference photograph")}
      {failed && <button type="button" onClick={() => { setFailed(false); setGpu(true); setEnabled(true); }}>{t("Retry globe")}</button>}
      {ready && <><button type="button" onClick={() => { selectCenter(orbit.site); setZoom(1); }}>{t("Center on site")}</button>
        <span className="sr-only" role="status">{t("View center")} · {coordinates(center)} · {zoom}×</span></>}
      {showPins && <SunlightLegend period={sunlightPeriod} missing={[...pinSunlight.values()].some(light => light.percent === null)} />}
    </figcaption> : <figcaption>
      {showPins && <SunlightLegend period={sunlightPeriod} missing={[...pinSunlight.values()].some(light => light.percent === null)} />}
      {(!plannerLeaders || failed) && <button type="button" className="button outline" aria-expanded={enabled} onClick={() => {
        commitView(); setRotating(false);
        setCenter(point ?? origin); setZoom(1); setAnnounced(null); setSunUtc(""); setReady(false); setFailed(false); setGpu(true); setEnabled(!enabled);
      }}>{t(failed ? "Retry globe" : enabled ? "Return to photograph" : "Rotate the Moon")}</button>}
      {ready && <div className="globe-controls" role="group" aria-label={t("Rotate the lunar globe")}>
        {!home && !reducedMotion && <button type="button" onClick={() => setRotating(active => !active)}>{t(rotating ? "Pause rotation" : "Resume rotation")}</button>}
        {!home && directions.map(([, icon, label, dx, dy]) =>
          <button type="button" key={label} aria-label={t(label)} title={t(label)} onClick={() => turnBy(dx, dy)}>{icon}</button>)}
        <button type="button" aria-label={t("Zoom out")} disabled={zoom === 1} onClick={() => { setRotating(false); zoomBy(0.5); }}>−</button>
        <button type="button" aria-label={t("Zoom in")} disabled={zoom === 4} onClick={() => { setRotating(false); zoomBy(2); }}>+</button>
        <button type="button" onClick={() => { selectCenter(plannerLeaders ? point ?? origin : origin); setZoom(1); }}>{t("Reset view")}</button>
      </div>}
      {centerOnSun}
      {ready && solarChoices.length > 0 && <div className="globe-sunlight">
        <label>{t("Modeled sunlight")}<select value={sun?.utc ?? ""} onChange={event => {
          const chosen = solarChoices.find(sample => sample.utc === event.target.value);
          setSunUtc(chosen?.utc ?? "");
          if (chosen) { selectCenter(chosen); setZoom(1); }
        }}>
          <option value="">{t("Reference map")}</option>
          {solarChoices.map(sample => <option key={sample.utc} value={sample.utc}>{t("Saved week start")} · {sample.utc.slice(0, 10)} 00:00 UTC</option>)}
        </select></label>
        {sun && <div id="globe-sunlight-description">
          <p>{t("☉ marks where the Sun appears directly overhead.")} {t("Subsolar point")} · {coordinates({ latitude: Number(sun.latitude.toFixed(2)), longitude: Number(sun.longitude.toFixed(2)) }, false)}</p>
          <p>{t("Smooth-sphere lighting at the selected UTC. Local terrain shadows are omitted.")}</p>
          {!sunMarker && <button type="button" onClick={() => { selectCenter(sun); setZoom(1); }}>{t("Show subsolar point")}</button>}
          <a href={sunlight.query} target="_blank" rel="noreferrer">JPL Horizons · {t("Sun direction")} ↗</a>
        </div>}
      </div>}
      {ready && <p id={zoomHelpId}>{t(home ? "Scroll or pinch to zoom the reference map (1–4×). With the globe focused, use + or − to zoom." : "Tap a location to center it. Drag to rotate, or scroll or pinch over a location to zoom.")}</p>}
      {ready && closeUpButton}
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

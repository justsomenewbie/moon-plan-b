import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { drawGlobe, globeCenter } from "../lib/moon-globe";
import { useLanguage } from "./language";

const origin = { longitude: 0, latitude: 0 };
const coordinates = (c: typeof origin) =>
  `${Math.abs(c.latitude).toFixed(0)}°${c.latitude < 0 ? "S" : "N"} · ${Math.abs(c.longitude).toFixed(0)}°${c.longitude < 0 ? "W" : "E"}`;

export default function MoonGlobe() {
  const { t } = useLanguage();
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [center, setCenter] = useState(origin);
  const [announced, setAnnounced] = useState<typeof origin | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<{ context: CanvasRenderingContext2D; texture: ImageData; frame: ImageData } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; scale: number; center: typeof origin } | null>(null);

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
        drawGlobe(texture, frame, 0, 0);
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
      drawGlobe(view.texture, view.frame, center.longitude, center.latitude);
      view.context.putImageData(view.frame, 0, 0);
    });
    return () => cancelAnimationFrame(id);
  }, [center]);

  function startDrag(event: PointerEvent<HTMLCanvasElement>) {
    if (!ready || !event.isPrimary || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setAnnounced(null);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, scale: 150 / event.currentTarget.getBoundingClientRect().width, center };
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

  return <figure className="lunar-figure">
    <div className="lunar-frame">
      <img src="/images/moon-mosaic.jpg" width="1024" height="1024" alt={ready ? "" : t("Photographic mosaic of the Moon, assembled from Lunar Reconnaissance Orbiter images.")} fetchPriority="high" />
      {enabled && <canvas ref={canvas} width={384} height={384} hidden={!ready} role="img" aria-label={t("Lunar surface globe")}
        onPointerDown={startDrag} onPointerMove={moveDrag}
        onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} />}
    </div>
    <figcaption>
      <button type="button" className="button outline" aria-expanded={enabled} onClick={() => {
        setCenter(origin); setAnnounced(null); setReady(false); setFailed(false); setEnabled(!enabled);
      }}>{t(failed ? "Retry globe" : enabled ? "Return to photograph" : "Rotate the Moon")}</button>
      {ready && <div className="globe-controls" role="group" aria-label={t("Rotate the lunar globe")}>
        {([["←", "Look west", -30, 0], ["→", "Look east", 30, 0], ["↑", "Look north", 0, 30], ["↓", "Look south", 0, -30]] as const).map(([icon, label, dx, dy]) =>
          <button type="button" key={label} aria-label={t(label)} title={t(label)} onClick={() => selectCenter(globeCenter(center.longitude + dx, center.latitude + dy))}>{icon}</button>)}
        <button type="button" onClick={() => selectCenter(origin)}>{t("Reset view")}</button>
      </div>}
      {ready && <p className="globe-center">{t("View center")} · {coordinates(center)}</p>}
      <p role="status">{failed ? t("Globe unavailable. The photograph is shown. Try again to reload the map.") : enabled && !ready ? t("Loading lunar surface map…") :
        ready && announced ? <span className="sr-only">{t("View center")} · {coordinates(announced)}</span> : ""}</p>
      {ready ? <><a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">{t("LRO surface map")} · NASA’s Scientific Visualization Studio</a><br />{t("Reference imagery with fixed lighting. Drag or use the arrows to rotate. This globe does not model terrain or calculate Sun/Earth visibility.")}</> :
        <><a href="https://svs.gsfc.nasa.gov/5001/" target="_blank" rel="noreferrer">LRO Moon mosaic · NASA’s Scientific Visualization Studio</a><br />{t("Context image, not current illumination or a selected-site view.")}</>}
    </figcaption>
  </figure>;
}

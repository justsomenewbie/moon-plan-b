"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { diskPosition, type MapPoint, type PairLocation } from "../../lib/globe-sites";
import { drawGlobe, globeCenter } from "../../lib/moon-globe";
import { useLanguage } from "../language";

type Props = {
  sites: readonly PairLocation[];
  leaders: readonly string[];
  selectedId: string;
  focusRequest: number;
  onSelect: (id: string) => void;
  zoom: number;
  onZoom: (zoom: number) => void;
  onUnavailable: () => void;
};

const size = 384;
const origin = { longitude: 0, latitude: 0 };
const mapUrl = "/images/lroc-color-2k.jpg";
const arrows: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
};

export default function SiteGlobe({ sites, leaders, selectedId, focusRequest, onSelect, zoom, onZoom, onUnavailable }: Props) {
  const { t } = useLanguage();
  const selected = sites.find(site => site.id === selectedId);
  const target = selected && "point" in selected.location ? selected.location.point : origin;
  // Keep a manual rotation only while inspecting the same site and source coordinates.
  const [rotation, setRotation] = useState<{ id: string; at: MapPoint; center: MapPoint } | null>(null);
  const center = rotation?.id === selectedId && rotation.at.latitude === target.latitude &&
    rotation.at.longitude === target.longitude ? rotation.center : target;
  const scale = Math.max(1, Math.min(8, zoom));
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<{ context: CanvasRenderingContext2D; texture: ImageData; frame: ImageData } | null>(null);
  const [ready, setReady] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; factor: number; from: MapPoint; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const fallback = useEffectEvent(onUnavailable);

  useEffect(() => {
    setRotation(null);
    drag.current = null;
  }, [selectedId, target.latitude, target.longitude, focusRequest]);

  useEffect(() => {
    const surface = canvas.current;
    if (!surface) return;
    let active = true;
    function unavailable() { if (active) fallback(); }
    surface.addEventListener("contextlost", unavailable);
    async function loadMap() {
      try {
        const photo = new Image();
        photo.src = mapUrl;
        await photo.decode();
        if (!active) return;
        const buffer = document.createElement("canvas");
        buffer.width = photo.naturalWidth;
        buffer.height = photo.naturalHeight;
        const source = buffer.getContext("2d", { willReadFrequently: true });
        const context = surface?.getContext("2d");
        if (!source || !context) { unavailable(); return; }
        source.drawImage(photo, 0, 0);
        renderer.current = {
          context,
          texture: source.getImageData(0, 0, buffer.width, buffer.height),
          frame: context.createImageData(size, size),
        };
        setReady(true);
      } catch { unavailable(); }
    }
    void loadMap();
    return () => {
      active = false;
      surface.removeEventListener("contextlost", unavailable);
      renderer.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const frameId = requestAnimationFrame(() => {
      const view = renderer.current;
      if (!view) return;
      try {
        drawGlobe(view.texture, view.frame, center.longitude, center.latitude, scale);
        view.context.putImageData(view.frame, 0, 0);
      } catch { fallback(); }
    });
    return () => cancelAnimationFrame(frameId);
  }, [ready, center.longitude, center.latitude, scale]);

  function turn(longitude: number, latitude: number) {
    setRotation({ id: selectedId, at: target, center: globeCenter(longitude, latitude) });
  }
  function keyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    const step = 15 / scale;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = arrows[event.key];
    if (direction) turn(center.longitude + direction[0] * step, center.latitude + direction[1] * step);
    else if (event.key === "+" || event.key === "=") onZoom(Math.min(8, scale * 2));
    else if (event.key === "-") onZoom(Math.max(1, scale / 2));
    else if (event.key === "Home") setRotation(null);
    else return;
    event.preventDefault();
  }
  function start(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick.current = false;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY,
      factor: 140 / (event.currentTarget.getBoundingClientRect().width * scale), from: center, moved: false };
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const gesture = drag.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      if (event.pointerType === "touch" && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null;
        return;
      }
      gesture.moved = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    turn(gesture.from.longitude - dx * gesture.factor, gesture.from.latitude + dy * gesture.factor);
  }
  function end(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id === event.pointerId) drag.current = null;
  }
  function choose(site: PairLocation) {
    setRotation(null);
    onSelect(site.id);
  }

  const pins = sites.flatMap(site => {
    if (!("point" in site.location)) return [];
    const position = diskPosition(site.location.point, center, scale);
    if (!position) return [];
    return [{ site, position, leader: leaders.includes(site.id) }];
  }).sort((a, b) => Number(a.site.id === selectedId) - Number(b.site.id === selectedId) ||
    Number(a.leader) - Number(b.leader));

  return <div className="plan-globe" onPointerDown={start} onPointerMove={move} onPointerUp={end}
    onPointerCancel={end} onLostPointerCapture={event => { if (event.target === event.currentTarget) end(event); }}
    onPointerLeave={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) end(event); }}
    style={{ position: "relative", width: "100%", aspectRatio: "1", touchAction: "pan-y pinch-zoom", userSelect: "none" }}>
    <canvas ref={canvas} width={size} height={size} className="plan-globe-canvas" tabIndex={0}
      aria-label={t("Rotate the lunar globe")} onKeyDown={keyDown}
      style={{ display: "block", width: "100%", height: "100%", borderRadius: "50%", cursor: "grab" }} />
    {!ready && <span role="status" style={{ position: "absolute", insetInlineStart: 0, top: "50%" }}>{t("Loading lunar surface map…")}</span>}
    {ready && <svg className="plan-globe-pins" viewBox={`0 0 ${size} ${size}`} role="group"
      aria-label={t("Sites on the Moon")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
      {pins.map(({ site, position, leader }) => {
        const active = site.id === selectedId;
        return <g className="plan-map-point" data-site={site.id} key={site.id} role="button" tabIndex={0}
          aria-label={t("Inspect {site}", { site: site.name })} aria-pressed={active}
          transform={`translate(${size / 2 * (1 + position.x)} ${size / 2 * (1 + position.y)})`}
          style={{ pointerEvents: "all", cursor: "pointer" }}
          onClick={event => { if (!suppressClick.current || !event.detail) choose(site); }}
          onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(site); }
          }}>
          <title>{site.name}</title>
          <circle r="12" fill="transparent" />
          {leader ? <path className="map-leader" d="M0 -7 7 0 0 7 -7 0Z" />
            : <circle className="map-other" r="4" />}
          {active && <circle r="10" stroke="white" strokeWidth="1.5" fill="none" pointerEvents="none" />}
        </g>;
      })}
    </svg>}
  </div>;
}

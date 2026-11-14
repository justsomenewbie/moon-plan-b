"use client";

import { useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { sampleAt } from "../lib/dataset";
import type { Dataset, Scenario } from "../lib/dataset";
import { skyPoint } from "../lib/local-sky";
import { useLanguage } from "./language";
import "./globe-comparison.css";

const radius = 104;
const meridians = [0, 30, 60, 90, 120, 150];
const compass = ["N", "E", "S", "W"] as const;
const bodies = [["sun", "Sun"], ["earth", "Earth"]] as const;

function point(az: number, el: number, orbit: number) {
  const { x, y } = skyPoint(az, el, orbit);
  return { x: radius * x, y: radius * y };
}

function arc(orbit: number, at: (angle: number) => [number, number], end: number) {
  const points: string[] = [];
  for (let i = 0; i <= end; i += 5) {
    const [az, el] = at(i);
    const { x, y } = point(az, el, orbit);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return points.join(" ");
}

export default function LocalSky({ data, a, b, offset, alternative, setAlternative }: {
  data: Dataset; a: Scenario; b?: Scenario; offset?: number;
  alternative: boolean; setAlternative: (useAlternative: boolean) => void;
}) {
  const { t } = useLanguage();
  const [orbit, setOrbit] = useState(0);
  const grid = useMemo(() => ({
    meridians: meridians.map(az => ({
      az, upper: arc(orbit, el => [az, el], 180), lower: arc(orbit, el => [az, -el], 180),
    })),
    parallel: arc(orbit, az => [az, 45], 360),
    horizon: arc(orbit, az => [az, 0], 360),
  }), [orbit]);
  const drag = useRef<{ id: number; x: number; orbit: number; width: number } | null>(null);
  function startOrbit(event: PointerEvent<SVGSVGElement>) {
    if (!event.isPrimary || event.button !== 0 || (event.target as Element).closest("[data-sky-body]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, orbit, width: event.currentTarget.getBoundingClientRect().width };
  }
  function moveOrbit(event: PointerEvent<SVGSVGElement>) {
    const start = drag.current;
    if (start?.id !== event.pointerId) return;
    const degrees = start.orbit - 180 * (event.clientX - start.x) / start.width;
    setOrbit(((Math.round(degrees / 5) * 5) % 360 + 360) % 360);
  }
  function endOrbit(event: PointerEvent<SVGSVGElement>) {
    if (drag.current?.id === event.pointerId) drag.current = null;
  }
  const observations = (b ? [a, b] : [a]).map((scenario, index) => ({
    scenario, site: data.sites.find(site => site.id === scenario.siteId)!,
    sample: offset === undefined ? undefined : sampleAt(scenario, offset),
    label: index === 0 ? "A" : "B",
  }));
  const selected = alternative && b ? 1 : 0;
  const { scenario, site, sample } = observations[selected];
  return <section className="local-sky" id="local-sky" aria-labelledby="local-sky-title" tabIndex={-1}>
    <div className="local-sky-heading"><h2 id="local-sky-title">{t("Local sky in 3D")}</h2>
      {b && <div role="group" className="sky-scenario-key" aria-label={t("Inspect observation")}>
        {observations.map(({ label, site, scenario }, index) => <button type="button" key={scenario.id}
          data-site={label} aria-pressed={selected === index} onClick={() => setAlternative(index === 1)}>
          <b>{label}</b> {site.name}{a.siteId === b.siteId && <small>{scenario.startUtc}</small>}
        </button>)}
      </div>}</div>
    <div className="sky-stage">
      <svg viewBox="-150 -126 300 252" onPointerDown={startOrbit} onPointerMove={moveOrbit}
        onPointerUp={endOrbit} onPointerCancel={endOrbit} onLostPointerCapture={endOrbit} role="group" aria-label={t("Sun and Earth directions around the local horizon")}>
        <circle r={radius} className="sky-shell" />
        {grid.meridians.map(({ az, upper, lower }) => <g key={az} className="sky-mesh">
          <polyline points={upper} />
          <polyline points={lower} strokeDasharray="2 5" />
        </g>)}
        <polyline className="sky-mesh" points={grid.parallel} />
        <polyline className="sky-ring" points={grid.horizon} />
        {compass.map((dir, i) => {
          const p = point(i * 90, 0, orbit);
          return <text key={dir} x={p.x * 1.13} y={p.y * 1.2} dy=".35em" textAnchor="middle" className="sky-bearing">{t(dir)}</text>;
        })}
        <circle r="2.5" className="sky-observer" />
        {observations.map(({ label, site, scenario, sample: reading }, index) => bodies.map(([key, name]) => {
          const angles = reading?.[key];
          if (!angles) return null;
          const { x, y } = point(angles.azimuthDeg, angles.elevationDeg, orbit);
          const description = `${label} · ${site.name} · ${t(name)} · ${reading!.utc}`;
          const inspect = () => setAlternative(index === 1);
          return <g key={scenario.id + key} data-site={label} className="sky-ray">
            <line x1="0" y1="0" x2={x} y2={y} stroke="currentColor" strokeWidth="1.5" strokeDasharray={angles.elevationDeg < 0 ? "3 3" : undefined} />
            <g transform={`translate(${x} ${y})`} data-sky-body={key} role="button" tabIndex={0}
              aria-label={description} aria-pressed={selected === index} onClick={inspect} onKeyDown={event => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspect(); }
              }}>
              <title>{description}</title>
              <circle r="9" fill="transparent" />
              {key === "sun" ? <circle r="5" fill="currentColor" stroke="var(--bg)" /> :
                <rect x="-4.5" y="-4.5" width="9" height="9" fill="currentColor" stroke="var(--bg)" />}
              <text x={index === 0 ? -7 : 7} y={index === 0 ? -6 : 10} textAnchor={index === 0 ? "end" : "start"}>{label}</text>
            </g>
          </g>;
        }))}
      </svg>
      <div className="sky-info" aria-label={t("Selected observation")}>
        <strong>{observations[selected].label} · {site.name}</strong>
        <p className="muted text-sm">{t(data.evidence === "synthetic-fixture" ? "Synthetic release" : "Dataset")} · {scenario.id}</p>
        {sample ? <time dateTime={sample.utc}>{sample.utc}</time> : <p>{t("No shared samples")}</p>}
        <dl>{bodies.map(([key, name]) => {
          const v = sample?.[key];
          return <div key={key}><dt className={key}>{t(name)}</dt>
            <dd>{v ? <>{t(v.elevationDeg < 0 ? "Below horizon" : v.elevationDeg > 0 ? "Above horizon" : "On horizon")}<br/>
              <span>{t("Az")} {v.azimuthDeg}° · {t("El")} {v.elevationDeg}°</span></> : t("Unavailable")}</dd></div>;
        })}</dl>
      </div>
    </div>
    <div className="sky-orbit"><label htmlFor="sky-orbit-input">{t("Rotate sky view")}</label><input id="sky-orbit-input" type="range" min="0" max="360" step="5" value={orbit}
      aria-valuetext={`${orbit}°`} onChange={e => setOrbit(Number(e.target.value))} /><span className="mono" aria-hidden="true">{orbit}°</span></div>
    {b && <p className="muted text-xs">{t("A and B use their own local north and horizon at the same elapsed time. Circle: Sun. Square: Earth. Select a marker or a name for its readings.")}</p>}
    <p className="muted text-xs">{t("The ring marks the ideal horizon. Dashed rays point below it. The timeline selects the observation. Local terrain is omitted.")}</p>
  </section>;
}

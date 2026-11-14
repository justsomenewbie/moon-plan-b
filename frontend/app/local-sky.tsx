"use client";

import { useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { sampleAt } from "../lib/dataset";
import type { Dataset, Scenario } from "../lib/dataset";
import { skyPoint } from "../lib/local-sky";
import { analyzeScenarioClearance, clampClearanceDeg, computeLanderHud } from "../lib/mission-studio";
import type { MissionOpState } from "../lib/mission-studio";
import { useLanguage } from "./language";
import "./globe-comparison.css";

const radius = 104;
const meridians = [0, 30, 60, 90, 120, 150];
const compass = ["N", "E", "S", "W"] as const;
const bodies = [["sun", "Sun"], ["earth", "Earth"]] as const;
const clearancePresets = [0, 2, 3, 5];
const referenceDurations = [6, 12, 24, 100];
const opStateLabels: Record<MissionOpState, string> = {
  golden: "Sun and Earth above",
  "solar-only": "Only Sun above",
  "comms-only": "Only Earth above",
  blackout: "Neither above",
  unavailable: "Unavailable",
};

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

function polarXY(cx: number, cy: number, r: number, azDeg: number) {
  const rad = (azDeg - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export default function LocalSky({
  data,
  a,
  b,
  offset,
  alternative,
  setAlternative,
  clearanceDeg: externalClearance,
  setClearanceDeg: setExternalClearance,
}: {
  data: Dataset;
  a: Scenario;
  b?: Scenario;
  offset?: number;
  alternative: boolean;
  setAlternative: (useAlternative: boolean) => void;
  clearanceDeg?: number;
  setClearanceDeg?: (deg: number) => void;
}) {
  const { t, locale } = useLanguage();
  const numbers = useMemo(() => new Intl.NumberFormat(locale, { maximumSignificantDigits: 4, useGrouping: false }), [locale]);
  const [openIntervals, setOpenIntervals] = useState<string | null>(null);
  const [orbit, setOrbit] = useState(0);
  const [internalClearance, setInternalClearance] = useState(0);
  const [referenceHours, setReferenceHours] = useState(12);
  const clearanceDeg = clampClearanceDeg(externalClearance ?? internalClearance);
  const updateClearance = (next: number) => {
    const clamped = clampClearanceDeg(next);
    setInternalClearance(clamped);
    setExternalClearance?.(clamped);
  };

  const grid = useMemo(() => ({
    meridians: meridians.map(az => ({
      az, upper: arc(orbit, el => [az, el], 180), lower: arc(orbit, el => [az, -el], 180),
    })),
    parallel: arc(orbit, az => [az, 45], 360),
    horizon: arc(orbit, az => [az, 0], 360),
    clearance: clearanceDeg > 0 ? arc(orbit, az => [az, clearanceDeg], 360) : "",
  }), [orbit, clearanceDeg]);

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

  const summaries = useMemo(() => (b ? [a, b] : [a]).map(scenario =>
    analyzeScenarioClearance(scenario, clearanceDeg, referenceHours)), [a, b, clearanceDeg, referenceHours]);
  const observations = (b ? [a, b] : [a]).map((scenario, index) => ({
    scenario,
    site: data.sites.find(site => site.id === scenario.siteId)!,
    sample: offset === undefined ? undefined : sampleAt(scenario, offset),
    label: index === 0 ? "A" : "B",
    summary: summaries[index],
  }));
  const selected = alternative && b ? 1 : 0;
  const { scenario, site, sample } = observations[selected];
  const hud = computeLanderHud(sample, clearanceDeg);

  const sunTarget = hud.sunAzimuthDeg !== null ? polarXY(90, 90, 62, hud.sunAzimuthDeg) : null;
  const earthTarget = hud.earthAzimuthDeg !== null ? polarXY(90, 90, 62, hud.earthAzimuthDeg) : null;
  const shadowTarget = hud.shadowAzimuthDeg !== null ? polarXY(90, 90, 56, hud.shadowAzimuthDeg) : null;

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
        {grid.clearance && <polyline className="sky-clearance-ring" points={grid.clearance} strokeDasharray="4 3" />}
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
          const belowMask = angles.elevationDeg <= clearanceDeg;
          return <g key={scenario.id + key} data-site={label} className="sky-ray">
            <line x1="0" y1="0" x2={x} y2={y} stroke="currentColor" strokeWidth="1.5" strokeDasharray={belowMask ? "3 3" : undefined} />
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
            <dd>{v ? <>{t(v.elevationDeg < 0 ? "Below horizon" : v.elevationDeg > 0 ? "Above horizon" : "On horizon")}
              {clearanceDeg > 0 && <> · <span>{t(v.elevationDeg > clearanceDeg ? "Above threshold" : "At or below threshold")}</span></>}<br/>
              <span>{t("Az")} {v.azimuthDeg}° · {t("El")} {v.elevationDeg}°</span></> : t("Unavailable")}</dd></div>;
        })}</dl>
      </div>
    </div>
    <div className="sky-orbit"><label htmlFor="sky-orbit-input">{t("Rotate sky view")}</label><input id="sky-orbit-input" type="range" min="0" max="360" step="5" value={orbit}
      aria-valuetext={`${orbit}°`} onChange={e => setOrbit(Number(e.target.value))} /><span className="mono" aria-hidden="true">{orbit}°</span></div>
    {b && <p className="muted text-xs">{t("A and B use their own local north and horizon at the same elapsed time. Circle: Sun. Square: Earth. Select a marker or a name for its readings.")}</p>}
    <p className="muted text-xs">{t("The solid ring marks the ideal 0° horizon. Dashed rays indicate a body at or below the selected angle. The sky uses the selected observation and omits local terrain.")}</p>

    <div className="mission-studio" aria-labelledby="mission-studio-title">
      <div className="mission-studio-header">
        <h3 id="mission-studio-title">{t("Explore a hypothetical horizon")}</h3>
        <span className="mono clearance-badge">θ_mask = {clearanceDeg.toFixed(1)}°</span>
      </div>
      <p className="muted text-xs">
        {t("The ribbon estimates when each body’s elevation is strictly above the selected angle. It assumes elevation changes linearly between adjacent valid samples. Hatched spans lack data. The timeline bands show the original intervals supplied with the dataset.")}
      </p>

      <div className="clearance-controls">
        <div className="sky-orbit">
          <label htmlFor="horizon-clearance-input">{t("Hypothetical elevation threshold")}</label>
          <input
            id="horizon-clearance-input"
            type="range"
            min="0"
            max="10"
            step="0.5"
            value={clearanceDeg}
            aria-valuetext={`${clearanceDeg.toFixed(1)}°`}
            onChange={e => updateClearance(Number(e.target.value))}
          />
          <span className="mono" aria-hidden="true">{clearanceDeg.toFixed(1)}°</span>
        </div>
        <div className="preset-pills" role="group" aria-label={t("Clearance presets")}>
          {clearancePresets.map(deg => (
            <button
              type="button"
              key={deg}
              className="preset-pill"
              aria-pressed={clearanceDeg === deg}
              onClick={() => updateClearance(deg)}
            >
              {deg}°{deg === 0 && ` · ${t("Ideal horizon")}`}
            </button>
          ))}
        </div>
      </div>

      <div className="studio-grid">
        <div className="mission-ribbon-card">
          <div className="mission-card-head">
            <h4>{t("Estimated time above threshold")}</h4>
            <label className="battery-picker">
              <span>{t("Reference duration")}</span>
              <select value={referenceHours} onChange={e => setReferenceHours(Number(e.target.value))}>
                {referenceDurations.map(hours => <option key={hours} value={hours}>{hours} h</option>)}
              </select>
            </label>
          </div>
          <p className="muted text-xs">{t("Compare the longest span with the Sun at or below the threshold against a duration you choose. Power, battery charge and Earth link performance require separate models.")}</p>
          <div className="state-legend">
            {Object.entries(opStateLabels).map(([state, label]) => <span key={state} className={`state-dot ${state}`}>{t(label)}</span>)}
          </div>
          <div className="mission-scenarios">
            {observations.map(({ label, site: sSite, scenario: sc, summary }) => (
              <div key={sc.id} className="mission-scenario-row">
                <div className="mission-scenario-meta">
                  <strong>{label} · {sSite.name}</strong>
                  <span className={`battery-badge ${summary.batteryStatus}`}>
                    {summary.batteryStatus === "safe"
                      ? t("Within reference duration")
                      : summary.batteryStatus === "risk"
                        ? t("Exceeds reference duration")
                        : t("Incomplete coverage")}
                  </span>
                </div>
                <div className="mission-ribbon" role="img" aria-label={t("{site} · estimated elevation states at {angle}° · {coverage}", {
                  site: `${label} · ${sSite.name}`, angle: numbers.format(clearanceDeg),
                  coverage: t(summary.segments.length === 0 ? "Unavailable" : summary.coverage === "complete" ? "Complete coverage" : "Incomplete coverage"),
                })}>
                  {summary.segments.length === 0 ? (
                    <span className="ribbon-empty">{t("Unavailable")}</span>
                  ) : (
                    summary.segments.map((seg, idx) => (
                      <span
                        key={`${seg.startUtc}-${idx}`}
                        className={`ribbon-seg ${seg.state}`}
                        style={{ left: `${seg.startPct}%`, width: `${seg.widthPct}%` }}
                        title={`${t(opStateLabels[seg.state])}: ${seg.startUtc} → ${seg.endUtc} (${numbers.format(seg.durationHours)} h)`}
                      />
                    ))
                  )}
                </div>
                {summary.segments.length > 0 && <details className="mission-intervals" onToggle={event => {
                  const open = event.currentTarget.open;
                  setOpenIntervals(current => open ? sc.id : current === sc.id ? null : current);
                }} open={openIntervals === sc.id}>
                  <summary>{t("Read estimated intervals in UTC")}</summary>
                  {openIntervals === sc.id && <ul>{summary.segments.map(seg =>
                    <li key={seg.startUtc}>{t(opStateLabels[seg.state])} · {seg.startUtc} → {seg.endUtc}</li>)}</ul>}
                </details>}
                {summary.coverage === "complete" ? (
                  <dl className="mission-metrics-row">
                    <div><dt>{t(opStateLabels.golden)}</dt><dd>{numbers.format(summary.goldenHours!)} h</dd></div>
                    <div><dt>{t(opStateLabels["solar-only"])}</dt><dd>{numbers.format(summary.solarOnlyHours!)} h</dd></div>
                    <div><dt>{t(opStateLabels["comms-only"])}</dt><dd>{numbers.format(summary.commsOnlyHours!)} h</dd></div>
                    <div><dt>{t("Longest span with Sun at or below threshold / reference")}</dt><dd>{numbers.format(summary.longestSolarDarknessHours!)} h / {referenceHours} h</dd></div>
                  </dl>
                ) : (
                  <p className="muted text-xs">{t("Duration totals require complete coverage.")}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="lander-hud-card">
          <h4>{t("Directions at the selected sample")} · {observations[selected].label}</h4>
          <div className="lander-hud-body">
            <svg viewBox="0 0 180 180" className="lander-hud-svg" role="img" aria-label={t("Sun, Earth and ideal shadow bearings viewed from above")}>
              <circle cx="90" cy="90" r="72" className="hud-compass-ring" />
              <circle cx="90" cy="90" r="46" className="hud-inner-ring" strokeDasharray="2 3" />
              <text x="90" y="12" textAnchor="middle" className="sky-bearing">{t("N")}</text>
              <text x="168" y="93" textAnchor="middle" className="sky-bearing">{t("E")}</text>
              <text x="90" y="174" textAnchor="middle" className="sky-bearing">{t("S")}</text>
              <text x="12" y="93" textAnchor="middle" className="sky-bearing">{t("W")}</text>

              {shadowTarget && (
                <line
                  x1="90"
                  y1="90"
                  x2={shadowTarget.x}
                  y2={shadowTarget.y}
                  className="hud-shadow-ray"
                  strokeWidth="8"
                  strokeLinecap="round"
                />
              )}

              {sunTarget && (
                <g className="hud-sun-group">
                  <line x1="90" y1="90" x2={sunTarget.x} y2={sunTarget.y} className="hud-sun-ray" strokeDasharray={hud.sunClearsMask ? undefined : "3 3"} />
                  <circle cx={sunTarget.x} cy={sunTarget.y} r="6" className="hud-sun-node" />
                </g>
              )}

              {earthTarget && (
                <g className="hud-earth-group">
                  <line x1="90" y1="90" x2={earthTarget.x} y2={earthTarget.y} className="hud-earth-ray" strokeDasharray={hud.earthClearsMask ? undefined : "3 3"} />
                  <rect x={earthTarget.x - 5} y={earthTarget.y - 5} width="10" height="10" className="hud-earth-node" />
                </g>
              )}

              {sunTarget && <g transform={`translate(90 90) rotate(${hud.sunAzimuthDeg})`}>
                <rect x="-24" y="-3" width="14" height="6" rx="1" className="hud-solar-wing" />
                <rect x="10" y="-3" width="14" height="6" rx="1" className="hud-solar-wing" />
              </g>}

              {earthTarget && <g transform={`translate(90 90) rotate(${hud.earthAzimuthDeg})`}>
                <path d="M -5 -10 Q 0 -15 5 -10" fill="none" className="hud-dish-arc" strokeWidth="2" />
                <line x1="0" y1="0" x2="0" y2="-12" className="hud-dish-boom" strokeWidth="1.5" />
              </g>}

              <polygon points="90,82 97,87 95,96 85,96 83,87" className="hud-lander-deck" />
            </svg>

            <dl className="hud-readouts">
              <div>
                <dt>{t("Bodies above threshold")}</dt>
                <dd><strong>{t(opStateLabels[hud.opState])}</strong></dd>
              </div>
              <div>
                <dt>{t("Sun direction")}</dt>
                <dd className="mono">{hud.sunAzimuthDeg !== null ? `${t("Az")} ${hud.sunAzimuthDeg}° · ${t("El")} ${hud.sunElevationDeg}°` : t("Unavailable")}</dd>
              </div>
              <div>
                <dt>{t("Earth direction")}</dt>
                <dd className="mono">{hud.earthAzimuthDeg !== null ? `${t("Az")} ${hud.earthAzimuthDeg}° · ${t("El")} ${hud.earthElevationDeg}°` : t("Unavailable")}</dd>
              </div>
              <div>
                <dt>{t("Azimuth separation (ΔAz)")}</dt>
                <dd className="mono">{hud.azimuthSeparationDeg !== null ? `${hud.azimuthSeparationDeg}°` : t("Unavailable")}</dd>
              </div>
              <div>
                <dt>{t("Shadow of a vertical object on level ground")}</dt>
                <dd className="mono">
                  {hud.shadowAzimuthDeg !== null && hud.shadowLengthFactor !== null
                    ? `${t("Az")} ${hud.shadowAzimuthDeg}° · ${numbers.format(hud.shadowLengthFactor)}× ${t("object height")}`
                    : t(hud.sunElevationDeg === null ? "Unavailable"
                      : hud.sunElevationDeg === 90 ? "Overhead Sun · zero shadow length"
                      : "Sun at or below the ideal horizon")}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  </section>;
}

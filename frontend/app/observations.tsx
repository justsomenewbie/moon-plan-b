import { chartPath, durationHours, sampleAt, skyPath } from "../lib/dataset";
import type { Dataset, Mode, Scenario } from "../lib/dataset";

export const formatUtc = (utc: string) => new Intl.DateTimeFormat("en-GB", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hourCycle: "h23",
}).format(new Date(utc)) + " UTC";
const angle = (n: number | undefined) => n === undefined ? "Unavailable" : `${n.toFixed(1)}°`;
const exactAngle = (n: number | undefined) => n === undefined ? "Unavailable" : `${n}°`;
const hours = (n: number | undefined) => n === undefined ? "Unavailable" : `${n.toFixed(1)} h`;

export function Timeline({ a, b, mode, offset }: { a: Scenario; b?: Scenario; mode: Mode; offset: number }) {
  const width = 800, height = 240;
  const cursor = offset / (durationHours(a) * 3600000) * width;
  return <div className="timeline">
    <div className="section-heading"><h2>Sun &amp; Earth, over time</h2><div className="legend"><span className="sun">Sun</span><span className="earth">Earth</span></div></div>
    <p className="muted text-sm">Solid: primary. Dashed: alternative. Straight segments join supplied samples; they are not new observations.</p>
    <div className="plot-frame"><div className="y-ticks" aria-hidden="true">{[90, 45, 0, -45, -90].map((v) => <span key={v}>{v}°</span>)}</div><div className="plot-area">
    <svg className="timeline-svg" viewBox="0 0 800 240" preserveAspectRatio="none" role="img" aria-labelledby="timeline-title timeline-desc">
      <title id="timeline-title">Sun and Earth elevation above the ideal horizon</title>
      <desc id="timeline-desc">Elevation in degrees from minus 90 to 90. {mode === "dates" ? "Dates are aligned by elapsed hours, with separate UTC timestamps below." : "Sites share the same absolute UTC window."} Missing observations break each line. Use the sample table for exact values.</desc>
      {[-90, -45, 0, 45, 90].map((v) => <g key={v}>
        <line x1="0" x2={width} y1={(90 - v) / 180 * height} y2={(90 - v) / 180 * height} className={v === 0 ? "horizon-line" : "grid-line"} />
      </g>)}
      {[a, b].map((s, i) => s ? ["sun", "earth"].map((body) => <path key={`${s.id}-${body}`} d={chartPath(s, body as "sun" | "earth", width, height)} fill="none" className={`plot-line ${body}`} strokeDasharray={i ? "7 6" : undefined} opacity={i ? 0.65 : 1} />) : null)}
      {a.samples.length > 0 ? <line x1={cursor} x2={cursor} y1="0" y2={height} className="cursor-line" /> : null}
    </svg>
    <svg className="plot-markers" aria-hidden="true">{[a, b].map((s, i) => s ? s.samples.flatMap((sample) => (["sun", "earth"] as const).map((body) => {
      const value = sample[body]; if (!value) return null;
      const x = `${(Date.parse(sample.utc) - Date.parse(s.startUtc)) / (durationHours(s) * 3600000) * 100}%`, y = `${(90 - value.elevationDeg) / 180 * 100}%`;
      return body === "sun" ? <circle key={`${s.id}-${sample.utc}-${body}`} cx={x} cy={y} r="3.5" className={body} fill={i ? "var(--bg)" : "currentColor"} stroke="currentColor" /> : <rect key={`${s.id}-${sample.utc}-${body}`} x={x} y={y} width="7" height="7" transform="translate(-3.5 -3.5)" className={body} fill={i ? "var(--bg)" : "currentColor"} stroke="currentColor" />;
    })) : null)}</svg></div>
    <div className="x-ticks" aria-hidden="true">{[0, .25, .5, .75, 1].map((v) => {
      const time = new Date(Date.parse(a.startUtc) + durationHours(a) * v * 3600000);
      return <span key={v}>{mode === "dates" ? `${Number((durationHours(a) * v).toFixed(2))} h` : <><span>{new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).format(time)}</span><span>{time.toISOString().slice(11, 16)}</span></>}</span>;
    })}</div></div>
    <p className="axis-caption">{mode === "dates" ? "Elapsed time from each window’s start · hours" : "Time · UTC"} <span>0° = ideal horizon</span></p>
    <div className="visibility-bands">{[a, b].map((s, i) => s ? (["sun", "earth"] as const).map((body) => <div className={`visibility-row ${body}`} key={`${s.id}-${body}`}><span>{i ? "Alternative" : "Primary"} · {body === "sun" ? "Sun" : "Earth"}</span>{s.intervals === null ? <span className="muted">Intervals unavailable</span> : <svg viewBox="0 0 800 16" preserveAspectRatio="none" role="img" aria-label={`${i ? "Alternative" : "Primary"} ${body} supplied visibility intervals: ${s.intervals[body].length}`}><rect width="800" height="16" fill="none" stroke="var(--line)" />{s.intervals[body].map((v) => <rect key={v.startUtc} x={(Date.parse(v.startUtc) - Date.parse(s.startUtc)) / (Date.parse(s.endUtc) - Date.parse(s.startUtc)) * 800} y="2" width={(Date.parse(v.endUtc) - Date.parse(v.startUtc)) / (Date.parse(s.endUtc) - Date.parse(s.startUtc)) * 800} height="12" fill={i ? "none" : "currentColor"} stroke="currentColor" />)}</svg>}</div>) : null)}</div>
  </div>;
}

export function SkyPosition({ scenario, offset }: { scenario: Scenario; offset: number }) {
  const sample = sampleAt(scenario, offset);
  return <section className="sky" aria-labelledby="sky-title">
    <h3 id="sky-title">Sky positions</h3>
    <p className="muted text-sm">Primary sample · schematic, no terrain</p>
    <svg viewBox="-20 -10 400 200" role="img" aria-labelledby="sky-description">
      <title id="sky-description">Azimuth and elevation of the Sun and Earth at the selected primary sample</title>
      <rect x="0" y="90" width="360" height="90" className="below-horizon" />
      {[0, 90, 180, 270, 360].map((x, i) => <g key={x}><line x1={x} x2={x} y1="0" y2="180" className="grid-line" /><text x={x} y="-2" textAnchor="middle" className="axis-label">{["N", "E", "S", "W", "N"][i]}</text></g>)}
      <polyline points={scenario.horizonCurve.map((p) => `${p.azimuthDeg},${90 - p.elevationDeg}`).join(" ")} fill="none" className="horizon-line" />
      {(["sun", "earth"] as const).map((body) => <path key={body} d={skyPath(scenario, body)} fill="none" className={`plot-line ${body}`} opacity=".45" />)}
      {(["sun", "earth"] as const).map((body) => sample?.[body] ? <g key={body} className={body}>
        {body === "sun" ? <circle cx={sample[body].azimuthDeg} cy={90 - sample[body].elevationDeg} r="6" fill="currentColor" /> : <rect x={sample[body].azimuthDeg - 5} y={85 - sample[body].elevationDeg} width="10" height="10" fill="currentColor" />}
      </g> : null)}
    </svg>
    <dl className="angle-readout">
      {(["sun", "earth"] as const).map((body) => <div key={body}><dt className={body}>{body === "sun" ? "Sun" : "Earth"}</dt><dd>El {angle(sample?.[body]?.elevationDeg)} <span>Az {angle(sample?.[body]?.azimuthDeg)}</span></dd></div>)}
    </dl>
    <p className="muted text-xs">Circle: Sun. Square: Earth. Shading is below the supplied ideal horizon. Lines join supplied samples, breaking at gaps and the north wrap. Azimuth: N 0° → E 90° → S 180° → W 270°. This is not a perspective view.</p>
  </section>;
}

export function Comparison({ a, b, h }: { a: Scenario; b?: Scenario; h: number }) {
  const names = ["Sun above horizon", "Earth above horizon", "Longest joint window"];
  const keys = ["sunAboveHours", "earthAboveHours", "simultaneousLongestHours"] as const;
  return <section className="comparison" aria-labelledby="comparison-title"><h3 id="comparison-title">Compare the windows</h3>
    <div className="table-scroll"><table><caption className="sr-only">Producer-supplied durations and assessments</caption><thead><tr><th scope="col">Duration</th><th scope="col">Primary</th><th scope="col">Alternative</th></tr></thead>
      <tbody>{keys.map((key, i) => <tr key={key}><th scope="row">{names[i]}</th><td>{hours(a.metrics?.[key])}</td><td>{hours(b?.metrics?.[key])}</td></tr>)}</tbody>
    </table></div>
    <div className="assessments">{[a, b].map((s, i) => {
      const assessment = s?.criteria.find((c) => c.minimumHours === h);
      return <div key={i}><p className="text-sm muted">{i ? "Alternative" : "Primary"} · {h} h joint-window criterion</p><p className={`assessment ${assessment?.result ?? "unknown"}`}>{assessment ? { meets: "Meets the criterion", below: "Below the criterion", borderline: "Near the threshold", unknown: "Not enough data" }[assessment.result] : "No alternative selected"}</p><p className="text-sm muted">{assessment?.reason ?? "Choose an available comparison."}</p></div>;
    })}</div>
    <p className="muted text-xs">Durations shown to 0.1 h. Assessments are supplied by the dataset, not landing-safety recommendations.</p>
  </section>;
}

export function SampleTable({ a, b }: { a: Scenario; b?: Scenario }) {
  return <details className="details-section"><summary>Inspect exact samples</summary><p className="muted text-sm">Angles in degrees. Null observations remain unavailable. The right endpoint supports boundary evaluation and adds no extra duration.</p>
    {[a, b].map((s, i) => s ? <div key={s.id} className="table-scroll sample-table"><table><caption>{i ? "Alternative" : "Primary"} · {s.id} · {s.coverage} coverage · nominal step {s.sampleStepSeconds} s</caption><thead><tr><th scope="col">UTC</th><th scope="col">Sun elevation</th><th scope="col">Sun azimuth</th><th scope="col">Earth elevation</th><th scope="col">Earth azimuth</th></tr></thead><tbody>{s.samples.length ? s.samples.map((sample) => <tr key={sample.utc}><th scope="row">{sample.utc}</th><td>{exactAngle(sample.sun?.elevationDeg)}</td><td>{exactAngle(sample.sun?.azimuthDeg)}</td><td>{exactAngle(sample.earth?.elevationDeg)}</td><td>{exactAngle(sample.earth?.azimuthDeg)}</td></tr>) : <tr><td colSpan={5}>No observations in this window.</td></tr>}</tbody></table></div> : null)}
  </details>;
}

export function Windows({ a, b }: { a: Scenario; b?: Scenario }) {
  return <details className="details-section"><summary>Inspect joint visibility intervals</summary>
    {[a, b].map((s, i) => s ? <div key={s.id}><h3 className="mt-4">{i ? "Alternative" : "Primary"}</h3>{s.intervals === null ? <p>Intervals unavailable because coverage is incomplete.</p> : s.intervals.simultaneous.length === 0 ? <p>No joint interval in this window.</p> : <ul className="interval-list">{s.intervals.simultaneous.map((v) => <li key={v.startUtc}><span>{formatUtc(v.startUtc)} → {formatUtc(v.endUtc)}</span>{v.endClipped ? <strong>Clipped at window end; setting time is unknown.</strong> : null}</li>)}</ul>}</div> : null)}
  </details>;
}

export function Sources({ data, a, b }: { data: Dataset; a?: Scenario; b?: Scenario }) {
  return <section id="sources" className="sources-section" aria-labelledby="sources-title">
    <h2 id="sources-title">Sources &amp; method</h2>
    <p className="data-notice">{data.evidence === "synthetic-fixture" ? "SYNTHETIC UI FIXTURE — NOT LUNAR DATA" : "Imported data — scientific validity has not been independently verified by this app."}</p>
    <p className="muted text-sm">{data.attribution}</p>
    <div className="source-columns"><div><h3>{data.model.label}</h3><p>{data.model.definition}</p><ul className="limitations">{data.model.limits.map((v) => <li key={v}>{v}</li>)}</ul>
      {data.sites.filter((site) => site.id === a?.siteId || site.id === b?.siteId).map((site) => <div key={site.id} className="site-provenance"><h3>{site.name}</h3>{site.location ? <dl className="metadata"><div><dt>Latitude</dt><dd>{site.location.latitudeDeg}°</dd></div><div><dt>East longitude</dt><dd>{site.location.longitudeEastDeg}°</dd></div><div><dt>Elevation</dt><dd>{site.location.elevationKm} km</dd></div><div><dt>Frame</dt><dd>{site.location.frame}</dd></div><div><dt>Elevation datum</dt><dd>{site.location.elevationDatum}</dd></div><div><dt>Source IDs</dt><dd>{site.sourceIds.join(", ")}</dd></div></dl> : <p>Fictional site. No real coordinates, elevation or reference frame are supplied.</p>}</div>)}
    </div>
      <div><dl className="metadata"><div><dt>Dataset</dt><dd>{data.datasetId}</dd></div><div><dt>Schema</dt><dd>{data.schemaVersion} · draft</dd></div><div><dt>Model</dt><dd>{data.model.id}</dd></div></dl>
        {data.sources.length === 0 ? <p className="muted">No scientific sources are used by the demonstration. The sites and values were invented to test the interface.</p> : <ul className="source-list">{data.sources.map((s) => <li key={s.id}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a><p className="muted text-sm">{s.version} · retrieved {formatUtc(s.retrievedAtUtc)}</p>{s.rawSha256 ? <code className="hash">SHA-256 {s.rawSha256}</code> : null}</li>)}</ul>}
        {[a, b].map((s, i) => s?.evidenceUrl ? <p key={s.id}><a href={s.evidenceUrl} target="_blank" rel="noreferrer">{i ? "Alternative" : "Primary"} processing evidence</a> · sources {s.sourceIds.join(", ")}</p> : null)}
      </div></div>
    <p className="muted text-sm">The frontend displays supplied angles, intervals and assessments. It does not query Horizons or calculate ephemerides. This draft format requires agreement with the data producer before integration.</p>
  </section>;
}

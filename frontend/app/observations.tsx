import { memo } from "react";
import { chartPath, durationHours, sampleAt, skyPath } from "../lib/dataset";
import type { Dataset, Mode, Scenario } from "../lib/dataset";
import type { Locale } from "../lib/i18n";
import { useLanguage } from "./language";

export const formatUtc = (utc: string, locale: Locale = "en") => new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-GB", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hourCycle: "h23",
}).format(new Date(utc)) + " UTC";
const angle = (n: number | undefined) => n === undefined ? "Unavailable" : `${n.toFixed(1)}°`;
const exactAngle = (n: number | undefined) => n === undefined ? "Unavailable" : `${n}°`;
const hours = (n: number | undefined) => n === undefined ? "Unavailable" : `${n.toFixed(1)} h`;
const assessmentLabel = {
  meets: "Meets the criterion", below: "Below the criterion",
  borderline: "Near the threshold", unknown: "Not enough data",
};

export const SiteAssessments = memo(function SiteAssessments({ data, scenarios, h }: { data: Dataset; scenarios: Scenario[]; h: number }) {
  const { t } = useLanguage();
  const publishedSites = new Set(scenarios.map(s => s.siteId));
  return <section className="site-assessments" aria-labelledby="site-assessments-title">
    <h2 id="site-assessments-title">{t("Where are the Sun and Earth both above the horizon for at least {hours} h?", { hours: h })}</h2>
    <p className="muted text-sm">{data.evidence === "synthetic-fixture" ? t("Synthetic release") : t("Dataset")} · {data.datasetId}</p>
    <p className="text-sm"><time>{scenarios[0].startUtc}</time> → <time>{scenarios[0].endUtc}</time></p>
    <ul>{scenarios.map(s => {
      const assessment = s.criteria.find(c => c.minimumHours === h)!;
      const name = data.sites.find(site => site.id === s.siteId)!.name;
      return <li key={s.id}>
        <div><strong>{name}</strong><p className="muted text-sm">{s.id} · {t(s.coverage)}</p></div>
        <div><strong className={assessment.result}>{t(assessmentLabel[assessment.result])}</strong>
          {s.metrics && <p className="text-sm">{t("Longest joint window")} · {s.metrics.simultaneousLongestHours} h</p>}
          <p className="muted text-sm">{t("Original producer explanation")} · {assessment.reason}</p>
          {s.sourceIds.length > 0 && <p className="muted text-sm">{t("Source IDs")}{[...new Set(s.sourceIds)].map(id =>
            <span key={id}> · <a href={`#source-${id}`}>{id}</a></span>)}</p>}
          {s.evidenceUrl && <a className="text-sm" href={s.evidenceUrl} target="_blank" rel="noreferrer">{t("processing evidence")}</a>}
        </div>
      </li>;
    })}{data.sites.filter(site => !publishedSites.has(site.id)).map(site =>
      <li key={`absent/${site.id}`}><strong>{site.name}</strong><span className="muted">{t("No published window")}</span></li>)}</ul>
  </section>;
});

const SampleMarkers = memo(function SampleMarkers({ a, b }: { a: Scenario; b?: Scenario }) {
  return <svg className="plot-markers" aria-hidden="true">{[a, b].map((s, i) => s ? s.samples.flatMap((sample) => (["sun", "earth"] as const).map((body) => {
    const value = sample[body]; if (!value) return null;
    const x = `${(Date.parse(sample.utc) - Date.parse(s.startUtc)) / (durationHours(s) * 3600000) * 100}%`, y = `${(90 - value.elevationDeg) / 180 * 100}%`;
    return body === "sun" ? <circle key={`${s.id}-${sample.utc}-${body}`} cx={x} cy={y} r="3.5" className={body} fill={i ? "var(--bg)" : "currentColor"} stroke="currentColor" /> : <rect key={`${s.id}-${sample.utc}-${body}`} x={x} y={y} width="7" height="7" transform="translate(-3.5 -3.5)" className={body} fill={i ? "var(--bg)" : "currentColor"} stroke="currentColor" />;
  })) : null)}</svg>;
});

export function Timeline({ a, b, mode, offset }: { a: Scenario; b?: Scenario; mode: Mode; offset: number }) {
  const { t, locale } = useLanguage();
  const width = 800, height = 240;
  const cursor = offset / (durationHours(a) * 3600000) * width;
  return <div className="timeline">
    <div className="section-heading"><h2>{t("Sun & Earth, over time")}</h2><div className="legend"><span className="sun">{t("Sun")}</span><span className="earth">{t("Earth")}</span></div></div>
    <p className="muted text-sm">{t("Solid: primary. Dashed: alternative. Straight segments join supplied samples; they are not new observations.")}</p>
    <div className="plot-frame"><div className="y-ticks" aria-hidden="true">{[90, 45, 0, -45, -90].map((v) => <span key={v}>{v}°</span>)}</div><div className="plot-area">
    <svg className="timeline-svg" viewBox="0 0 800 240" preserveAspectRatio="none" role="img" aria-labelledby="timeline-title timeline-desc">
      <title id="timeline-title">{t("Sun and Earth elevation above the ideal horizon")}</title>
      <desc id="timeline-desc">{t("Elevation in degrees from minus 90 to 90.")}{" "}{mode === "dates" ? t("Dates are aligned by elapsed hours, with separate UTC timestamps below.") : t("Sites share the same absolute UTC window.")} {t("Missing observations break each line. Use the sample table for exact values.")}</desc>
      {[-90, -45, 0, 45, 90].map((v) => <g key={v}>
        <line x1="0" x2={width} y1={(90 - v) / 180 * height} y2={(90 - v) / 180 * height} className={v === 0 ? "horizon-line" : "grid-line"} />
      </g>)}
      {[a, b].map((s, i) => s ? ["sun", "earth"].map((body) => <path key={`${s.id}-${body}`} d={chartPath(s, body as "sun" | "earth", width, height)} fill="none" className={`plot-line ${body}`} strokeDasharray={i ? "7 6" : undefined} opacity={i ? 0.65 : 1} />) : null)}
      {a.samples.length > 0 ? <line x1={cursor} x2={cursor} y1="0" y2={height} className="cursor-line" /> : null}
    </svg>
    <SampleMarkers a={a} b={b} /></div>
    <div className="x-ticks" aria-hidden="true">{[0, .25, .5, .75, 1].map((v) => {
      const time = new Date(Date.parse(a.startUtc) + durationHours(a) * v * 3600000);
      return <span key={v}>{mode === "dates" ? `${Number((durationHours(a) * v).toFixed(2))} h` : <><span>{new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).format(time)}</span><span>{time.toISOString().slice(11, 16)}</span></>}</span>;
    })}</div></div>
    <p className="axis-caption">{mode === "dates" ? t("Elapsed time from each window’s start · hours") : t("Time · UTC")} <span>{t("0° = ideal horizon")}</span></p>
    <div className="visibility-bands">{[a, b].map((s, i) => s ? (["sun", "earth"] as const).map((body) => <div className={`visibility-row ${body}`} key={`${s.id}-${body}`}><span>{i ? t("Alternative") : t("Primary")} · {body === "sun" ? t("Sun") : t("Earth")}</span>{s.intervals === null ? <span className="muted">{t("Intervals unavailable")}</span> : <svg viewBox="0 0 800 16" preserveAspectRatio="none" role="img" aria-label={t("{role} {body} supplied visibility intervals: {count}", { role: i ? t("Alternative") : t("Primary"), body: body === "sun" ? t("Sun") : t("Earth"), count: s.intervals[body].length })}><rect width="800" height="16" fill="none" stroke="var(--line)" />{s.intervals[body].map((v) => <rect key={v.startUtc} x={(Date.parse(v.startUtc) - Date.parse(s.startUtc)) / (Date.parse(s.endUtc) - Date.parse(s.startUtc)) * 800} y="2" width={(Date.parse(v.endUtc) - Date.parse(v.startUtc)) / (Date.parse(s.endUtc) - Date.parse(s.startUtc)) * 800} height="12" fill={i ? "none" : "currentColor"} stroke="currentColor" />)}</svg>}</div>) : null)}</div>
  </div>;
}

export function SkyPosition({ scenario, offset }: { scenario: Scenario; offset: number }) {
  const { t } = useLanguage();
  const sample = sampleAt(scenario, offset);
  return <section className="sky" aria-labelledby="sky-title">
    <h3 id="sky-title">{t("Sky positions")}</h3>
    <p className="muted text-sm">{t("Primary sample · schematic, no terrain")}</p>
    <svg viewBox="-20 -10 400 200" role="img" aria-labelledby="sky-description">
      <title id="sky-description">{t("Azimuth and elevation of the Sun and Earth at the selected primary sample")}</title>
      <rect x="0" y="90" width="360" height="90" className="below-horizon" />
      {[0, 90, 180, 270, 360].map((x, i) => <g key={x}><line x1={x} x2={x} y1="0" y2="180" className="grid-line" /><text x={x} y="-2" textAnchor="middle" className="axis-label">{["N", "E", "S", "W", "N"][i]}</text></g>)}
      <polyline points={scenario.horizonCurve.map((p) => `${p.azimuthDeg},${90 - p.elevationDeg}`).join(" ")} fill="none" className="horizon-line" />
      {(["sun", "earth"] as const).map((body) => <path key={body} d={skyPath(scenario, body)} fill="none" className={`plot-line ${body}`} opacity=".45" />)}
      {(["sun", "earth"] as const).map((body) => sample?.[body] ? <g key={body} className={body}>
        {body === "sun" ? <circle cx={sample[body].azimuthDeg} cy={90 - sample[body].elevationDeg} r="6" fill="currentColor" /> : <rect x={sample[body].azimuthDeg - 5} y={85 - sample[body].elevationDeg} width="10" height="10" fill="currentColor" />}
      </g> : null)}
    </svg>
    <dl className="angle-readout">
      {(["sun", "earth"] as const).map((body) => <div key={body}><dt className={body}>{body === "sun" ? t("Sun") : t("Earth")}</dt><dd>{t("El")}{" "}{t(angle(sample?.[body]?.elevationDeg))} <span>{t("Az")}{" "}{t(angle(sample?.[body]?.azimuthDeg))}</span></dd></div>)}
    </dl>
    <p className="muted text-xs">{t("Circle: Sun. Square: Earth. Shading is below the supplied ideal horizon. Lines join supplied samples, breaking at gaps and the north wrap. Azimuth: N 0° → E 90° → S 180° → W 270°. This is not a perspective view.")}</p>
  </section>;
}

export function Comparison({ a, b, h }: { a: Scenario; b?: Scenario; h: number }) {
  const { t, locale } = useLanguage();
  const names = ["Sun above horizon", "Earth above horizon", "Longest joint window"];
  const keys = ["sunAboveHours", "earthAboveHours", "simultaneousLongestHours"] as const;
  return <section className="comparison" aria-labelledby="comparison-title"><h3 id="comparison-title">{t("Compare the windows")}</h3>
    <div className="table-scroll"><table><caption className="sr-only">{t("Producer-supplied durations and assessments")}</caption><thead><tr><th scope="col">{t("Duration")}</th><th scope="col">{t("Primary")}</th><th scope="col">{t("Alternative")}</th></tr></thead>
      <tbody>{keys.map((key, i) => <tr key={key}><th scope="row">{t(names[i])}</th><td>{t(hours(a.metrics?.[key]))}</td><td>{t(hours(b?.metrics?.[key]))}</td></tr>)}</tbody>
    </table></div>
    <div className="assessments">{[a, b].map((s, i) => {
      const assessment = s?.criteria.find((c) => c.minimumHours === h);
      return <div key={i}><p className="text-sm muted">{i ? t("Alternative") : t("Primary")} · {h} {t("h joint-window criterion")}</p><p className={`assessment ${assessment?.result ?? "unknown"}`}>{assessment ? t(assessmentLabel[assessment.result]) : t("No alternative selected")}</p><p className="text-sm muted">{assessment ? <>{locale === "vi" ? <span>{t("Original producer explanation")}: </span> : null}{assessment.reason}</> : t("Choose an available comparison.")}</p></div>;
    })}</div>
    <p className="muted text-xs">{t("Durations shown to 0.1 h. Assessments are supplied by the dataset, not landing-safety recommendations.")}</p>
  </section>;
}

export const SampleTable = memo(function SampleTable({ a, b }: { a: Scenario; b?: Scenario }) {
  const { t } = useLanguage();
  return <details className="details-section"><summary>{t("Inspect exact samples")}</summary><p className="muted text-sm">{t("Angles in degrees. Null observations remain unavailable. The right endpoint supports boundary evaluation and adds no extra duration.")}</p>
    {[a, b].map((s, i) => s ? <div key={s.id} className="table-scroll sample-table" tabIndex={0} role="region" aria-labelledby={`sample-caption-${i}`}><table><caption id={`sample-caption-${i}`}>{i ? t("Alternative") : t("Primary")} · {s.id} · {t(s.coverage)} {t("coverage · nominal step")}{" "}{s.sampleStepSeconds} s</caption><thead><tr><th scope="col">UTC</th><th scope="col">{t("Sun elevation")}</th><th scope="col">{t("Sun azimuth")}</th><th scope="col">{t("Earth elevation")}</th><th scope="col">{t("Earth azimuth")}</th></tr></thead><tbody>{s.samples.length ? s.samples.map((sample) => <tr key={sample.utc}><th scope="row">{sample.utc}</th><td>{t(exactAngle(sample.sun?.elevationDeg))}</td><td>{t(exactAngle(sample.sun?.azimuthDeg))}</td><td>{t(exactAngle(sample.earth?.elevationDeg))}</td><td>{t(exactAngle(sample.earth?.azimuthDeg))}</td></tr>) : <tr><td colSpan={5}>{t("No observations in this window.")}</td></tr>}</tbody></table></div> : null)}
  </details>;
});

export function Windows({ a, b }: { a: Scenario; b?: Scenario }) {
  const { t } = useLanguage();
  return <details className="details-section"><summary>{t("Inspect visibility intervals")}</summary><p className="muted text-sm">{t("Exact supplied boundaries in UTC, including seconds.")}</p>
    {[a, b].map((s, i) => {
      if (!s) return null;
      const intervals = s.intervals;
      return <div key={s.id}><h3 className="mt-4">{i ? t("Alternative") : t("Primary")}</h3>{intervals === null ? <p>{t("Intervals unavailable because coverage is incomplete.")}</p> : (["sun", "earth", "simultaneous"] as const).map((body) => <div key={body}>
        <h4 className="mt-3 font-semibold">{{ sun: t("Sun"), earth: t("Earth"), simultaneous: t("Sun and Earth together") }[body]}</h4>
        {intervals[body].length === 0 ? <p>{t("No supplied interval in this window.")}</p> : <ul className="interval-list">{intervals[body].map((v) => <li key={v.startUtc}><span>{v.startUtc} → {v.endUtc}</span>{v.endClipped ? <strong>{t("Clipped at window end; interval end is unknown.")}</strong> : null}</li>)}</ul>}
      </div>)}</div>;
    })}
  </details>;
}

export function Sources({ data, a, b }: { data: Dataset; a?: Scenario; b?: Scenario }) {
  const { t, locale } = useLanguage();
  return <section id="sources" className="sources-section" aria-labelledby="sources-title">
    <h2 id="sources-title">{t("Sources & method")}</h2>
    <p className="data-notice">{data.evidence === "synthetic-fixture" ? t("SYNTHETIC UI FIXTURE — NOT LUNAR DATA") : t("Imported data — scientific validity has not been independently verified by this app.")}</p>
    <p className="muted text-sm">{t("Supplied scientific text, source names and technical diagnostics remain in their original language.")}</p>
    <p className="muted text-sm">{data.attribution}</p>
    <div className="source-columns"><div><h3>{data.model.label}</h3><p>{data.model.definition}</p><ul className="limitations">{data.model.limits.map((v) => <li key={v}>{v}</li>)}</ul>
      {data.sites.filter((site) => site.id === a?.siteId || site.id === b?.siteId).map((site) => <div key={site.id} className="site-provenance"><h3>{site.name}</h3>{site.location ? <dl className="metadata"><div><dt>{t("Latitude")}</dt><dd>{site.location.latitudeDeg}°</dd></div><div><dt>{t("East longitude")}</dt><dd>{site.location.longitudeEastDeg}°</dd></div><div><dt>{t("Elevation")}</dt><dd>{site.location.elevationKm} km</dd></div><div><dt>{t("Frame")}</dt><dd>{site.location.frame}</dd></div><div><dt>{t("Elevation datum")}</dt><dd>{site.location.elevationDatum}</dd></div><div><dt>{t("Source IDs")}</dt><dd>{site.sourceIds.join(", ")}</dd></div></dl> : <p>{t("Fictional site. No real coordinates, elevation or reference frame are supplied.")}</p>}</div>)}
    </div>
      <div><dl className="metadata"><div><dt>{t("Dataset")}</dt><dd>{data.datasetId}</dd></div><div><dt>{t("Schema")}</dt><dd>{data.schemaVersion} · {t("draft")}</dd></div><div><dt>{t("Model")}</dt><dd>{data.model.id}</dd></div></dl>
        {data.sources.length === 0 ? <p className="muted">{t("The comparison sites and values were invented to test the interface. The separate lunar image and reference links are not sources for these values.")}</p> : <ul className="source-list">{data.sources.map((s) => <li key={s.id} id={`source-${s.id}`}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a><p className="muted text-sm">{s.id} · {s.version} · {t("retrieved")}{" "}{formatUtc(s.retrievedAtUtc, locale)}</p>{s.rawSha256 ? <code className="hash">SHA-256 {s.rawSha256}</code> : null}</li>)}</ul>}
        {[a, b].map((s, i) => s?.evidenceUrl ? <p key={s.id}><a href={s.evidenceUrl} target="_blank" rel="noreferrer">{i ? t("Alternative") : t("Primary")} {t("processing evidence")}</a> · {t("sources")}{" "}{s.sourceIds.join(", ")}</p> : null)}
      </div></div>
    <p className="muted text-sm">{t("The frontend displays supplied angles, intervals and assessments. It does not query Horizons or calculate ephemerides. This draft format requires agreement with the data producer before integration.")}</p>
  </section>;
}

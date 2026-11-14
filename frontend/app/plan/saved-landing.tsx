"use client";

import { useMemo, useState } from "react";
import { savedLandingHour } from "../../lib/planner-source";
import { archiveB2Run, searchArchiveB2 } from "../../lib/archive-b2";
import { getSavedPlannerDates, savedPlannerRun, savedPlannerWindows } from "../../lib/saved-planner";
import { useLanguage } from "../language";
import { TimeRange } from "../terrain-site-result";

type Priority = "joint" | "sun" | "earth";
type Props = { siteId?: string; from?: string; to?: string; missionHours?: number; priority?: Priority };
type Fields = Required<Props> & { earliest: string; latest: string };
const example: Fields = {
  siteId: "im2_athena", from: "2026-11-14", to: "2026-11-21", missionHours: 24, priority: "joint", earliest: "", latest: "",
};
const legacySites = savedPlannerRun.sites.filter(site => savedPlannerWindows.pair.siteIds.includes(site.id));
const metric = { joint: "bothHours", sun: "sunHours", earth: "earthHours" } as const;
const hour = 3600000;

function rank(fields: Fields) {
  const saved = getSavedPlannerDates(fields);
  if (!saved) return null;
  const firstStart = Date.parse(saved.from), lastStart = Date.parse(saved.to) - fields.missionHours * hour;
  function limit(value: string, fallback: number) {
    if (!value) return fallback;
    const utc = value.length === 16 ? value + ":00Z" : value + "Z";
    const ms = Date.parse(utc);
    return /^\d{4}-\d\d-\d\dT\d\d:00:00Z$/.test(utc) && Number.isFinite(ms) &&
      new Date(ms).toISOString().replace(".000Z", "Z") === utc ? ms : NaN;
  }
  const first = limit(fields.earliest, firstStart), last = limit(fields.latest, lastStart);
  if (!(firstStart <= first && first <= last && last <= lastStart)) return null;
  const rows = saved.rows.filter(row => {
    const start = Date.parse(row.start);
    return first <= start && start <= last;
  });
  const best = rows[0][metric[fields.priority]];
  const stamp = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
  return { ...saved, rows: rows.slice(0, 5), nEvaluated: rows.length, best, first: stamp(first), last: stamp(last), ties: rows.filter(row => row[metric[fields.priority]] === best).length };
}

export default function SavedLanding({ siteId, from, to, missionHours, priority, source, earliest, latest, liveOptions }: Props & { source: "saved" | "saved-b2"; earliest?: string; latest?: string; liveOptions?: boolean }) {
  const { locale, t } = useLanguage();
  const vi = locale === "vi";
  const b2 = source === "saved-b2";
  const sites = b2 ? archiveB2Run.sites : legacySites;
  const coverage = b2 ? { from: archiveB2Run.start, to: archiveB2Run.end } : savedPlannerWindows.pair;
  const initial: Fields = { ...example, siteId: siteId ?? example.siteId, from: from ?? example.from, to: to ?? example.to,
    missionHours: missionHours ?? example.missionHours, priority: priority ?? example.priority, earliest: earliest ?? "", latest: latest ?? "" };
  const [fields, setFields] = useState(initial);
  const [submitted, setSubmitted] = useState<Fields | null>(liveOptions ? null : initial);
  const change = <K extends keyof Fields>(key: K, value: Fields[K]) => {
    setFields(previous => ({ ...previous, [key]: value }));
    setSubmitted(null);
  };
  const result = useMemo(() => {
    if (!submitted) return null;
    const limits = { ...submitted, earliest: savedLandingHour(submitted.earliest, "earliest"), latest: savedLandingHour(submitted.latest, "latest") };
    return b2 ? searchArchiveB2({ ...limits, earliest: limits.earliest || undefined, latest: limits.latest || undefined }) : rank(limits);
  }, [b2, submitted]);
  const validSite = sites.some(site => site.id === fields.siteId);
  const labels = { joint: t("Both visible"), sun: t("Sun visible"), earth: t("Earth visible") };
  const title = vi ? "Giờ hạ cánh nào phù hợp ở đây?" : "When should I land at this site?";

  return <section aria-labelledby="saved-landing-title">
    <h2 id="saved-landing-title">{title}</h2>
    <p>{b2 ? t("Saved hourly visibility for all 23 sites") : vi ? "Dữ liệu đã lưu theo giờ cho Odysseus và Athena" : "Saved hourly observations for Odysseus and Athena"} · <TimeRange start={coverage.from} end={coverage.to} /> ({vi ? "không gồm mốc cuối" : "end exclusive"})</p>
    {liveOptions && <p className="data-notice" role="status">{vi
      ? "Bản lưu giữ nguyên địa điểm, giới hạn giờ và thời lượng. Tìm kiếm tại đây xếp theo giờ quan sát; điều kiện bổ sung và cách xếp hạng riêng của API chỉ áp dụng khi bạn quay lại dữ liệu trực tuyến."
      : "Your site, landing bounds and duration are retained. The saved search ranks visibility hours. Additional live constraints and live-only ranking options apply again when you return to live data."}</p>}
    <form className="request-fields print:hidden" onSubmit={event => { event.preventDefault(); setSubmitted(fields); }}>
      <label className="field">{t("Site")}<select name="savedLandingSite" value={fields.siteId} onChange={event => change("siteId", event.target.value)}>
        {!validSite && <option value={fields.siteId}>{(b2 ? archiveB2Run : savedPlannerRun).sites.find(s => s.id === fields.siteId)?.name ?? fields.siteId}</option>}
        {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
      </select></label>
      <label className="field">{vi ? "Bắt đầu chuyến đi (UTC)" : "Travel window start (UTC)"}<input required type="date" name="savedFrom" value={fields.from} onChange={e => change("from", e.target.value)} /></label>
      <label className="field">{vi ? "Kết thúc chuyến đi (UTC, không gồm mốc này)" : "Travel window end (UTC, exclusive)"}<input required type="date" name="savedTo" value={fields.to} onChange={e => change("to", e.target.value)} /></label>
      <label className="field">{t("Mission duration (h)")}<input required type="number" min="1" step="1" name="savedDuration" value={fields.missionHours || ""} onChange={e => change("missionHours", Number(e.target.value))} /></label>
      <label className="field">{vi ? "Ưu tiên" : "Visibility priority"}<select name="savedPriority" value={fields.priority} onChange={e => change("priority", e.target.value as Priority)}>
        {(["joint", "sun", "earth"] as const).map(key => <option key={key} value={key}>{labels[key]}</option>)}
      </select></label>
      <details className="basis-full" open={earliest || latest ? true : undefined}><summary>{vi ? "Giới hạn giờ hạ cánh (tùy chọn)" : "Limit landing hours (optional)"}</summary>
        <p>{vi ? "Mô hình chỉ xét các giờ tròn nằm giữa hai mốc UTC, kể cả hai đầu. Đặt hai mốc bằng cùng một giờ tròn để kiểm tra một lần hạ cánh." : "The model tests whole UTC hours inside these inclusive bounds. Set both limits to the same whole hour to check one landing."}</p>
        <div className="request-fields">
          <label className="field">{t("Earliest landing (UTC, inclusive)")}<input type="datetime-local" step="1" name="savedEarliest" value={fields.earliest} onChange={e => change("earliest", e.target.value)} /></label>
          <label className="field">{t("Latest landing (UTC, inclusive)")}<input type="datetime-local" step="1" name="savedLatest" value={fields.latest} onChange={e => change("latest", e.target.value)} /></label>
        </div>
      </details>
      <button className="button primary" type="submit">{t("Search landing dates")}</button>
    </form>
    {submitted && !result && <div className="data-notice" role="status">
      <p>{vi ? "Không có kết quả cho lựa chọn này. Cần chọn địa điểm có dữ liệu, toàn bộ chuyến đi nằm trong khoảng đã lưu và các mốc hạ cánh hợp lệ." : "No result for this selection. Choose a saved site, fit the whole mission inside the saved period, and keep the landing-hour limits within that window."}</p>
      <button className="button outline print:hidden" onClick={() => { setFields(example); setSubmitted(example); }}>
        {vi ? "Xem ví dụ Athena, 14–21/11" : "Show Athena example, Nov 14–21"}</button>
    </div>}
    {submitted && result && <section aria-label={t("Landing search results")} className="plan-results">
      <h3>{result.name}</h3>
      <p><TimeRange start={result.from} end={result.to} /> · {submitted.missionHours} h · {labels[submitted.priority]}</p>
      {(submitted.earliest || submitted.latest) && <p>{vi ? "Giờ hạ cánh được xét (UTC, gồm cả hai mốc)" : "Landing hours evaluated (UTC, inclusive)"} · <TimeRange start={result.first} end={result.last} /></p>}
      {result.best > 0 ? <>
        <p role="status">{vi
          ? `${result.ties}/${result.nEvaluated} giờ hạ cánh đạt mức cao nhất: ${result.best} trong ${submitted.missionHours} giờ. Hiển thị ${Math.min(5, result.rows.length)} kết quả đầu, ưu tiên giờ sớm hơn khi bằng điểm.`
          : `Best visibility: ${result.best} of ${submitted.missionHours} hours. ${result.ties} of ${result.nEvaluated} evaluated starts reach that total. Showing the first ${Math.min(5, result.rows.length)}, earliest first within each tie.`}</p>
        <div className="table-scroll"><table><thead><tr><th scope="col">{vi ? "Chuyến đi (UTC)" : "Mission window (UTC)"}</th>
          <th scope="col">{labels.sun}</th><th scope="col">{labels.earth}</th><th scope="col">{labels.joint}</th></tr></thead>
          <tbody>{result.rows.slice(0, 5).map(row => <tr key={row.start}><th scope="row"><TimeRange start={row.start} end={row.end} /></th>
            <td>{row.sunHours} h</td><td>{row.earthHours} h</td><td>{row.bothHours} h</td></tr>)}</tbody></table></div>
      </> : <p role="status">{vi
        ? `Cả ${result.nEvaluated} giờ hạ cánh đều cho 0 giờ theo ưu tiên này. Chưa có giờ hạ cánh phù hợp.`
        : `All ${result.nEvaluated} landing times have 0 hours of the selected visibility. No landing time is recommended.`}</p>}
      <p className="muted text-sm">{t("Run ID")} · <a href={b2 ? "/data/run-b2/manifest.json" : "/data/run-b/manifest.json"}>{result.runId}</a> · {vi ? "Bước thời gian mô hình" : "Model step"} 1 h</p>
    </section>}
  </section>;
}

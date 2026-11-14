import { archiveB2Run, rankArchiveB2, searchArchiveB2 } from "../archive-b2.ts";
import { getSavedPlannerDates, getSavedPlannerRanking, savedPlannerRun, savedPlannerWindows } from "../saved-planner.ts";
import { findAltDates } from "./alt-dates.ts";
import { getTerrainAggregate, isMock } from "./client.ts";
import { getPlannerMissionRanking, getPlannerRanking, getPlannerRun, type PlannerRun } from "./planner.ts";
import { rankSavedMissionWindows, type MissionWindowRanking } from "../mission-window-ranking.ts";
import { usesSmoothSphere } from "../site-horizon.ts";
import { translate } from "../i18n.ts";
import { hasPlanningQualifications, matchSites, type PlanningIntent } from "../guide-planning.ts";
export { matchSites } from "../guide-planning.ts";

type Locale = "en" | "vi";
export type PlanningArchive = "saved" | "saved-b2";
export type PlanningSource = PlanningArchive | PlannerRun;
export type PlanningAnswer = { answer: string; href: string };
type Services = { run: typeof getPlannerRun; ranking: typeof getPlannerRanking; missionRanking: typeof getPlannerMissionRanking; dates: typeof findAltDates; observation: typeof getTerrainAggregate; online: boolean };
const services: Services = { run: getPlannerRun, ranking: getPlannerRanking, missionRanking: getPlannerMissionRanking, dates: findAltDates, observation: getTerrainAggregate, online: !isMock };

function plannerHref(plan: PlanningIntent, site?: string, source?: PlanningSource) {
  const params = new URLSearchParams({ mode: plan.mode === "dates" ? "dates" : "sites", priority: plan.priority });
  if (typeof source === "string") params.set("source", source);
  else if (source) params.set("run_id", source.runId);
  if (plan.from) params.set("from", plan.from);
  if (plan.to) params.set("to", plan.to);
  if (site) params.set("site", site);
  if (plan.mode !== "observation" && plan.missionHours && Number.isSafeInteger(plan.missionHours)) params.set("missionHours", String(plan.missionHours));
  return "/plan?" + params;
}

export async function answerPlanning(plan: PlanningIntent, locale: Locale, signal: AbortSignal, api: Services = services, selected?: PlanningSource): Promise<PlanningAnswer> {
  signal.throwIfAborted();
  const tr = (en: string, vi: string) => locale === "en" ? en : vi;
  const archive = typeof selected === "string" ? selected : undefined;
  const liveRun = typeof selected === "object" ? selected : undefined;
  let fallback: PlanningArchive = archive ?? "saved-b2";
  let href = plannerHref(plan, undefined, selected ?? (api.online ? undefined : fallback));
  const reply = (text: string) => ({ answer: text, href });
  const metric = { joint: tr("joint Sun and Earth visibility", "thấy đồng thời Mặt Trời và Trái Đất"), sun: tr("Sun visibility", "thấy Mặt Trời"), earth: tr("Earth visibility", "thấy Trái Đất") }[plan.priority];
  if (plan.dateProblem && /(?:t|\s)\d{1,2}:\d{2}|\b(?:am|pm)\b/i.test(plan.siteText)) return reply(tr(
    "Chat searches whole UTC travel dates. For landing-time limits, open the planner, choose “I have a site” and enter the earliest and latest UTC starts.",
    "Chat tìm theo ngày UTC. Để giới hạn giờ hạ cánh, hãy mở công cụ lập kế hoạch, chọn “Tôi đã chọn địa điểm” và nhập giờ bắt đầu UTC sớm nhất và muộn nhất."));
  if (!plan.from || !plan.to || plan.dateProblem) return reply(tr("What start and end dates should I check? Use UTC dates with the year, e.g. 2026-11-21 to 2026-11-28. The end is exclusive.", "Bạn muốn kiểm tra khoảng ngày nào? Hãy ghi đủ năm, ví dụ 2026-11-21 đến 2026-11-28 theo UTC. Ngày kết thúc không được tính."));
  const from = plan.from + "T00:00:00Z", to = plan.to + "T00:00:00Z";
  const span = (Date.parse(to) - Date.parse(from)) / 3600000;
  const period = from + " → " + to + tr(" (exclusive)", " (không gồm mốc cuối)");
  if (hasPlanningQualifications(plan.siteText)) {
    href = plannerHref({ ...plan, missionHours: null }, undefined, selected ?? (api.online ? undefined : fallback));
    return reply(tr("The chat search ranks only total Sun, Earth or joint visibility. Open the planner to check your additional conditions for ", "Chat chỉ xếp hạng theo tổng thời gian thấy Mặt Trời, Trái Đất hoặc cả hai. Hãy mở công cụ lập kế hoạch để kiểm tra điều kiện bổ sung cho ") + period + ".");
  }
  if ((plan.mode === "dates" || plan.missionHours !== null) && (!Number.isSafeInteger(plan.missionHours) || !plan.missionHours || plan.missionHours < 1 || plan.missionHours > span)) return reply(tr(
    "How many hours should the mission last? Choose a whole number of hours within " + period + ".",
    "Bạn muốn nhiệm vụ kéo dài bao nhiêu giờ? Hãy chọn số giờ nguyên nằm trong khoảng " + period + "."));
  const unavailable = tr("I could not verify team-model results for ", "Mình chưa xác minh được kết quả mô hình của nhóm cho ") + period + tr(". Reopen the planner to retry.", ". Bạn có thể mở công cụ lập kế hoạch để thử lại.");
  const noVisibility = tr("No evaluated option provides any hours of the requested visibility.", "Không có lựa chọn nào cho giờ quan sát đáp ứng tiêu chí này.");
  const key = ({ joint: "bothHours", sun: "sunHours", earth: "earthHours" } as const)[plan.priority];
  const flatNote = translate(locale, "Outside elevation-map coverage. This site uses a smooth-sphere horizon and omits local terrain shadows.");
  function outsideRun(run: Pick<PlannerRun, "start" | "end" | "runId">) {
    return reply(tr("The requested dates are outside the model run. Available UTC range: ", "Ngày yêu cầu nằm ngoài phạm vi mô hình. Khoảng UTC có dữ liệu: ") + run.start + " → " + run.end + tr(" (exclusive)", " (không gồm mốc cuối)") + " · " + run.runId);
  }
  function missionReply(result: MissionWindowRanking, sites: PlannerRun["sites"], source: string) {
    const scope = result.scope === "pair"
      ? tr("Saved comparison only · Odysseus and Athena", "Chỉ xét kết quả so sánh đã lưu · Odysseus và Athena")
      : tr("Sites with complete coverage", "Địa điểm có đủ dữ liệu") + " · " + result.rows.length + "/" + sites.length;
    const winners = result.rows.filter(row => result.leaders.includes(row.id) && row[key] > 0);
    const lines = [period, tr("Mission duration", "Thời lượng nhiệm vụ") + " · " + result.missionHours + " h", scope];
    if (!result.rows.length) lines.push(tr("No catalog site has complete coverage for this ranking.", "Chưa có địa điểm nào đủ dữ liệu để xếp hạng."));
    else if (!winners.length) lines.push(noVisibility);
    else {
      lines.push(metric + " · " + winners[0][key] + "/" + result.missionHours + " h",
        tr("Earliest best window at each tied site (UTC)", "Khoảng tốt nhất sớm nhất ở mỗi địa điểm đồng hạng (UTC)"));
      for (const row of winners) lines.push(row.name + " · " + row.start + " → " + row.end);
      const flat = winners.filter(row => usesSmoothSphere(sites.find(site => site.id === row.id)));
      if (flat.length) lines.push(flat.map(site => site.name).join(" · ") + " — " + flatNote);
    }
    return reply(lines.join("\n") + source);
  }
  function offline() {
    const legacy = fallback === "saved";
    const run = legacy ? savedPlannerRun : archiveB2Run;
    href = plannerHref(plan, undefined, fallback);
    const savedSource = "\n" + tr("Saved run", "Run đã lưu") + " · " + run.runId;
    const matches = matchSites(plan.siteText, run.sites);
    if (from < run.start || to > run.end) return outsideRun(run);
    if (matches.length > 1) return reply(tr("Which catalog site do you mean? ", "Bạn muốn chọn địa điểm nào? ") + matches.map(s => s.name).join(" · "));
    if (plan.mode === "sites" && !matches.length && plan.missionHours !== null) {
      const result = rankSavedMissionWindows(fallback, { from, to, priority: plan.priority, missionHours: plan.missionHours });
      return result ? missionReply(result, run.sites, savedSource) : reply(tr("The archive has no site windows covering these dates.", "Bản lưu không có các khoảng quan sát bao phủ những ngày này.") + savedSource);
    }
    if (plan.mode === "dates" || (plan.mode === "sites" && plan.missionHours !== null)) {
      if (!matches.length) return reply(tr("Which catalog site should I check? Please give its name or ID.", "Bạn muốn tra địa điểm nào trong danh mục? Hãy ghi tên hoặc mã."));
      const site = matches[0];
      href = plannerHref({ ...plan, mode: "dates" }, site.id, fallback);
      const lookup = legacy ? getSavedPlannerDates : searchArchiveB2;
      const search = lookup({ ...plan, from, to, siteId: site.id, missionHours: plan.missionHours! });
      if (!search) return reply(unavailable + savedSource);
      const first = search.rows[0], ties = "ties" in search ? search.ties : search.rows.filter(r => r[key] === first[key]).length;
      if (!first[key]) return reply(site.name + "\n" + period + "\n" + noVisibility + savedSource);
      return reply(tr("Saved hourly observations", "Các mẫu giờ đã lưu") + " · " + site.name + "\n" + period
        + "\n" + tr("Earliest highest-visibility mission window", "Khoảng nhiệm vụ sớm nhất đạt mức quan sát cao nhất") + " · " + first.start + " → " + first.end
        + "\n" + metric + " · " + first[key] + " h · " + tr(ties + " tied starts out of " + search.nEvaluated, ties + " mốc đồng hạng trong " + search.nEvaluated + " mốc") + savedSource);
    }
    const ranking = (legacy ? getSavedPlannerRanking : rankArchiveB2)({ ...plan, from, to });
    if (!ranking) return reply(unavailable + savedSource);
    const scope = ranking.scope === "catalog" ? tr("Saved catalog · 23 sites", "Danh mục đã lưu · 23 địa điểm")
      : tr("Saved comparison only · Odysseus and Athena", "Chỉ xét kết quả so sánh đã lưu · Odysseus và Athena");
    const site = matches[0];
    if (site || plan.mode === "observation") {
      const row = ranking.rows.find(r => r.id === site?.id);
      if (!row) return reply(unavailable + savedSource);
      const hours = savedPlannerWindows.pair;
      const canInspectMission = !legacy || (hours.siteIds.includes(row.id) && hours.from <= from && to <= hours.to);
      href = canInspectMission ? plannerHref({ ...plan, mode: "dates", missionHours: span }, row.id, fallback)
        : plannerHref(plan, row.id, fallback);
      return reply(scope + "\n" + row.name + "\n" + period + "\n" + tr("Sun / Earth / both", "Mặt Trời / Trái Đất / cả hai") + " · "
        + [row.sunHours, row.earthHours, row.bothHours].join(" / ") + " h" + savedSource);
    }
    if (!ranking.rows[0][key]) return reply(scope + "\n" + period + "\n" + noVisibility + savedSource);
    return reply(scope + "\n" + period + "\n" + metric + " · " + ranking.rows.filter(r => ranking.leaders.includes(r.id))
      .map(r => r.name + " · " + r[key] + " h").join("\n") + savedSource);
  }
  if (archive || !api.online) return offline();
  try {
    const run = liveRun ?? await api.run(signal);
    href = plannerHref(plan, undefined, run);
    if (run.runId === savedPlannerRun.runId) fallback = "saved";
    if (from < run.start || to > run.end) return outsideRun(run);
    const matches = matchSites(plan.siteText, run.sites);
    const source = "\n" + tr("Source run", "Run nguồn") + " · " + run.runId;
    if (plan.mode === "sites" && !matches.length) {
      if (plan.missionHours !== null) {
        const { ranking } = await api.missionRanking(run, { from, to, priority: plan.priority, missionHours: plan.missionHours }, signal);
        return missionReply(ranking, run.sites, source);
      }
      const result = await api.ranking(run, { from, to, priority: plan.priority }, signal);
      const winners = result.evidence.sites.filter(s => result.recommendedIds.includes(s.id));
      const key = ({ joint: "both_hours", sun: "sun_hours", earth: "earth_hours" } as const)[plan.priority];
      if (winners.length && winners.every(s => s.metrics?.[key] === 0)) return reply(period + "\n" + noVisibility + source);
      const rows = winners.map(s => s.name + " · " + s.metrics![key] + " h");
      return reply(period + "\n" + (rows.length
        ? tr("Highest " + metric + " among catalog sites with complete coverage", "Các địa điểm có tỷ lệ " + metric + " cao nhất trong số các địa điểm có đủ dữ liệu") + ":\n" + rows.join("\n")
        : tr("No catalog site has complete coverage for this ranking.", "Chưa có địa điểm nào đủ dữ liệu để xếp hạng.")) + source);
    }
    if (matches.length !== 1) return reply((matches.length ? tr("Which of these sites do you mean? ", "Bạn muốn chọn địa điểm nào trong số này? ") + matches.map(s => s.name).join(" · ")
      : tr("Which catalog site should I check? Please give its name or ID, for example Athena.", "Bạn muốn tra địa điểm nào trong danh mục? Hãy ghi tên hoặc mã, ví dụ Athena.")));
    const [site] = matches;
    href = plannerHref(plan, site.id, run);
    if (plan.mode !== "dates" && !(plan.mode === "sites" && plan.missionHours !== null)) {
      const result = await api.observation({ from, to, resolutionSeconds: run.stepSeconds }, site.id, run.runId, false, signal);
      const row = result.sites[0];
      if (!row || row.id !== site.id || result.range.start !== from || result.range.end !== to) return reply(unavailable);
      const query = new URLSearchParams({ run_id: run.runId, site_id: site.id, view_site: site.id, from, to, resolutionSeconds: String(run.stepSeconds) });
      href = "/compare?" + query + "#terrain-observations";
      const m = row.coverage === "complete" && row.coverage_in_range === "complete" ? row.metrics : null;
      return reply(site.name + "\n" + period + "\n" + (m
        ? tr("Sun / Earth / both", "Mặt Trời / Trái Đất / cả hai") + " · " + [m.sun_hours, m.earth_hours, m.both_hours].join(" / ") + " h"
        : tr("The model has incomplete coverage for these hours.", "Mô hình thiếu dữ liệu trong khoảng này.")) + source);
    }
    href = plannerHref({ ...plan, mode: "dates" }, site.id, run);
    const hours = plan.missionHours!;
    const latest = new Date(Date.parse(to) - hours * 3600000).toISOString().replace(".000Z", "Z");
    const search = await api.dates({ run_id: run.runId, site_id: site.id, earliest: from, latest, mission_h: hours, max_results: 1,
      constraints: { objective: plan.priority === "joint" ? "both" : plan.priority, require_sun_at_landing: false } }, run.stepSeconds, signal, run.start);
    const candidate = search.candidates[0];
    if (candidate && candidate[({ joint: "both_pct", sun: "sun_pct", earth: "earth_pct" } as const)[plan.priority]] === 0) return reply(site.name + "\n" + period + "\n" + noVisibility + source);
    return reply(site.name + "\n" + period + "\n" + (candidate ? tr("Top returned mission window", "Khoảng nhiệm vụ được mô hình xếp đầu") + " · " + candidate.landing_utc + " → " + candidate.mission_end_utc
      + "\n" + tr("Sun / Earth / both", "Mặt Trời / Trái Đất / cả hai") + " · " + [candidate.sun_pct, candidate.earth_pct, candidate.both_pct].map(v => v + "%").join(" / ")
      : tr("No qualifying model window was returned.", "Mô hình không trả về khoảng nào đáp ứng yêu cầu.")) + source);
  } catch {
    signal.throwIfAborted();
    if (liveRun) return reply(unavailable + "\n" + tr("Source run", "Run nguồn") + " · " + liveRun.runId);
    return offline();
  }
}

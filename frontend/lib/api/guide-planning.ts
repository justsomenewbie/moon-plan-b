import { getSavedPlannerDates, getSavedPlannerRanking, savedPlannerRun } from "../saved-planner.ts";
import { findAltDates } from "./alt-dates.ts";
import { getTerrainAggregate, isMock } from "./client.ts";
import { getPlannerRanking, getPlannerRun } from "./planner.ts";
import type { PlanningIntent } from "../guide-planning.ts";

type Locale = "en" | "vi";
type Site = { id: string; name: string };
export type PlanningAnswer = { answer: string; href: string };
type Services = { run: typeof getPlannerRun; ranking: typeof getPlannerRanking; dates: typeof findAltDates; observation: typeof getTerrainAggregate; online: boolean };
const services: Services = { run: getPlannerRun, ranking: getPlannerRanking, dates: findAltDates, observation: getTerrainAggregate, online: !isMock };

const normalize = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, " ").trim();
export function matchSites(text: string, sites: readonly Site[]) {
  const query = " " + normalize(text) + " ";
  // Prefer a mission designation or exact site name over a shared term such as “Apollo” or “Nobile”.
  const exact = sites.map(site => {
    const title = normalize(site.name.split("(")[0].split(":").at(-1) ?? "");
    const designation = title.match(/^(?:apollo|im|chang e|chandrayaan) ?\d+/)?.[0];
    const matched = [normalize(site.id), title, designation].filter((p): p is string => Boolean(p && query.includes(" " + p + " ")));
    return { site, matched };
  }).filter(row => row.matched.length);
  if (exact.length) {
    // A longer catalog name can contain a shorter one, such as “Mons Mouton Plateau”.
    const longest = exact.filter(row => row.matched.some(p => !exact.some(other => other.site !== row.site &&
      other.matched.some(full => full.length > p.length && (" " + full + " ").includes(" " + p + " ")))));
    return longest.map(row => row.site);
  }
  return sites.filter(site => {
    const tokens = normalize(site.name.split("(")[0] + " " + site.id).split(" ");
    return tokens.some(token => token.length >= 4
      && !["region", "artemis", "site", "landing", "connecting", "crater", "point", "near", "peak", "plain", "plateau", "slope", "ridge", "mons"].includes(token)
      && query.includes(" " + token + " "));
  });
}

function plannerHref(plan: PlanningIntent, site?: string) {
  const params = new URLSearchParams({ mode: plan.mode === "dates" ? "dates" : "sites", priority: plan.priority });
  if (plan.from) params.set("from", plan.from);
  if (plan.to) params.set("to", plan.to);
  if (site) params.set("site", site);
  if (plan.mode === "dates" && plan.missionHours && Number.isSafeInteger(plan.missionHours)) params.set("missionHours", String(plan.missionHours));
  return "/plan?" + params;
}

export async function answerPlanning(plan: PlanningIntent, locale: Locale, signal: AbortSignal, api: Services = services): Promise<PlanningAnswer> {
  signal.throwIfAborted();
  const tr = (en: string, vi: string) => locale === "en" ? en : vi;
  let href = plannerHref(plan);
  const reply = (text: string) => ({ answer: text, href });
  const metric = { joint: tr("joint Sun and Earth visibility", "thấy đồng thời Mặt Trời và Trái Đất"), sun: tr("Sun visibility", "thấy Mặt Trời"), earth: tr("Earth visibility", "thấy Trái Đất") }[plan.priority];
  if (!plan.from || !plan.to || plan.dateProblem) return reply(tr("What start and end dates should I check? Use UTC dates with the year, e.g. 2026-11-21 to 2026-11-28. The end is exclusive.", "Bạn muốn kiểm tra khoảng ngày nào? Hãy ghi đủ năm, ví dụ 2026-11-21 đến 2026-11-28 theo UTC. Ngày kết thúc không được tính."));
  const from = plan.from + "T00:00:00Z", to = plan.to + "T00:00:00Z";
  const span = (Date.parse(to) - Date.parse(from)) / 3600000;
  const period = from + " → " + to + tr(" (exclusive)", " (không gồm mốc cuối)");
  const qualifications = /\b(?:at least|at most|without|except|least|fewest|shortest|minimum|exclude|not|battery|fuel|power)\b|ngoại trừ|ít nhất|ít hơn|ngắn hơn|tối thiểu|tối đa|không (?:có|gồm)|pin sống|nhiên liệu|công suất/i;
  if (qualifications.test(plan.siteText)) return reply(tr("The chat search ranks only total Sun, Earth or joint visibility. Open the planner to check your additional conditions for ", "Chat chỉ xếp hạng theo tổng thời gian thấy Mặt Trời, Trái Đất hoặc cả hai. Hãy mở công cụ lập kế hoạch để kiểm tra điều kiện bổ sung cho ") + period + ".");
  if (plan.mode === "dates" && (!Number.isSafeInteger(plan.missionHours) || !plan.missionHours || plan.missionHours < 1 || plan.missionHours > span)) return reply(tr(
    "How many hours or days should the mission last within " + period + "?",
    "Bạn muốn nhiệm vụ kéo dài bao nhiêu giờ hoặc ngày trong khoảng " + period + "?"));
  const unavailable = tr("I could not verify team-model results for ", "Mình chưa xác minh được kết quả mô hình của nhóm cho ") + period + tr(". Reopen the planner to retry.", ". Bạn có thể mở công cụ lập kế hoạch để thử lại.");
  function offline() {
    const savedSource = "\n" + tr("Saved run", "Run đã lưu") + " · " + savedPlannerRun.runId;
    const matches = matchSites(plan.siteText, savedPlannerRun.sites);
    const key = ({ joint: "bothHours", sun: "sunHours", earth: "earthHours" } as const)[plan.priority];
    if (matches.length > 1) return reply(tr("Which catalog site do you mean? ", "Bạn muốn chọn địa điểm nào? ") + matches.map(s => s.name).join(" · "));
    if (plan.mode === "dates") {
      if (!matches.length) return reply(tr("Which catalog site should I check? Please give its name or ID.", "Bạn muốn tra địa điểm nào trong danh mục? Hãy ghi tên hoặc mã."));
      const site = matches[0];
      href = plannerHref(plan, site.id);
      const search = getSavedPlannerDates({ ...plan, from, to, siteId: site.id, missionHours: plan.missionHours! });
      if (!search) return reply(unavailable);
      const first = search.rows[0], ties = search.rows.filter(r => r[key] === first[key]).length;
      return reply(tr("Saved hourly observations", "Các mẫu giờ đã lưu") + " · " + site.name + "\n" + period
        + "\n" + tr("Earliest highest-visibility mission window", "Khoảng nhiệm vụ sớm nhất đạt mức quan sát cao nhất") + " · " + first.start + " → " + first.end
        + "\n" + metric + " · " + first[key] + " h · " + tr(ties + " tied starts out of " + search.nEvaluated, ties + " mốc đồng hạng trong " + search.nEvaluated + " mốc") + savedSource);
    }
    const ranking = getSavedPlannerRanking({ ...plan, from, to });
    if (!ranking) return reply(unavailable);
    const scope = ranking.scope === "catalog" ? tr("Saved catalog · 23 sites", "Danh mục đã lưu · 23 địa điểm")
      : tr("Saved comparison only · Odysseus and Athena", "Chỉ xét kết quả so sánh đã lưu · Odysseus và Athena");
    const site = matches[0];
    if (site || plan.mode === "observation") {
      const row = ranking.rows.find(r => r.id === site?.id);
      if (!row) return reply(unavailable);
      return reply(scope + "\n" + row.name + "\n" + period + "\n" + tr("Sun / Earth / both", "Mặt Trời / Trái Đất / cả hai") + " · "
        + [row.sunHours, row.earthHours, row.bothHours].join(" / ") + " h" + savedSource);
    }
    return reply(scope + "\n" + period + "\n" + metric + " · " + ranking.rows.filter(r => ranking.leaders.includes(r.id))
      .map(r => r.name + " · " + r[key] + " h").join("\n") + savedSource);
  }
  if (!api.online) return offline();
  try {
    const run = await api.run(signal);
    if (Date.parse(from) < Date.parse(run.start) || Date.parse(to) > Date.parse(run.end)) return reply(tr("The requested dates are outside the model run. Available UTC range: ", "Ngày yêu cầu nằm ngoài phạm vi mô hình. Khoảng UTC có dữ liệu: ") + run.start + " → " + run.end + " · " + run.runId);
    const matches = matchSites(plan.siteText, run.sites);
    const source = "\n" + tr("Source run", "Run nguồn") + " · " + run.runId;
    if (plan.mode === "sites" && !matches.length) {
      const result = await api.ranking(run, { from, to, priority: plan.priority }, signal);
      const winners = result.evidence.sites.filter(s => result.recommendedIds.includes(s.id));
      const key = ({ joint: "both_hours", sun: "sun_hours", earth: "earth_hours" } as const)[plan.priority];
      const rows = winners.map(s => s.name + " · " + s.metrics![key] + " h");
      return reply(period + "\n" + (rows.length
        ? tr("Highest " + metric + " among catalog sites with complete coverage", "Các địa điểm có tỷ lệ " + metric + " cao nhất trong số các địa điểm có đủ dữ liệu") + ":\n" + rows.join("\n")
        : tr("No catalog site has complete coverage for this ranking.", "Chưa có địa điểm nào đủ dữ liệu để xếp hạng.")) + source);
    }
    if (matches.length !== 1) return reply((matches.length ? tr("Which of these sites do you mean? ", "Bạn muốn chọn địa điểm nào trong số này? ") + matches.map(s => s.name).join(" · ")
      : tr("Which catalog site should I check? Please give its name or ID, for example Athena.", "Bạn muốn tra địa điểm nào trong danh mục? Hãy ghi tên hoặc mã, ví dụ Athena.")));
    const [site] = matches;
    href = plannerHref(plan, site.id);
    if (plan.mode !== "dates") {
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
    const hours = plan.missionHours!;
    const latest = new Date(Date.parse(to) - hours * 3600000).toISOString().replace(".000Z", "Z");
    const search = await api.dates({ run_id: run.runId, site_id: site.id, earliest: from, latest, mission_h: hours, max_results: 1,
      constraints: { objective: plan.priority === "joint" ? "both" : plan.priority, require_sun_at_landing: false } }, run.stepSeconds, signal, run.start);
    const candidate = search.candidates[0];
    return reply(site.name + "\n" + period + "\n" + (candidate ? tr("Top returned mission window", "Khoảng nhiệm vụ được mô hình xếp đầu") + " · " + candidate.landing_utc + " → " + candidate.mission_end_utc
      + "\n" + tr("Sun / Earth / both", "Mặt Trời / Trái Đất / cả hai") + " · " + [candidate.sun_pct, candidate.earth_pct, candidate.both_pct].map(v => v + "%").join(" / ")
      : tr("No qualifying model window was returned.", "Mô hình không trả về khoảng nào đáp ứng yêu cầu.")) + source);
  } catch {
    signal.throwIfAborted();
    return offline();
  }
}

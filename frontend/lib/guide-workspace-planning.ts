import type { SiteComparison } from "./api/compare-sites.ts";
import type { GuideContext } from "./api/guide-chat.ts";
import type { TerrainSummary } from "./api/terrain-summary.ts";
import { hasPlanningQualifications, matchSites, validDay, type PlanningIntent } from "./guide-planning.ts";
import { describeLongestJoint, longestJointWindow } from "./joint-window.ts";
import { rankRetainedMissionWindows, type RetainedSiteWindows } from "./mission-window-ranking.ts";

export type WorkspacePlanningEvidence = TerrainSummary | SiteComparison;

export function retainedWindows(evidence: WorkspacePlanningEvidence, coverage: "requested" | "evaluated" = "requested") {
  if ("schema_version" in evidence) return {
    run: evidence.run.run_id, range: evidence.range,
    sites: evidence.sites.map(site => ({
      id: site.id, name: site.name, windows: site.windows,
      complete: site.coverage_in_range === "complete" && (coverage === "evaluated" || site.coverage === "complete"),
    })),
  };
  const sites: RetainedSiteWindows[] = evidence.ranking.map(({ site_id, name }) => {
    const spans = evidence.sites[site_id].windows;
    return { id: site_id, name, complete: evidence.coverageBySite[site_id] === "complete" && !!spans,
      windows: { sun: spans?.sun?.filter(w => w.state) ?? [], earth: spans?.earth?.filter(w => w.state) ?? [], both: spans?.both?.filter(w => w.state) ?? [] } };
  });
  return { run: evidence.run_id, range: evidence.range, sites };
}

const hour = 3600000;
const allSites = /\b(?:where|(?:which|what)\s+(?:lunar\s+|landing\s+)?(?:site|place|location|destination)s?|best\s+(?:site|place|destination))\b|địa điểm nào|nơi nào|ở đâu|đi đâu|chỗ nào|điểm nào/i;
const metric = { joint: "bothHours", sun: "sunHours", earth: "earthHours" } as const;

export function answerWorkspacePlanning(plan: PlanningIntent, locale: "en" | "vi", context: GuideContext, evidence?: WorkspacePlanningEvidence | null) {
  const tr = (en: string, vi: string) => locale === "vi" ? vi : en;
  const reply = (answer: string, action: "workspace" | null = null) => ({ answer, action });
  if (context.kind === "synthetic") return reply(tr("This workspace contains a fictional demonstration. Planning requires model data.", "Không gian này chứa dữ liệu minh họa giả lập. Cần dữ liệu mô hình để lập kế hoạch."));
  if (!context.rows.length || context.kind === "unavailable") return reply(tr("No verified comparison is open in this workspace.", "Không gian này chưa có kết quả so sánh đã xác minh."));
  if (context.kind === "scenario") {
    if (plan.longestJoint) return reply(tr(
      "The guide has summary totals for this scenario. Ranking uninterrupted visibility requires the site's joint intervals. Open the comparison to inspect the recorded windows.",
      "Phi hành gia chỉ có số giờ tổng hợp cho kịch bản này. Để xếp hạng tầm nhìn liên tục cần các khoảng đồng thời của từng địa điểm. Hãy mở kết quả so sánh để xem các khoảng đã ghi."
    ), "workspace");
    const available = tr("This scenario records totals for these exact site windows: ", "Kịch bản có số giờ tổng hợp cho các địa điểm và khoảng sau: ") +
      context.rows.map(row => row.site + " · " + row.from + " → " + row.to + " UTC · " + row.source).join("\n");
    const from = plan.from + "T00:00:00Z", to = plan.to + "T00:00:00Z";
    const span = (Date.parse(to) - Date.parse(from)) / hour;
    if (!validDay(plan.from) || !validDay(plan.to) || plan.dateProblem || from >= to || hasPlanningQualifications(plan.siteText) ||
        (plan.missionHours !== null && plan.missionHours !== span) || (plan.mode === "dates" && plan.missionHours === null)) return reply(available, "workspace");
    const named = matchSites(plan.siteText, [...new Set(context.rows.map(row => row.site))].map(name => ({ id: name, name })));
    if (named.length > 1) return { ...reply(available, "workspace"), siteChoices: named };
    if (!named.length && (plan.mode !== "sites" || !allSites.test(plan.siteText))) return reply(available, "workspace");
    const exact = context.rows.filter(row => Date.parse(row.from) === Date.parse(from) && Date.parse(row.to) === Date.parse(to) && (!named.length || row.site === named[0].name));
    if (!exact.length || new Set(exact.map(row => row.site)).size !== exact.length) return reply(available, "workspace");
    const field = metric[plan.priority];
    const complete = exact.filter(row => row.sunHours !== null && row.earthHours !== null && row.bothHours !== null);
    if (!complete.length) return reply(tr("This scenario has no complete totals for that site window. ", "Kịch bản chưa có đủ số giờ tổng hợp cho địa điểm và khoảng thời gian này. ") + available, "workspace");
    const best = Math.max(...complete.map(row => row[field]!));
    const lines = [tr("Exact scenario window", "Khoảng thời gian của kịch bản") + " · " + from + " → " + to + tr(" (UTC, end excluded)", " (UTC, không gồm mốc cuối)"),
      tr("Sites with complete totals", "Địa điểm có đủ số giờ tổng hợp") + " · " + complete.length + "/" + exact.length];
    if (!best) lines.push(tr("No evaluated site has any hours of the requested visibility.", "Các địa điểm đã đánh giá đều có 0 giờ đáp ứng tiêu chí tầm nhìn này."));
    for (const row of complete.filter(row => row[field] === best)) lines.push(row.site + " · " + tr("Sun / Earth / both", "Mặt Trời / Trái Đất / cả hai") +
      " · " + [row.sunHours, row.earthHours, row.bothHours].join(" / ") + " h · " + row.source);
    return reply(lines.join("\n"), "workspace");
  }
  const retained = context.kind === "terrain" && evidence ? retainedWindows(evidence) : null;
  if (!retained || context.rows.some(row => row.source !== retained.run || row.from !== retained.range.start || row.to !== retained.range.end ||
      !retained.sites.some(site => site.name === row.site))) {
    return reply(tr("This workspace has summary totals only. Open its comparison for the recorded sites and dates. Planning a different window requires retained visibility intervals.", "Không gian này chỉ có số giờ tổng hợp. Mở kết quả so sánh để xem địa điểm và thời gian đã ghi. Muốn tính khoảng khác cần có các khoảng quan sát gốc."), "workspace");
  }
  const period = (from: string, to: string) => from + " → " + to + tr(" (UTC, end excluded)", " (UTC, không gồm mốc cuối)");
  const source = tr("Selected model run", "Lần chạy đã chọn") + " · " + retained.run;
  const scoped = (answer: string) => reply(answer + "\n" + source, "workspace");
  if (!plan.longestJoint && hasPlanningQualifications(plan.siteText)) return scoped(tr("This search can count hours of Sun, Earth or joint visibility. The extra condition needs a separate evaluation.", "Phép tính này chỉ đếm giờ nhìn thấy Mặt Trời, Trái Đất hoặc cả hai. Điều kiện bổ sung cần được đánh giá riêng."));
  if (!validDay(plan.from) || !validDay(plan.to) || plan.dateProblem || plan.from >= plan.to) return scoped(
    tr("Give the UTC start and exclusive end dates inside the retained window: ", "Hãy ghi ngày bắt đầu và ngày kết thúc (không tính ngày cuối) theo UTC trong khoảng đã lưu: ") + period(retained.range.start, retained.range.end));
  const from = plan.from + "T00:00:00Z", to = plan.to + "T00:00:00Z";
  if (from < retained.range.start || to > retained.range.end) return scoped(tr("The requested dates extend outside this workspace. Retained window: ", "Khoảng yêu cầu nằm ngoài dữ liệu của không gian này. Khoảng đã lưu: ") + period(retained.range.start, retained.range.end));
  const spanHours = (Date.parse(to) - Date.parse(from)) / hour;
  const duration = plan.missionHours ?? spanHours;
  if ((plan.mode === "dates" && plan.missionHours === null) || !Number.isSafeInteger(duration) || duration < 1 ||
      duration > spanHours || duration * 3600 % retained.range.step_s !== 0) return scoped(tr("Give one whole mission duration in hours that fits the requested dates and model step.", "Hãy chọn một thời lượng nhiệm vụ tính bằng số giờ nguyên, vừa khoảng ngày và phù hợp bước thời gian của mô hình."));

  const matches = matchSites(plan.siteText, retained.sites);
  if (matches.length > 1) return { ...scoped(tr("Which of these retained sites should I use? ", "Bạn muốn sử dụng địa điểm nào đã lưu? ") + matches.map(s => s.name).join(" · ")), siteChoices: matches };
  if (!matches.length && (plan.mode !== "sites" || !allSites.test(plan.siteText))) return scoped(
    tr("Which retained site should I check? Available sites: ", "Bạn muốn kiểm tra địa điểm nào đã lưu? Các địa điểm có dữ liệu: ") + retained.sites.map(s => s.name).join(" · "));
  const sites = matches.length ? retained.sites.filter(s => s.id === matches[0].id) : retained.sites;
  const complete = sites.filter(site => site.complete), incomplete = sites.filter(site => !site.complete);
  const entries = [period(from, to), tr("Sites with complete coverage in this selection", "Địa điểm đủ dữ liệu trong phạm vi đã chọn") + " · " + complete.length + "/" + sites.length];
  if (incomplete.length) entries.push(tr("Incomplete coverage", "Dữ liệu chưa đầy đủ") + " · " + incomplete.map(site => site.name).join(" · "));
  if (plan.longestJoint) {
    entries.push(describeLongestJoint(complete.map(site => ({
      name: site.name, window: longestJointWindow(site.windows.both, from, to),
    })), locale));
    return scoped(entries.join("\n"));
  }
  const result = rankRetainedMissionWindows(retained.run, retained.range, sites, { from, to, priority: plan.priority, missionHours: duration });
  if (!result) return scoped(tr("The retained intervals cannot support this request on the model grid.", "Không thể tính yêu cầu này từ các khoảng đã lưu trên lưới thời gian của mô hình."));
  if (!result.rows.length) return scoped(entries.join("\n"));
  const objective = metric[plan.priority];
  const winners = result.rows.filter(row => result.leaders.includes(row.id));
  const criterion = plan.priority === "sun" ? tr("Sunlight", "Ánh sáng Mặt Trời") : plan.priority === "earth" ? tr("Earth visibility", "Tầm nhìn Trái Đất") : tr("Joint Sun and Earth visibility", "Đồng thời thấy Mặt Trời và Trái Đất");
  if (!winners[0][objective]) entries.push(tr("No evaluated site has any hours of the requested visibility.", "Các địa điểm đã đánh giá đều có 0 giờ đáp ứng tiêu chí tầm nhìn này."));
  if (plan.missionHours !== null) entries.push(tr("Mission duration", "Thời lượng nhiệm vụ") + " · " + duration + " h");
  for (const row of winners) {
    if (row[objective] === 0 && !matches.length) break;
    entries.push(row.name + " · " + criterion + " · " + row[objective] + " h");
    if (plan.missionHours !== null && row[objective] > 0) entries.push(tr("Earliest best window", "Khoảng tốt nhất sớm nhất") + " · " + period(row.start, row.end) +
      "\n" + tr("Equally scoring starts", "Số mốc bắt đầu đồng hạng") + " · " + row.ties + "/" + result.nEvaluated);
    entries.push(tr("Sun / Earth / both", "Mặt Trời / Trái Đất / cả hai") + " · " + [row.sunHours, row.earthHours, row.bothHours].join(" / ") + " h");
  }
  return scoped(entries.join("\n"));
}

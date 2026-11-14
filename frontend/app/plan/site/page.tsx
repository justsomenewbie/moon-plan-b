"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { archiveB2Run, rankArchiveB2 } from "../../../lib/archive-b2";
import { getSavedPlannerRanking, savedPlannerRun } from "../../../lib/saved-planner";
import { plannerLink } from "../../../lib/planner-source";
import { lrocSiteUrl } from "../../../lib/globe-sites";
import { LanguageControl, useLanguage } from "../../language";
import { SiteFooter, SkyBackground } from "../../site-chrome";
import { SiteHorizonSource, TimeRange } from "../../terrain-site-result";
import ThemeControl from "../../theme-control";
import B2CoordinateSource from "../../b2-coordinate-source";

const fields = ["source", "site", "from", "to", "priority"] as const;
const savedBound = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:00:00Z)?$/;
const priorities = { joint: "Sun and Earth together", sun: "Sunlight", earth: "Earth visibility" } as const;

function SiteReport() {
  const query = useSearchParams();
  const { locale, t } = useLanguage();
  const text = (en: string, vi: string) => locale === "vi" ? vi : en;
  const source = query.get("source");
  const siteId = query.get("site");
  const from = query.get("from") ?? "", to = query.get("to") ?? "";
  const priority = query.get("priority");
  const run = source === "saved-b2" ? archiveB2Run : source === "saved" ? savedPlannerRun : null;
  const valid = run && siteId && fields.every(key => query.getAll(key).length === 1) &&
    savedBound.test(from) && savedBound.test(to) &&
    (priority === "joint" || priority === "sun" || priority === "earth");
  const ranking = valid && (source === "saved-b2" ? rankArchiveB2 : getSavedPlannerRanking)({ from, to, priority });
  const site = run?.sites.find(row => row.id === siteId);
  const row = ranking && ranking.rows.find(row => row.id === siteId);
  const planner = new URLSearchParams({ mode: "sites" });
  if (run && source) planner.set("source", source);
  if (ranking && priority) {
    const searchFrom = query.get("searchFrom") ?? "", searchTo = query.get("searchTo") ?? "";
    const duration = Number(query.get("missionHours"));
    const reproducible = ["searchFrom","searchTo","missionHours"].every(key => query.getAll(key).length === 1) &&
      /^\d{4}-\d{2}-\d{2}$/.test(searchFrom) && /^\d{4}-\d{2}-\d{2}$/.test(searchTo) &&
      Number.isSafeInteger(duration) && duration > 0 && Date.parse(ranking.to) - Date.parse(ranking.from) === duration * 3600000 &&
      Date.parse(searchFrom) <= Date.parse(ranking.from) && Date.parse(searchTo) >= Date.parse(ranking.to);
    planner.set("from", reproducible ? searchFrom : from.slice(0, 10));
    planner.set("to", reproducible ? searchTo : new Date(Math.ceil(Date.parse(ranking.to) / 86400000) * 86400000).toISOString().slice(0,10));
    if (reproducible) planner.set("missionHours", String(duration));
    planner.set("priority", priority);
    if (row) planner.set("site", row.id);
  }
  const back = plannerLink("/plan", planner, query.getAll("run_id"));
  if (!ranking || !site || !row) {
    const message = !valid ? text("This link needs a saved run, a site, two UTC dates and a visibility priority.", "Đường dẫn cần có lần chạy đã lưu, địa điểm, ngày bắt đầu và kết thúc theo UTC cùng tiêu chí xếp hạng.")
      : !ranking ? text("The selected archive has no result for these dates. Choose an available range in the planner.", "Bộ dữ liệu đã chọn không có kết quả cho khoảng ngày này. Hãy chọn khoảng ngày có dữ liệu trong công cụ lập kế hoạch.")
      : !site ? text("This site is absent from the selected run’s catalog.", "Địa điểm này không có trong danh mục của lần chạy đã chọn.")
      : text("The saved results for these dates include only Odysseus and Athena.", "Kết quả đã lưu cho khoảng ngày này chỉ gồm Odysseus và Athena.");
    return <><h1 id="site-title" tabIndex={-1}>{text("Site details unavailable", "Chưa có thông tin địa điểm")}</h1>
      <p>{message}</p><a href={back}>{text("Return to the planner", "Quay lại công cụ lập kế hoạch")}</a></>;
  }
  const folder = source === "saved-b2" ? "/data/run-b2" : "/data/run-b";
  const sourceInfo = source === "saved-b2" ? "/data#run-b2" : "/data#bundled-data";
  const metrics = [
    [text("Sun visible", "Nhìn thấy Mặt Trời"), row.sunHours],
    [text("Earth visible", "Nhìn thấy Trái Đất"), row.earthHours],
    [text("Sun and Earth visible together", "Đồng thời nhìn thấy Mặt Trời và Trái Đất"), row.bothHours],
  ] as const;
  return <>
    <a href={back}>{text("Back to these site results", "Quay lại kết quả tìm địa điểm")}</a>
    <h1 id="site-title" tabIndex={-1}>{site.name}</h1>
    <section className="space-y-3" aria-labelledby="site-visibility">
      <h2 id="site-visibility">{t("Visibility hours in the selected window")}</h2>
      <p><TimeRange start={ranking.from} end={ranking.to} /> · {text("end excluded", "không gồm mốc kết thúc")}</p>
      <p>{text("Ranking priority", "Tiêu chí xếp hạng")} · {t(priorities[priority])}</p>
      <dl className="grid gap-4 sm:grid-cols-3">{metrics.map(([label, hours]) => <div key={label}>
        <dt>{label}</dt><dd className="text-xl font-semibold">{hours} h</dd>
      </div>)}</dl>
    </section>
    <section className="space-y-3" aria-labelledby="site-location">
      <h2 id="site-location">{text("Reported coordinates", "Tọa độ trong danh mục")}</h2>
      <p>{t("Planetocentric latitude")} {site.lat_deg}° · {text("East longitude", "Kinh độ đông")} {site.lon_deg}° · MOON_ME</p>
      {source === "saved-b2" && <B2CoordinateSource siteId={site.id} />}
      <a href={lrocSiteUrl({ latitude: site.lat_deg, longitude: site.lon_deg })} target="_blank" rel="noreferrer">{t("View this site in LROC imagery ↗")}</a>
    </section>
    <section className="space-y-3" aria-labelledby="site-sources">
      <h2 id="site-sources">{text("Model and source files", "Mô hình và tệp nguồn")}</h2>
      <SiteHorizonSource method={site.horizonMethod} source={site.demSource} />
      <p>{t("Run ID")} · <code>{ranking.runId}</code><br/>{t("Model step")} · {ranking.stepSeconds / 3600} h</p>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <a href={folder + "/catalog.json"}>{text("Original site catalog (JSON)", "Danh mục địa điểm gốc (JSON)")}</a>
        <a href={folder + "/manifest.json"}>{text("Source file manifest (JSON)", "Danh sách tệp nguồn và mã kiểm tra (JSON)")}</a>
        <a href={sourceInfo}>{text("Data and methods for this run", "Dữ liệu và phương pháp của lần chạy này")}</a>
      </div>
    </section>
  </>;
}

export default function SitePage() {
  const { locale, t } = useLanguage();
  return <div className="app-shell"><SkyBackground />
    <a className="skip-link" href="#site-title">{t("Skip to content")}</a>
    <header className="app-header"><a href="/" className="brand">Moon Plan B</a>
      <nav aria-label={t("Main")}><a href="/data">{t("Data catalog")}</a><a href="/compare">{t("Compare")}</a><LanguageControl /><ThemeControl /></nav>
    </header>
    <main className="terrain-result mx-auto max-w-4xl space-y-6"><Suspense fallback={<p role="status">{locale === "vi" ? "Đang mở thông tin địa điểm…" : "Opening site details…"}</p>}><SiteReport /></Suspense></main>
    <SiteFooter />
  </div>;
}

"use client";

import { useState } from "react";
import manifest from "../../public/data/run-b/manifest.json";
import catalog from "../../public/data/run-b/catalog.json";
import weeks from "../../lib/odysseus-athena-weeks.json";
import { archiveB2Run } from "../../lib/archive-b2";
import { TimeRange } from "../terrain-site-result";
import { isMock } from "../../lib/api/client";
import { LanguageControl, useLanguage } from "../language";
import ThemeControl from "../theme-control";

const files = Object.entries(manifest.files);
const runFiles = files.filter(([path]) => !path.includes("/"));
const runId = catalog.run_id;
const runPath = "/api/v1/runs/" + encodeURIComponent(runId);
const summaryPath = "/api/v1/export/summary.csv?" + new URLSearchParams({ run_id: runId });
const geoPath = "/api/v1/sites?" + new URLSearchParams({ run_id: runId, format: "geojson" });
const manifestHash = "35601268e464e2e610e3cf33cf7e7b8588e59e23877857708799f29a8ac615a4";
const savedCatalogWindows = [["2026-01-01", "2031-01-01"], ["2026-11-14", "2026-11-15"], ["2026-12-01", "2026-12-04"]];
const groups: Record<string, [string, string]> = {
  south_pole: ["South pole", "Cực Nam"], reference: ["Reference sites", "Địa điểm đối chiếu"],
  apollo: ["Apollo", "Apollo"], far_side: ["Far side", "Nửa xa của Mặt Trăng"],
};

function SourceRoute({ label, path }: { label: string; path: string }) {
  return isMock ? <div className="space-y-1"><span>{label}</span><code className="block break-all text-sm">{path}</code></div>
    : <a href={path} target="_blank" rel="noreferrer">{label}</a>;
}

export default function DataPage() {
  const { locale, t } = useLanguage();
  const vi = locale === "vi";
  const text = (en: string, vietnamese: string) => vi ? vietnamese : en;
  const [siteId, setSiteId] = useState(catalog.sites[0].id);
  const site = catalog.sites.find(s => s.id === siteId) ?? catalog.sites[0];
  const siteFiles = files.filter(([path]) => path.startsWith("sites/" + site.id + "/"));
  const fileList = (items: [string, string][]) => <ul className="space-y-3">
    {items.map(([path, sha]) => <li key={path} className="min-w-0">
      <SourceRoute label={path.split("/").at(-1)!} path={runPath + "/files/" + encodeURIComponent(path)} />
      <code className="hash">SHA-256 {sha}</code>
    </li>)}
  </ul>;
  return <div className="app-shell">
    <a className="skip-link" href="#data-title">{t("Skip to content")}</a>
    <header className="app-header"><a href="/" className="brand">Moon Plan B</a>
      <nav aria-label={t("Main")}><LanguageControl /><ThemeControl /></nav>
    </header>
    <main className="terrain-result mx-auto max-w-4xl space-y-8">
      <div>
        <h1 id="data-title" tabIndex={-1}>{text("Lunar data catalog", "Danh mục dữ liệu Mặt Trăng")}</h1>
      </div>
      <section id="run-b2" className="space-y-3" aria-labelledby="b2-title">
        <h2 id="b2-title">{text("Run B2 · hourly visibility for all 23 sites", "Lần chạy B2 · tầm nhìn theo giờ cho cả 23 địa điểm")}</h2>
        <p className="lead">{text("Compare sites or search landing times throughout five model years. The saved archive includes hourly Sun, Earth and joint visibility.", "So sánh địa điểm hoặc tìm giờ hạ cánh trong suốt 5 năm mô hình. Kho lưu trữ có trạng thái nhìn thấy Mặt Trời, Trái Đất và cả hai theo giờ.")}</p>
        <p><TimeRange start={archiveB2Run.start} end={archiveB2Run.end} /> · {text("end exclusive", "không gồm mốc cuối")}</p>
        <p><code>{archiveB2Run.runId}</code><br/><code className="hash">SHA-256 {archiveB2Run.manifestSha256}</code></p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <a href="/plan?source=saved-b2&mode=sites">{text("Compare sites with run B2", "So sánh địa điểm với lần chạy B2")}</a>
          <a href="/plan?source=saved-b2&mode=dates">{text("Find landing hours with run B2", "Tìm giờ hạ cánh với lần chạy B2")}</a>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <a href="/data/run-b2/visibility.json" download="run-b2-visibility.json">{text("Hourly visibility archive (JSON)", "Kho tầm nhìn theo giờ (JSON)")}</a>
          <a href="/data/run-b2/catalog.json" download="run-b2-catalog.json">{text("B2 site catalog (JSON)", "Danh mục địa điểm B2 (JSON)")}</a>
          <a href="/data/run-b2/manifest.json" download="run-b2-manifest.json">{text("B2 source manifest (JSON)", "Manifest nguồn B2 (JSON)")}</a>
        </div>
      </section>
      <section className="space-y-3" aria-labelledby="bundled-data">
        <h2 id="bundled-data">{text("Earlier run B · bundled sources", "Lần chạy B trước đó · nguồn có sẵn")}</h2>
        <p>{text("Run B covers 23 catalog sites from 1 January 2026 through 31 December 2030, sampled every hour in UTC.",
          "Lần chạy B gồm 23 địa điểm, lấy mẫu mỗi giờ theo UTC từ ngày 1/1/2026 đến hết ngày 31/12/2030.")}</p>
        <code>{runId}</code>

        <p>{text("The manifest lists the original files and their SHA-256 checksums. The saved site catalog includes names, coordinates, terrain methods and full-run summary values.",
          "Manifest liệt kê các tệp gốc và mã SHA-256 của từng tệp. Danh mục địa điểm lưu sẵn có tên, tọa độ, phương pháp mô hình địa hình và số liệu tổng hợp của cả lần chạy.")}</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <a href="/data/run-b/manifest.json" download="manifest.json">{text("Download original manifest (JSON)", "Tải manifest gốc (JSON)")}</a>
          <a href="/data/run-b/catalog.json" download="run-b-catalog.json">{text("Download saved site catalog (JSON)", "Tải danh mục địa điểm đã lưu (JSON)")}</a>
        </div>
        <code className="hash">manifest.json · SHA-256 {manifestHash}</code>
        <h3>{text("Saved rankings for all 23 sites", "Bảng xếp hạng đã lưu của 23 địa điểm")}</h3>
        <p>{text("Compare the sites for one of these three UTC windows. Each contains summary values for the entire selected window.",
          "So sánh các địa điểm trong một trong ba khoảng UTC sau. Mỗi bộ số liệu tổng hợp bao phủ toàn bộ khoảng đã chọn.")}</p>
        <ul className="space-y-1">{savedCatalogWindows.map(([from,to]) => <li key={from}>
          <a href={"/plan?" + new URLSearchParams({ source: "saved", mode: "sites", from, to, priority: "joint" })}>{from} → {to} UTC</a>
        </li>)}</ul>
        <h3>{text("Saved Odysseus and Athena comparisons", "Kết quả so sánh Odysseus và Athena đã lưu")}</h3>
        <p>{text("Open either week to see both sites’ simultaneous Sun and Earth visibility intervals. The end time is exclusive.",
          "Mở một trong hai tuần để xem những khoảng cả Mặt Trời và Trái Đất cùng xuất hiện ở từng địa điểm. Mốc kết thúc được loại trừ.")}</p>
        <ul className="space-y-1">{weeks.weeks.map(week => <li key={week.startUtc}>
          <a href={"/compare?saved=" + encodeURIComponent(week.startUtc) + "#observed-week"}>{week.startUtc.slice(0, 10)} → {week.endUtc.slice(0, 10)} UTC</a>
        </li>)}</ul>
        <p>{text("For these two sites, the saved intervals also support daily comparisons and hourly landing-start searches from 14 November up to 28 November 2026 UTC.",
          "Với hai địa điểm này, dữ liệu đã lưu còn cho phép so sánh khoảng ngày tự chọn và tìm giờ bắt đầu hạ cánh từ ngày 14/11 đến trước ngày 28/11/2026 UTC.")}</p>
        <a href={"/plan?" + new URLSearchParams({ source: "saved", mode: "dates", site: "im2_athena", from: "2026-11-14", to: "2026-11-28", missionHours: "3", priority: "joint" })}>
          {text("Find landing times within the saved intervals", "Tìm giờ hạ cánh trong các khoảng đã lưu")}</a>
      </section>
      <section className="space-y-3" aria-labelledby="source-files">
        <h2 id="source-files">{text("Original run B files on the team API", "Tệp gốc của lần chạy B trên API của nhóm")}</h2>
        <p>{text("The manifest indexes 94 files. Full hourly ephemerides and visibility tables, local horizons and full-run intervals are served by the backend.",
          "Manifest liệt kê 94 tệp. Backend cung cấp bảng thiên văn và trạng thái tầm nhìn mỗi giờ, đường chân trời địa phương và các khoảng tầm nhìn của cả lần chạy.")}</p>
        {isMock && <p className="data-notice">{text("This build has no team API configured. Use the routes below with the team API host.",
          "Bản web này chưa cấu hình API của nhóm. Ghép các đường dẫn bên dưới với địa chỉ máy chủ API của nhóm.")}</p>}
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <SourceRoute label={text("Full-run summary (CSV)", "Bảng tổng hợp của cả lần chạy (CSV)")} path={summaryPath} />
          <SourceRoute label={text("Site catalog and region polygons (GeoJSON)", "Danh mục địa điểm và đa giác vùng (GeoJSON)")} path={geoPath} />
        </div>
        <details><summary>{text("Run-wide original files", "Tệp gốc chung của lần chạy")}</summary>{fileList(runFiles)}</details>
        <label className="field max-w-xl">{text("Choose a site to see its files", "Chọn địa điểm để xem tệp tương ứng")}
          <select value={site.id} onChange={e => setSiteId(e.target.value)}>
            {Object.entries(groups).map(([group,labels]) => <optgroup key={group} label={labels[vi ? 1 : 0]}>
              {catalog.sites.filter(s => s.group === group).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>)}
          </select>
        </label>
        <p>{text("Planetocentric latitude", "Vĩ độ tâm Mặt Trăng")} {site.lat_deg}° · {text("east longitude", "kinh độ Đông")} {site.lon_deg}° · MOON_ME</p>
        {site.horizon_method === "flat" && <p className="data-notice">{t("Outside elevation-map coverage. This site uses a smooth-sphere horizon and omits local terrain shadows.")}</p>}
        {fileList(siteFiles)}
      </section>
      <nav className="flex flex-wrap gap-4" aria-label={text("Explore the data", "Khám phá dữ liệu")}>
        <a href="/plan">{text("Open the planner", "Mở công cụ lập kế hoạch")}</a>
        <a href="/compare">{t("Open the observation workspace")}</a>
      </nav>
    </main>
  </div>;
}

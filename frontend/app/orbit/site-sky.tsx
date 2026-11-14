"use client";

import { useState } from "react";
import archive from "../../lib/orbit-sky-samples.json";
import { missionSites } from "../../lib/globe-sites";
import { useLanguage } from "../language";
import "./site-sky.css";

const bodies = ["sun", "earth"] as const;
type Body = typeof bodies[number];
const wrap = (degrees: number) => ((degrees % 360) + 360) % 360;
const y = (elevation: number) => 138 - elevation * 6;
const x = (offset: number) => 240 + offset * 3.6;

export default function SiteSky({ siteId, weekUtc }: { siteId: string; weekUtc: string }) {
  const { locale, t } = useLanguage();
  const [looking, setLooking] = useState<Body>("sun");
  const vi = locale === "vi";
  const site = missionSites.find(item => item.id === siteId);
  const profile = archive.horizons.find(item => item.siteId === siteId);
  const reading = archive.samples.find(item => item.siteId === siteId && item.weekUtc === weekUtc);
  if (!site || !profile || !reading) return <p role="status">{vi ? "Chưa có bầu trời được lưu cho điểm và thời điểm này." : "No saved sky is available for this site and time."}</p>;

  const bearing = reading[looking].az_deg;
  const fmt = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  const angle = (value: number) => fmt(value) + "°";
  const heading = (azimuth: number) => {
    const words = vi ? ["Bắc", "Đông Bắc", "Đông", "Đông Nam", "Nam", "Tây Nam", "Tây", "Tây Bắc"]
      : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return words[Math.round(wrap(azimuth) / 45) % 8];
  };
  const step = archive.azimuthStepDeg;
  const coords = Array.from({ length: 120 / step + 1 }, (_, i) => {
    const offset = i * step - 60;
    const index = wrap(bearing + offset) / step;
    const left = Math.floor(index), fraction = index - left;
    const elevation = profile.elevationsDeg[left] * (1 - fraction) + profile.elevationsDeg[left + 1] * fraction;
    return x(offset).toFixed(1) + "," + y(elevation).toFixed(2);
  }).join(" ");
  const names = { sun: t("Sun"), earth: t("Earth") };
  const title = vi ? "Chân trời tại điểm đáp" : "Horizon at the landing site";
  return <section className="site-sky" aria-label={title}>
    <div className="site-sky-title"><h2>{title}</h2><p>{site.name.split(" · ")[0]} · <time dateTime={weekUtc}>{weekUtc.slice(0, 10)} 00:00 UTC</time></p></div>
    <div className="site-sky-controls" role="group" aria-label={vi ? "Chọn hướng nhìn" : "Choose a viewing direction"}>
      {bodies.map(body => <button key={body} type="button" aria-pressed={looking === body} onClick={() => setLooking(body)}>
        {vi ? "Nhìn về " : "Look toward "}{names[body]}</button>)}
    </div>
    <figure>
      <svg role="img" viewBox="0 0 480 207" aria-label={vi
        ? `Đường chân trời trong góc nhìn 120 độ về phía ${names[looking]}. Xem phương vị, độ cao và trạng thái ngay dưới hình.`
        : `Terrain horizon across 120 degrees facing the ${names[looking]}. Bearings, elevations and visibility follow below.`}>
        <path d="M24 13H456V185H24Z" fill="#162432"/>
        <polygon points={`24,185 ${coords} 456,185`} fill="#524a43"/>
        {[-5, 0, 10, 20].map(el => <g key={el}>
          <line x1="24" y1={y(el)} x2="456" y2={y(el)} stroke="#91a0a9" strokeWidth=".7" strokeDasharray={el === 0 ? "4 3" : "1 5"}/>
          <text x="22" y={y(el) + 3} textAnchor="end">{el}°</text>
        </g>)}
        <polyline points={coords} fill="none" stroke="#d7c4aa" strokeWidth="2"/>
        {bodies.map(body => {
          const b = reading[body], offset = wrap(b.az_deg - bearing + 180) - 180;
          if (Math.abs(offset) > 59) return null;
          const xp = x(offset), yp = y(b.el_deg), color = body === "sun" ? "#ffd16c" : "#98dfff";
          return <g key={body} stroke={color} fill={b.visible ? color : "#27323c"}>
            {body === "sun" ? <circle cx={xp} cy={yp} r="4"/> : <rect x={xp - 3.5} y={yp - 3.5} width="7" height="7"/>}
            <text x={xp} y={yp - 9} textAnchor="middle" stroke="none" style={{ fill: color }}>{names[body]}</text>
          </g>;
        })}
        {[-60, 0, 60].map(offset => <text key={offset} x={x(offset)} y="201" textAnchor={offset < 0 ? "start" : offset > 0 ? "end" : "middle"}>
          {heading(bearing + offset)} · {angle(wrap(bearing + offset))}</text>)}
      </svg>
      <figcaption>{vi ? "Đường màu cát là chân trời địa hình từ độ cao 2 m. Nét đứt 0° là mặt phẳng ngang; một thiên thể vẫn có thể nhìn thấy ở độ cao âm nếu chân trời địa hình thấp hơn."
        : "The sand-colored line is the terrain horizon from 2 m above the site. The dashed 0° line is horizontal. A body below 0° can still be visible if the terrain horizon is lower."}</figcaption>
    </figure>
    <dl className="site-sky-readings">{bodies.map(body => {
      const b = reading[body];
      return <div key={body}><dt>{names[body]} · {b.visible ? t("Visible") : t("Hidden")}</dt>
        <dd>{vi ? "Phương vị" : "Bearing"} {angle(b.az_deg)} · {vi ? "Độ cao tâm" : "Center elevation"} {angle(b.el_deg)}<br/>
          {vi ? "Chân trời địa hình" : "Terrain horizon"} {angle(b.horizon_el_deg)}</dd></div>;
    })}</dl>
    <details><summary>{vi ? "Dữ liệu và cách đọc" : "Data and interpretation"}</summary>
      <p>{vi ? "Phương vị tính theo chiều kim đồng hồ từ hướng Bắc; độ cao tính từ mặt phẳng ngang. Đường chân trời B2 được lấy mẫu mỗi 0,5°. Ký hiệu chỉ tâm thiên thể: đặc khi thấy được, rỗng khi bị khuất. Trạng thái nhìn thấy do mô hình xác định, có xét rìa trên của Mặt Trời và ngưỡng nhìn thấy Trái Đất."
        : "Bearings run clockwise from north. Elevation is measured from horizontal. The B2 terrain horizon is sampled every 0.5°. Body centers use solid markers when visible and hollow markers when hidden. Visibility follows the model’s solar upper-limb and Earth-clearance criteria."}</p>
      <a href={reading.instantSource.url}>{vi ? "Mẫu tại điểm đáp (JSON)" : "Site observation (JSON)"}</a>{" · "}
      <a href={archive.datasetSources.find(s => s.url.includes(weekUtc.slice(0, 10)))?.url}>{vi ? "Đường chân trời B2 (JSON)" : "B2 terrain horizon (JSON)"}</a>
    </details>
  </section>;
}

"use client";

import { useId, useState } from "react";
import { guideObservation } from "../lib/guide-observation";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import snapshot from "../lib/odysseus-athena-weeks.json";
import { useLanguage } from "./language";
import styles from "./astronaut-guide.module.css";
import GuideChat, { type GuideActions } from "./guide-chat";
import { savedGuideContext, type GuideContext } from "../lib/api/guide-chat";

const messages = {
  en: {
    title: "Astronaut guide",
    close: "Close astronaut guide",
    greeting: "What would you like to explore?",
    savedSample: "Saved model sample · interval boundaries ±1 h",
    terrainSample: "Loaded terrain model sample",
    states: { both: "Sun and Earth visible", sun: "Sun visible, Earth out of view", earth: "Earth visible, Sun out of view", neither: "Sun and Earth both out of view", outsideJoint: "Outside the joint visibility window" },
    source: "Model and sources",
    questions: [
      ["How do I compare sites or dates?", "In the saved results, choose a week to compare Odysseus with Athena. Choose a site to compare its two weeks. Each bar shows when the model places both the Sun and Earth above that site’s horizon."],
      ["Can I see what’s happening now?", "Check the UTC window on the result. The saved weeks show modeled conditions for those dates. This guide has no live feed."],
      ["Does seeing Earth guarantee a radio link?", "Earth visibility tells you whether Earth is in view. Signal strength also depends on the radio equipment and the link conditions. The comparison gives no signal-strength estimate."],
    ],
    saved: "Go to saved comparisons",
    resultQuestion: "How long are the Sun and Earth both visible in my saved comparison?",
    resultIntro: "The saved model gives these hours when both bodies are visible in each UTC week.",
  },
  vi: {
    title: "Hướng dẫn của phi hành gia",
    close: "Đóng hướng dẫn của phi hành gia",
    greeting: "Bạn muốn tìm hiểu điều gì?",
    savedSample: "Mốc mô hình đã lưu · sai số ranh giới ±1 giờ",
    terrainSample: "Mốc mô hình địa hình đã tải",
    states: { both: "Thấy cả Mặt Trời và Trái Đất", sun: "Thấy Mặt Trời, không thấy Trái Đất", earth: "Thấy Trái Đất, không thấy Mặt Trời", neither: "Không thấy Mặt Trời và Trái Đất", outsideJoint: "Ngoài khoảng nhìn thấy đồng thời" },
    source: "Mô hình và nguồn dữ liệu",
    questions: [
      ["Làm sao so sánh địa điểm hoặc thời gian?", "Trong phần kết quả đã lưu, chọn một tuần để so sánh Odysseus với Athena. Chọn một địa điểm để so sánh hai tuần tại đó. Mỗi thanh biểu thị khoảng thời gian mà theo mô hình, cả Mặt Trời và Trái Đất đều ở phía trên đường chân trời tại địa điểm đó."],
      ["Tôi xem được tình hình hiện tại không?", "Hãy xem khoảng thời gian UTC ghi trên kết quả. Các tuần đã lưu cho biết điều kiện theo mô hình trong những ngày đó. Hướng dẫn này không có dữ liệu trực tiếp."],
      ["Nhìn thấy Trái Đất có bảo đảm liên lạc vô tuyến không?", "Ngay cả khi nhìn thấy Trái Đất từ điểm hạ cánh, cường độ tín hiệu vẫn phụ thuộc vào thiết bị vô tuyến và điều kiện đường truyền. Công cụ so sánh không ước tính cường độ tín hiệu."],
    ],
    saved: "Đến phần so sánh kết quả đã lưu",
    resultQuestion: "Trong kết quả đã chọn, cả Mặt Trời và Trái Đất cùng xuất hiện trong bao lâu?",
    resultIntro: "Mô hình đã lưu cho biết số giờ có thể nhìn thấy đồng thời cả hai thiên thể trong mỗi tuần tính theo UTC.",
  },
};

export default function AstronautGuide({ savedResult, terrain, comparisonPath = "", workspace, workspaceActions, onSaved }: {
  savedResult: string; terrain: TerrainSummary | null; comparisonPath?: string;
  workspace?: GuideContext; workspaceActions?: GuideActions; onSaved?: (value: string) => void;
}) {
  const { locale } = useLanguage();
  const copy = messages[locale];
  const id = useId();
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const reading = openedAt === null ? null : guideObservation(openedAt, savedResult, terrain);
  const rows = snapshot.weeks.flatMap(week => week.sites
    .filter(site => week.startUtc === savedResult || site.id === savedResult)
    .map(site => ({ week, site })));
  function savedMode(value: string) {
    if (!onSaved) return "/compare?saved=" + encodeURIComponent(value) + "#observed-week";
    return () => { onSaved(value); document.getElementById("observed-week")?.focus(); };
  }
  const savedActions: GuideActions = {
    workspace: comparisonPath + "#workspace", sources: comparisonPath + "#saved-model-source", saved: comparisonPath + "#observed-week",
    compareSites: savedMode(rows[0]?.week.startUtc ?? snapshot.weeks[0].startUtc),
    compareDates: savedMode(rows[0]?.site.id ?? snapshot.weeks[0].sites[0].id),
  };
  return <>
    <button type="button" className={styles.launcher} popoverTarget={id} aria-label={copy.title} title={copy.title}>
      <span aria-hidden="true">🧑‍🚀</span>
    </button>
    <aside id={id} popover="auto" onToggle={event => setOpenedAt(event.newState === "open" ? Date.now() : null)} className={styles.panel} aria-labelledby={id + "-title"}>
      <header className={styles.header}>
        <h2 id={id + "-title"}>{copy.title}</h2>
        <button type="button" className={styles.close} popoverTarget={id} popoverTargetAction="hide" aria-label={copy.close}>×</button>
      </header>
      {openedAt !== null && <GuideChat saved={savedGuideContext(savedResult)} workspace={workspace} savedActions={savedActions} workspaceActions={workspaceActions} />}
      {reading ? <section className={styles.sample}>
        <p>{reading.saved ? copy.savedSample : copy.terrainSample}</p>
        <time dateTime={new Date(reading.time).toISOString()}>{new Date(reading.time).toISOString().slice(0, 19).replace("T", " ")} UTC</time>
        <ul>{reading.readings.map((row, index) => <li key={index}>{row.name} · {copy.states[row.visibility]}</li>)}</ul>
        <a href={comparisonPath + (reading.saved ? "#saved-model-source" : "#sources")} onClick={event => event.currentTarget.closest("aside")?.hidePopover()}>{copy.source}</a>
        <small>{reading.source}</small>
      </section> : <p className={styles.greeting}>{copy.greeting}</p>}
      {copy.questions.map(([question, answer], index) =>
        <details key={index} name={id}>
          <summary>{question}</summary>
          <p>{answer}</p>
        </details>
      )}
      {rows.length > 0 && <details name={id}>
        <summary>{copy.resultQuestion}</summary>
        <p>{copy.resultIntro}</p>
        <ul className={styles.results}>{rows.map(({ week, site }) =>
          <li key={week.startUtc + site.id}><strong>{site.name} · {site.overlap.duration_h} h</strong>
            <span>{week.startUtc.slice(0, 10)} → {new Date(Date.parse(week.endUtc) - 1).toISOString().slice(0, 10)} UTC</span>
          </li>
        )}</ul>
      </details>}
      <a className={styles.jump} href={comparisonPath + "#observed-week"} onClick={event => event.currentTarget.closest("aside")?.hidePopover()}>{copy.saved}</a>
    </aside>
  </>;
}

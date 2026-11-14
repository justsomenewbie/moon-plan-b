"use client";

import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { guideObservation, nextGuideUpdate, selectedModelSample } from "../lib/guide-observation";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import snapshot from "../lib/odysseus-athena-weeks.json";
import { isSavedResultLink } from "./observed-week";
import { useLanguage } from "./language";
import styles from "./astronaut-guide.module.css";
import type { PlanningSource } from "../lib/api/guide-planning";
import type { DisplayedPair } from "./terrain-pair";
import GuideChat, { type GuideActions, type GuideScope } from "./guide-chat";
import { savedGuideContext, type GuideContext } from "../lib/api/guide-chat";

const messages = {
  en: {
    title: "Astronaut guide",
    help: "Help",
    close: "Close astronaut guide",
    greeting: "What can I help you explore?",
    suggested: "Browse suggested questions",
    measurementNote: "I don’t have live measurements from the Moon.",
    currentQuestion: "Can I see what’s happening now?",
    unavailable: "The selected data has no model sample available for the current UTC time.",
    otherSites: "Other sites",
    savedSample: "Saved model sample · interval boundaries ±1 h",
    terrainSample: "Loaded terrain model sample",
    states: { both: "Sun and Earth visible", sun: "Sun visible, Earth out of view", earth: "Earth visible, Sun out of view", neither: "Sun and Earth both out of view", outsideJoint: "Sun and Earth are not both in view" },
    source: "Model and sources",
    questions: [
      ["How do I compare sites or dates?", "In the saved results, choose a week to compare Odysseus with Athena. Choose a site to compare its two weeks. Each bar shows when the model places both the Sun and Earth above that site’s horizon."],
      ["Does seeing Earth guarantee a radio link?", "Earth visibility tells you whether Earth is in view. Signal strength also depends on the radio equipment and the link conditions. The comparison gives no signal-strength estimate."],
    ],
    saved: "Go to saved comparisons",
    resultQuestion: "How long are the Sun and Earth both visible in my saved comparison?",
    resultIntro: "The saved model gives these hours when both bodies are visible in each UTC week.",
  },
  vi: {
    title: "Hướng dẫn của phi hành gia",
    help: "Trợ giúp",
    close: "Đóng hướng dẫn của phi hành gia",
    greeting: "Bạn muốn mình giúp tìm hiểu điều gì?",
    suggested: "Xem câu hỏi gợi ý",
    measurementNote: "Mình chưa có số liệu đo trực tiếp từ Mặt Trăng.",
    currentQuestion: "Tôi xem được tình hình hiện tại không?",
    unavailable: "Dữ liệu đang chọn chưa có kết quả mô hình cho thời điểm UTC hiện tại.",
    otherSites: "Các địa điểm khác",
    savedSample: "Mô hình đã lưu · mốc đầu và cuối mỗi khoảng có thể lệch ±1 giờ",
    terrainSample: "Mốc mô hình địa hình đã tải",
    states: { both: "Thấy cả Mặt Trời và Trái Đất", sun: "Thấy Mặt Trời, không thấy Trái Đất", earth: "Thấy Trái Đất, không thấy Mặt Trời", neither: "Không thấy Mặt Trời và Trái Đất", outsideJoint: "Không thấy đồng thời Mặt Trời và Trái Đất" },
    source: "Mô hình và nguồn dữ liệu",
    questions: [
      ["Làm sao so sánh địa điểm hoặc thời gian?", "Trong phần kết quả đã lưu, chọn một tuần để so sánh Odysseus với Athena. Chọn một địa điểm để so sánh hai tuần tại đó. Mỗi thanh biểu thị khoảng thời gian mà theo mô hình, cả Mặt Trời và Trái Đất đều ở phía trên đường chân trời tại địa điểm đó."],
      ["Nhìn thấy Trái Đất có bảo đảm liên lạc vô tuyến không?", "Ngay cả khi nhìn thấy Trái Đất từ điểm hạ cánh, cường độ tín hiệu vẫn phụ thuộc vào thiết bị vô tuyến và điều kiện đường truyền. Công cụ so sánh không ước tính cường độ tín hiệu."],
    ],
    saved: "Đến phần so sánh kết quả đã lưu",
    resultQuestion: "Trong kết quả đã chọn, cả Mặt Trời và Trái Đất cùng xuất hiện trong bao lâu?",
    resultIntro: "Mô hình đã lưu cho biết số giờ có thể nhìn thấy đồng thời cả hai thiên thể trong mỗi tuần tính theo UTC.",
  },
};

function subscribeToLocation(notify: () => void) {
  window.addEventListener("popstate", notify);
  window.addEventListener("hashchange", notify);
  return () => {
    window.removeEventListener("popstate", notify);
    window.removeEventListener("hashchange", notify);
  };
}

const savedRoute = () => isSavedResultLink(window.location);

export default function AstronautGuide({ planningSource, savedResult, terrain, comparisonPath = "", workspace, workspaceEvidence, pair, workspaceActions, onSaved }: {
  planningSource?: PlanningSource; savedResult: string; terrain: TerrainSummary | null; comparisonPath?: string;
  workspace?: GuideContext; workspaceEvidence?: TerrainSummary | null; pair?: DisplayedPair; workspaceActions?: GuideActions; onSaved?: (value: string) => void;
}) {
  const { locale } = useLanguage();
  const copy = messages[locale];
  const id = useId();
  const firstQuestion = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // The native launcher can already have opened the popover while the page scripts were loading.
    if (document.getElementById(id)?.matches(":popover-open")) setOpen(true);
  }, [id]);
  const [imageMode, setImageMode] = useState<"motion" | "still" | "text">("motion");
  const [now, setNow] = useState<number | null>(null);
  function recoverImage(image: HTMLImageElement) {
    if (image.currentSrc.endsWith("/guide-visor-wave.webp")) setImageMode("still");
    else if (image.currentSrc.endsWith("/guide-visor-rest.webp")) setImageMode("text");
  }
  const [guideChoice, setGuideChoice] = useState<GuideScope | null>(null);
  const onSavedRoute = useSyncExternalStore(subscribeToLocation, savedRoute, () => false);
  const defaultScope = onSavedRoute ? "saved" : pair ? "pair" : workspace ? "workspace" : "saved";
  const scope = guideChoice === "saved" || (guideChoice === "workspace" && workspace) || (guideChoice === "pair" && pair)
    ? guideChoice : defaultScope;
  const sampleSource = useMemo(() => {
    if (!open) return null;
    if (scope === "saved") return planningSource && planningSource !== "saved" ? null : savedResult;
    if (!terrain) return null;
    return scope === "pair" ? selectedModelSample(pair?.context, pair?.comparison) : selectedModelSample(workspace, terrain);
  }, [open, scope, savedResult, planningSource, terrain, pair, workspace]);
  useEffect(() => {
    if (!open) return;
    let timer: number | undefined;
    function refresh() {
      window.clearTimeout(timer);
      if (document.hidden) return;
      const current = Date.now();
      setNow(current);
      const next = nextGuideUpdate(current, sampleSource);
      if (next !== null) timer = window.setTimeout(refresh, Math.min(next - current, 2_147_483_647));
    }
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, sampleSource]);
  const reading = !open || now === null ? null : guideObservation(now, sampleSource);
  const siteStatuses = reading?.readings.map(row => <li key={row.name}>{row.name} · {copy.states[row.visibility]}</li>) ?? [];
  const sourceAnchor = scope === "pair" ? "#terrain-pair" : scope === "workspace" ? "#sources" : "#saved-model-source";
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
  function dismissOnEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (!(event.target instanceof Element) || !event.target.closest("button, summary, a")) return;
    const panel = document.getElementById(id);
    if (panel?.matches(":popover-open")) {
      event.preventDefault();
      panel.hidePopover();
    }
  }
  return <>
    <button type="button" className={styles.launcher} popoverTarget={id} aria-label={copy.title} title={copy.title}
      onKeyDown={dismissOnEscape}>
      {imageMode === "text" ? <span className={styles.helpLabel}>{copy.help}</span> : <picture>
        {imageMode === "motion" && <source media="screen and (prefers-reduced-motion: no-preference) and (forced-colors: none)"
          srcSet="/images/guide-visor-wave.webp" />}
        <img className={imageMode === "motion" ? styles.animated : undefined} src="/images/guide-visor-rest.webp"
          alt="" width="60" height="70" onError={event => recoverImage(event.currentTarget)}
          ref={image => {
            // The browser can finish a failed image request before hydration attaches onError.
            if (image?.complete && !image.naturalWidth) recoverImage(image);
          }} />
      </picture>}
    </button>
    <aside id={id} popover="auto" onKeyDown={dismissOnEscape} onToggle={event => {
      const opening = event.newState === "open";
      if (opening) event.currentTarget.scrollTop = 0;
      setOpen(opening);
    }} className={styles.panel} aria-labelledby={id + "-title"}>
      <header className={styles.header}>
        {open && <span className={styles.portrait} aria-hidden="true" />}
        <h2 id={id + "-title"}>{copy.title}</h2>
        <button type="button" className={styles.close} popoverTarget={id} popoverTargetAction="hide" aria-label={copy.close}>×</button>
      </header>
      <p className={styles.greeting}>{copy.greeting}<br />{copy.measurementNote}</p>
      {open && <button type="button" className={styles.jump} onClick={() => {
        firstQuestion.current?.focus({ preventScroll: true });
        firstQuestion.current?.scrollIntoView({ block: "start" });
      }}>{copy.suggested}</button>}
      {open && <details open={Boolean(reading)}>
        <summary>{copy.currentQuestion}</summary>
        {reading ? <section className={styles.sample}>
          <p>{reading.saved ? copy.savedSample : copy.terrainSample}</p>
          <time dateTime={new Date(reading.time).toISOString()}>{new Date(reading.time).toISOString().slice(0, 19).replace("T", " ")} UTC</time>
          <ul>{siteStatuses.slice(0, 2)}</ul>
          {siteStatuses.length > 2 && <details>
            <summary>{copy.otherSites} ({siteStatuses.length - 2})</summary>
            <ul>{siteStatuses.slice(2)}</ul>
          </details>}
          <a href={comparisonPath + sourceAnchor} onClick={event => event.currentTarget.closest("aside")?.hidePopover()}>{copy.source}</a>
          <small>{reading.source}</small>
        </section> : <p>{copy.unavailable}</p>}
      </details>}
      {open && <GuideChat planningSource={planningSource} scope={scope} savedPlanning={scope === "saved" && (guideChoice === "saved" || onSavedRoute)} onChoice={setGuideChoice} saved={savedGuideContext(savedResult)} workspace={workspace} workspaceEvidence={workspaceEvidence} pair={pair} savedActions={savedActions} workspaceActions={workspaceActions} />}
      {copy.questions.map(([question, answer], index) =>
        <details key={index} name={id}>
          <summary ref={index === 0 ? firstQuestion : undefined}>{question}</summary>
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

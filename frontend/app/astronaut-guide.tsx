"use client";

import { type KeyboardEvent, useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { guideObservation, nextGuideUpdate, selectedModelSample } from "../lib/guide-observation";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import snapshot from "../lib/odysseus-athena-weeks.json";
import { isSavedResultLink } from "./observed-week";
import { useLanguage } from "./language";
import styles from "./astronaut-guide.module.css";
import type { PlanningSource } from "../lib/api/guide-planning";
import type { DisplayedPair } from "./terrain-pair";
import GuideChat, { clearGuideHistory, type GuideActions, type GuideScope } from "./guide-chat";
import { savedGuideContext, type GuideContext } from "../lib/api/guide-chat";

const messages = {
  en: {
    title: "AI guide",
    subtitle: "Answers from the selected model data",
    open: "Open AI guide",
    close: "Close AI guide",
    newChat: "New chat",
    liveQuestion: "Which site has the most hours with both Sun and Earth this week?",
    dataQuestion: "What NASA data does this use?",
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
    title: "Trợ lý AI",
    subtitle: "Trả lời dựa trên dữ liệu mô hình đang chọn",
    open: "Mở trợ lý AI",
    close: "Đóng trợ lý AI",
    newChat: "Trò chuyện mới",
    liveQuestion: "Tuần này địa điểm nào có nhiều giờ cùng thấy Mặt Trời và Trái Đất nhất?",
    dataQuestion: "Dự án dùng dữ liệu NASA nào?",
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
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // The native launcher can already have opened the popover while the page scripts were loading.
    if (document.getElementById(id)?.matches(":popover-open")) setOpen(true);
  }, [id]);
  const [now, setNow] = useState<number | null>(null);
  // Changing the epoch remounts the conversation, which is how "New chat" clears it.
  const [chatEpoch, setChatEpoch] = useState(0);
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
  // Two answers are written by the team; the last question goes to the language model.
  const suggestions = [...copy.questions.map(([question, answer]) => ({ question, answer })), { question: copy.liveQuestion }, { question: copy.dataQuestion }];
  return <>
    <button type="button" className={styles.launcher} popoverTarget={id} aria-label={copy.open} title={copy.open}
      onKeyDown={dismissOnEscape}>
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="currentColor">
        <path d="M10 3.5l1.7 4.6a2 2 0 0 0 1.2 1.2L17.5 11l-4.6 1.7a2 2 0 0 0-1.2 1.2L10 18.5l-1.7-4.6a2 2 0 0 0-1.2-1.2L2.5 11l4.6-1.7a2 2 0 0 0 1.2-1.2z" />
        <path d="M18.5 14.5l.8 2.2a1 1 0 0 0 .6.6l2.1.7-2.1.8a1 1 0 0 0-.6.6l-.8 2.1-.8-2.1a1 1 0 0 0-.6-.6l-2.1-.8 2.1-.7a1 1 0 0 0 .6-.6z" />
      </svg>
    </button>
    <aside id={id} popover="auto" onKeyDown={dismissOnEscape} onToggle={event => {
      const opening = event.newState === "open";
      setOpen(opening);
    }} className={styles.panel} aria-labelledby={id + "-title"}>
      <header className={styles.header}>
        <div><h2 id={id + "-title"}>{copy.title}</h2><p>{copy.subtitle}</p></div>
        <button type="button" className={styles.newChat} onClick={() => { clearGuideHistory(); setChatEpoch(epoch => epoch + 1); }}>{copy.newChat}</button>
        <button type="button" className={styles.close} popoverTarget={id} popoverTargetAction="hide" aria-label={copy.close}>×</button>
      </header>
      <div className={styles.scroll}>
        <p className={styles.greeting}>{copy.greeting}</p>
        {open && <GuideChat planningSource={planningSource} scope={scope} savedPlanning={scope === "saved" && (guideChoice === "saved" || onSavedRoute)} onChoice={setGuideChoice} saved={savedGuideContext(savedResult)} workspace={workspace} workspaceEvidence={workspaceEvidence} pair={pair} savedActions={savedActions} workspaceActions={workspaceActions} suggestions={suggestions} epoch={chatEpoch} />}
        {open && <details className={styles.more}>
          <summary>{copy.currentQuestion}</summary>
          {reading ? <section className={styles.sample}>
            <p>{reading.saved ? copy.savedSample : copy.terrainSample}</p>
            <ul>{siteStatuses.slice(0, 2)}</ul>
            {siteStatuses.length > 2 && <details>
              <summary>{copy.otherSites} ({siteStatuses.length - 2})</summary>
              <ul>{siteStatuses.slice(2)}</ul>
            </details>}
            <small><time dateTime={new Date(reading.time).toISOString()}>{new Date(reading.time).toISOString().slice(0, 19).replace("T", " ")} UTC</time> · {reading.source} · <a href={comparisonPath + sourceAnchor} onClick={event => event.currentTarget.closest("aside")?.hidePopover()}>{copy.source}</a></small>
          </section> : <p>{copy.unavailable}</p>}
        </details>}
        {rows.length > 0 && <details className={styles.more}>
          <summary>{copy.resultQuestion}</summary>
          <p>{copy.resultIntro}</p>
          <ul className={styles.results}>{rows.map(({ week, site }) =>
            <li key={week.startUtc + site.id}><strong>{site.name} · {site.overlap.duration_h} h</strong>
              <span>{week.startUtc.slice(0, 10)} → {new Date(Date.parse(week.endUtc) - 1).toISOString().slice(0, 10)} UTC</span>
            </li>
          )}</ul>
          <a href={comparisonPath + "#observed-week"} onClick={event => event.currentTarget.closest("aside")?.hidePopover()}>{copy.saved}</a>
        </details>}
      </div>
    </aside>
  </>;
}

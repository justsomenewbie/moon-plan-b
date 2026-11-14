"use client";

import { useEffect, useId, useRef, useState } from "react";
import { askGuide, GuideRequestError, type GuideErrorKey, type GuideAction, type GuideContext, type GuideReply } from "../lib/api/guide-chat";
import { planningIntent, type PlanningIntent } from "../lib/guide-planning";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import type { DisplayedPair } from "./terrain-pair";
import { answerWorkspacePlanning } from "../lib/guide-workspace-planning";
import { answerPlanning, type PlanningSource } from "../lib/api/guide-planning";
import { useLanguage } from "./language";
import styles from "./guide-chat.module.css";

const copy = {
  en: {
    title: "Ask the astronaut", source: "Use data from", saved: "Saved comparison", workspace: "Current workspace", pair: "Displayed site pair",
    kinds: { saved: "Saved team model", terrain: "Terrain model", scenario: "Supplied scenario", synthetic: "Simulated example", unavailable: "No shareable observation summary" },
    summary: "See UTC ranges and hours", sourceId: "Source", privacy: "Planning questions about the current workspace, displayed pair and saved archives use data on your device. The live planner requests model data from the team API. For other questions, this site's server receives your question, the previous question if any, and the selected summary. When this server uses OpenAI, it sends your question, the previous question and the site names and dates to OpenAI. Your file stays on your device.",
    hours: "Hours visible · Sun / Earth / both", unknown: "unknown", invalid: "Edit the question and send it again.", prompt: "Your question", send: "Send", cancel: "Cancel", reset: "Clear chat", retry: "Try again",
    waiting: "The astronaut is thinking…", failed: "The guide couldn’t answer. You can try again or use the questions below.",
    offline: "The model is unavailable. You can still use the questions below.", slow: "The guide timed out. Try again.", limited: "The guide is busy. Please try again shortly.",
    you: "You", guide: "Astronaut", actions: { workspace: "Open workspace", saved: "Open saved result", sources: "View sources", compareSites: "Compare sites", compareDates: "Compare dates" },
  },
  vi: {
    title: "Hỏi phi hành gia", source: "Chọn dữ liệu để hỏi", saved: "Kết quả đã lưu", workspace: "Dữ liệu đang xem", pair: "Cặp địa điểm đang so sánh",
    kinds: { saved: "Kết quả mô hình đã lưu", terrain: "Mô hình địa hình", scenario: "Kịch bản đã tải", synthetic: "Dữ liệu mô phỏng", unavailable: "Chưa có dữ liệu quan sát phù hợp để gửi" },
    summary: "Xem khoảng thời gian UTC và số giờ", sourceId: "Nguồn", privacy: "Câu hỏi lập kế hoạch về dữ liệu đang xem, cặp địa điểm đang so sánh và các bản đã lưu dùng dữ liệu trên thiết bị của bạn. Công cụ lập kế hoạch trực tuyến truy vấn API của nhóm. Với các câu hỏi khác, máy chủ của trang nhận câu hỏi hiện tại, câu hỏi ngay trước đó (nếu có) và phần dữ liệu tóm tắt đã chọn. Khi dùng OpenAI, máy chủ gửi cho OpenAI câu hỏi hiện tại, câu hỏi trước đó, tên địa điểm và khoảng ngày. Tệp gốc vẫn nằm trên thiết bị của bạn.",
    hours: "Số giờ nhìn thấy · Mặt Trời / Trái Đất / cả hai", unknown: "chưa xác định", invalid: "Hãy sửa câu hỏi rồi gửi lại.", prompt: "Câu hỏi của bạn", send: "Gửi", cancel: "Hủy", reset: "Xóa cuộc trò chuyện", retry: "Thử lại",
    waiting: "Phi hành gia đang suy nghĩ…", failed: "Chưa có câu trả lời. Bạn có thể thử lại hoặc chọn một câu hỏi bên dưới.",
    offline: "Mô hình hiện chưa hoạt động. Bạn vẫn có thể chọn một câu hỏi bên dưới.", slow: "Đã hết thời gian chờ. Hãy thử lại.", limited: "Phi hành gia đang bận. Bạn vui lòng thử lại sau.",
    you: "Bạn", guide: "Phi hành gia", actions: { workspace: "Mở phần quan sát", saved: "Mở kết quả đã lưu", sources: "Xem nguồn dữ liệu", compareSites: "So sánh hai địa điểm", compareDates: "So sánh hai khoảng thời gian" },
  },
} as const;

export type GuideDestination = string | (() => void);
export type GuideActions = Partial<Record<GuideAction, GuideDestination>>;
export type GuideScope = "saved" | "workspace" | "pair";
type Props = { planningSource?: PlanningSource; scope: GuideScope; savedPlanning: boolean; onChoice: (choice: GuideScope) => void; saved: GuideContext; workspace?: GuideContext; workspaceEvidence?: TerrainSummary | null; pair?: DisplayedPair; savedActions: GuideActions; workspaceActions?: GuideActions };
type Turn = GuideReply & { question: string; plan?: PlanningIntent; href?: string };

export default function GuideChat({ planningSource, scope, savedPlanning, onChoice, saved, workspace, workspaceEvidence, pair, savedActions, workspaceActions }: Props) {
  const { locale } = useLanguage();
  const labels = copy[locale];
  const context = (scope === "pair" ? pair?.context : scope === "workspace" ? workspace : saved) ?? saved;
  const localScope = scope === "workspace" || scope === "pair";
  const evidence = scope === "pair" ? pair?.comparison : workspaceEvidence;
  const [lastEvidence, setLastEvidence] = useState({ evidence, revision: 0 });
  // A replacement export can retain the same run, totals and site names with different windows.
  if (lastEvidence.evidence !== evidence) setLastEvidence({ evidence, revision: lastEvidence.revision + 1 });
  const source = planningSource ?? (savedPlanning ? "saved" : undefined);
  const conversationKey = [locale, scope, lastEvidence.revision, JSON.stringify(context), typeof source === "object" ? source.runId : source].join("|");
  const actions = scope === "saved" ? savedActions : scope === "pair" ? { ...workspaceActions, workspace: "#terrain-pair" } : workspaceActions ?? {};
  return <section className={styles.chat} aria-label={labels.title}>
    <h3>{labels.title}</h3>
      {typeof source === "string" && <p className={styles.notice}>{locale === "en" ? "Travel planning uses saved run " : "Câu hỏi lập kế hoạch dùng lần chạy đã lưu "}{source === "saved" ? "B" : "B2"}.</p>}
      {workspace && <label className={styles.label}>{labels.source}<select value={scope} onChange={e => {
        const value = e.target.value;
        if (value === "pair" || value === "workspace" || value === "saved") onChoice(value);
      }}>
        {pair && <option value="pair">{labels.pair}</option>}
        <option value="workspace">{labels.workspace}</option><option value="saved">{labels.saved}</option>
      </select></label>}
      {localScope && <p className={styles.notice}>
        {scope === "pair" ? (locale === "en" ? "Planning uses this site pair and its UTC window." : "Câu hỏi lập kế hoạch dùng cặp địa điểm này và khoảng UTC đang xem.")
          : (locale === "en" ? "Planning uses the sites and dates in this workspace." : "Câu hỏi lập kế hoạch dùng các địa điểm và khoảng ngày trong dữ liệu đang xem.")}
        {" "}<a href="/plan">{locale === "en" ? "Plan with the full catalog" : "Lập kế hoạch với toàn bộ danh mục"}</a>
      </p>}
      <Conversation key={conversationKey} source={source} localScope={localScope} evidence={evidence} context={context} actions={actions} />
  </section>;
}

function Conversation({ context, actions, source, localScope, evidence }: {
  source?: PlanningSource; context: GuideContext; actions: GuideActions; localScope: boolean;
  evidence?: TerrainSummary | DisplayedPair["comparison"] | null;
}) {
  const { locale } = useLanguage();
  const labels = copy[locale];
  const input = useId();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<GuideErrorKey | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  function cancel() {
    request.current?.abort();
    request.current = null;
    setBusy(false);
  }
  async function send() {
    const text = question.trim();
    if (!text || text.length > 500 || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const previous = turns.at(-1);
      const plan = planningIntent(text, previous?.plan);
      let reply: GuideReply & { plan?: PlanningIntent; href?: string };
      if (plan && localScope) reply = { ...answerWorkspacePlanning(plan, locale, context, evidence), plan };
      else if (plan) reply = { ...await answerPlanning(plan, locale, controller.signal, undefined, source), plan, action: null };
      else reply = await askGuide({ locale, question: text, previousQuestion: previous?.question, context }, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      setTurns(old => [...old.slice(-3), { question: text, ...reply }]);
      setQuestion("");
    } catch (cause) {
      if (request.current === controller && !controller.signal.aborted) setError(cause instanceof GuideRequestError ? cause.reason : "failed");
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }
  return <div className={styles.body} data-guide-pending={busy || undefined}>
    <strong>{labels.kinds[context.kind]}</strong>
    {context.rows.length > 0 && <p className={styles.notice}>{[...new Set(context.rows.map(row => row.site))].join(" · ")}<br />
      {labels.sourceId} · {context.rows[0].source}</p>}
    {context.rows.length > 0 && <details className={styles.scope}><summary>{labels.summary}</summary>
      <ul>{context.rows.map((row, i) => <li key={i}><b>{row.site}</b><br />{row.from} → {row.to} (UTC)<br />
        {labels.hours} · {[row.sunHours, row.earthHours, row.bothHours].map(h => h ?? labels.unknown).join(" / ")}<br />{row.source}</li>)}</ul>
    </details>}
    <div role="log" aria-label={labels.title} aria-live="polite">{turns.map((turn, i) => {
      const dest = turn.action && actions[turn.action];
      return <div key={i} className={styles.turn}><p><b>{labels.you}</b> · {turn.question}</p><p><b>{labels.guide}</b> · {turn.answer}</p>
        {turn.href && <a href={turn.href}>{turn.href.startsWith("/compare?") ? (locale === "en" ? "Open site observations" : "Mở kết quả quan sát địa điểm") : (locale === "en" ? "Open planner" : "Mở công cụ lập kế hoạch")}</a>}
        {turn.action && dest && (typeof dest === "string" ? <a href={dest} onClick={e => e.currentTarget.closest("aside")?.hidePopover()}>{labels.actions[turn.action]}</a>
          : <button type="button" onClick={e => { e.currentTarget.closest("aside")?.hidePopover(); dest(); }}>{labels.actions[turn.action]}</button>)}
      </div>;
    })}</div>
    <form onSubmit={e => { e.preventDefault(); void send(); }}>
      <label htmlFor={input}>{labels.prompt}</label>
      <textarea id={input} rows={2} maxLength={500} value={question} readOnly={busy} required onChange={e => { setQuestion(e.target.value); setError(null); }} />
      <p className={styles.notice} id={input + "-notice"}>{labels.privacy}</p>
      <div className={styles.buttons}><button type="submit" aria-describedby={input + "-notice"} disabled={busy || !question.trim()}>{error ? labels.retry : labels.send}</button>
        {busy && <button type="button" onClick={cancel}>{labels.cancel}</button>}
        {turns.length > 0 && <button type="button" onClick={() => { cancel(); setTurns([]); setQuestion(""); setError(null); }}>{labels.reset}</button>}
      </div>
    </form>
    <p role="status">{busy ? labels.waiting : error ? labels[error] : ""}</p>
  </div>;
}

"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { askGuide, GuideRequestError, type GuideErrorKey, type GuideAction, type GuideContext, type GuideReply } from "../lib/api/guide-chat";
import { planningIntent, type PlanningIntent } from "../lib/guide-planning";
import type { TerrainSummary } from "../lib/api/terrain-summary";
import type { DisplayedPair } from "./terrain-pair";
import { answerWorkspacePlanning } from "../lib/guide-workspace-planning";
import { answerPlanning, type PlanningAnswer, type PlanningSource } from "../lib/api/guide-planning";
import { useLanguage } from "./language";
import styles from "./guide-chat.module.css";

const copy = {
  en: {
    title: "Chat with the AI guide", suggested: "Suggested questions", about: "About this answer and your data", source: "Use data from", saved: "Saved comparison", workspace: "Current workspace", pair: "Displayed site pair",
    kinds: { saved: "Saved team model", terrain: "Terrain model", scenario: "Supplied scenario", synthetic: "Simulated example", unavailable: "No shareable observation summary" },
    summary: "See UTC ranges and hours", sourceId: "Source", privacy: "Planning questions about the current workspace, displayed pair and saved archives use data on your device. The live planner requests model data from the team API. For other questions, this site's server receives your question, the previous question if any, and the selected summary. When this server uses OpenAI, it sends your question, the previous question and the site names and dates to OpenAI. Your file stays on your device.",
    hours: "Hours visible · Sun / Earth / both", unknown: "unknown", invalid: "Edit the question and send it again.", prompt: "Your question", send: "Send", cancel: "Cancel", reset: "Clear chat", retry: "Try again",
    waiting: "The AI guide is typing…", failed: "The guide couldn’t answer. You can try again or use the questions below.",
    offline: "The language model is unavailable. You can still enter your travel dates and ask which site has the most hours with both the Sun and Earth visible.", slow: "The guide timed out. Try again.", limited: "The guide is busy. Please try again shortly.",
    openSummary: "Open visibility summary", openObservations: "Open site observations", openPlanner: "Open planner",
    you: "You", guide: "AI guide", actions: { workspace: "Open workspace", saved: "Open saved result", sources: "View sources", compareSites: "Compare sites", compareDates: "Compare dates" },
  },
  vi: {
    title: "Trò chuyện với trợ lý AI", suggested: "Câu hỏi gợi ý", about: "Về câu trả lời và dữ liệu của bạn", source: "Chọn dữ liệu để hỏi", saved: "Kết quả đã lưu", workspace: "Dữ liệu đang xem", pair: "Cặp địa điểm đang so sánh",
    kinds: { saved: "Kết quả mô hình đã lưu", terrain: "Mô hình địa hình", scenario: "Kịch bản đã tải", synthetic: "Dữ liệu mô phỏng", unavailable: "Chưa có dữ liệu quan sát phù hợp để gửi" },
    summary: "Xem khoảng thời gian UTC và số giờ", sourceId: "Nguồn", privacy: "Câu hỏi lập kế hoạch về dữ liệu đang xem, cặp địa điểm đang so sánh và các bản đã lưu dùng dữ liệu trên thiết bị của bạn. Công cụ lập kế hoạch trực tuyến truy vấn API của nhóm. Với các câu hỏi khác, máy chủ của trang nhận câu hỏi hiện tại, câu hỏi ngay trước đó (nếu có) và phần dữ liệu tóm tắt đã chọn. Khi dùng OpenAI, máy chủ gửi cho OpenAI câu hỏi hiện tại, câu hỏi trước đó, tên địa điểm và khoảng ngày. Tệp gốc vẫn nằm trên thiết bị của bạn.",
    hours: "Số giờ nhìn thấy · Mặt Trời / Trái Đất / cả hai", unknown: "chưa xác định", invalid: "Hãy sửa câu hỏi rồi gửi lại.", prompt: "Câu hỏi của bạn", send: "Gửi", cancel: "Hủy", reset: "Xóa cuộc trò chuyện", retry: "Thử lại",
    waiting: "Trợ lý AI đang trả lời…", failed: "Chưa có câu trả lời. Bạn có thể thử lại hoặc chọn một câu hỏi bên dưới.",
    offline: "Mô hình ngôn ngữ hiện chưa hoạt động. Bạn vẫn có thể nhập khoảng ngày và hỏi địa điểm nào có nhiều giờ cùng thấy Mặt Trời và Trái Đất nhất.", slow: "Đã hết thời gian chờ. Hãy thử lại.", limited: "Phi hành gia đang bận. Bạn vui lòng thử lại sau.",
    openSummary: "Mở tóm tắt thời gian quan sát", openObservations: "Mở kết quả quan sát địa điểm", openPlanner: "Mở công cụ lập kế hoạch",
    you: "Bạn", guide: "Trợ lý AI", actions: { workspace: "Mở phần quan sát", saved: "Mở kết quả đã lưu", sources: "Xem nguồn dữ liệu", compareSites: "So sánh hai địa điểm", compareDates: "So sánh hai khoảng thời gian" },
  },
} as const;

export type GuideDestination = string | (() => void);
export type GuideActions = Partial<Record<GuideAction, GuideDestination>>;
export type GuideScope = "saved" | "workspace" | "pair";
export type GuideSuggestion = { question: string; answer?: string };
type Props = { suggestions?: GuideSuggestion[]; planningSource?: PlanningSource; scope: GuideScope; savedPlanning: boolean; onChoice: (choice: GuideScope) => void; saved: GuideContext; workspace?: GuideContext; workspaceEvidence?: TerrainSummary | null; pair?: DisplayedPair; savedActions: GuideActions; workspaceActions?: GuideActions };
type Turn = GuideReply & { question: string; plan?: PlanningIntent; href?: string; canned?: boolean } & Pick<PlanningAnswer, "siteChoices" | "choiceSource">;

export default function GuideChat({ suggestions = [], planningSource, scope, savedPlanning, onChoice, saved, workspace, workspaceEvidence, pair, savedActions, workspaceActions }: Props) {
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
      <Conversation key={conversationKey} suggestions={suggestions} source={source} localScope={localScope} evidence={evidence} context={context} actions={actions} />
  </section>;
}

function Conversation({ suggestions, context, actions, source, localScope, evidence }: {
  suggestions: GuideSuggestion[]; source?: PlanningSource; context: GuideContext; actions: GuideActions; localScope: boolean;
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
  const field = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  // Keep the newest message in view, and let the field grow to four lines.
  useEffect(() => { log.current?.lastElementChild?.scrollIntoView({ block: "nearest" }); }, [turns, busy, error]);
  useEffect(() => {
    const area = field.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = Math.min(area.scrollHeight + 2, 118) + "px";
  }, [question]);

  function cancel() {
    request.current?.abort();
    request.current = null;
    setBusy(false);
  }
  async function send(override?: string) {
    const text = (override ?? question).trim();
    if (!text || text.length > 500 || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const previous = turns.at(-1);
      const plan = planningIntent(text, previous?.plan, previous?.siteChoices);
      let reply: Omit<Turn, "question">;
      if (plan && localScope) reply = { ...answerWorkspacePlanning(plan, locale, context, evidence), plan };
      else if (plan) reply = { ...await answerPlanning(plan, locale, controller.signal, undefined, source ?? (plan.continuesSiteChoice ? previous?.choiceSource : undefined)), plan, action: null };
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
  const sourceLine = context.rows.length > 0 ? `${labels.sourceId} · ${context.rows[0].source} · ${context.rows[0].from} → ${context.rows[0].to} UTC` : "";
  return <div className={styles.body} data-guide-pending={busy || undefined}>
    {turns.length === 0 && suggestions.length > 0 && <div className={styles.chips} role="group" aria-label={labels.suggested}>
      {suggestions.map(item => <button type="button" className="chip" key={item.question} disabled={busy} onClick={() => {
        if (item.answer) { setError(null); setTurns([{ question: item.question, answer: item.answer, action: null, canned: true }]); }
        else void send(item.question);
      }}>{item.question}</button>)}
    </div>}
    <div role="log" ref={log} className={styles.log} aria-label={labels.title} aria-live="polite">{turns.map((turn, i) => {
      const dest = turn.action && actions[turn.action];
      return <Fragment key={i}>
        <p className={styles.user}><span className="sr-only">{labels.you}: </span>{turn.question}</p>
        <div className={styles.guide}><p><span className="sr-only">{labels.guide}: </span>{turn.answer}</p>
          {turn.href && <a href={turn.href}>{turn.href.endsWith("#workspace") ? labels.openSummary : turn.href.startsWith("/compare?") ? labels.openObservations : labels.openPlanner}</a>}
          {turn.action && dest && (typeof dest === "string" ? <a href={dest} onClick={e => e.currentTarget.closest("aside")?.hidePopover()}>{labels.actions[turn.action]}</a>
            : <button type="button" onClick={e => { e.currentTarget.closest("aside")?.hidePopover(); dest(); }}>{labels.actions[turn.action]}</button>)}
          {!turn.canned && sourceLine && <small className={styles.meta}>{sourceLine}</small>}
        </div>
      </Fragment>;
    })}
      {busy && <p className={styles.typing}><i /><i /><i /><span>{labels.waiting}</span></p>}
      {!busy && error && <p className={styles.error}>{labels[error]}</p>}
    </div>
    <form className={styles.inputRow} onSubmit={e => { e.preventDefault(); void send(); }}>
      <label className="sr-only" htmlFor={input}>{labels.prompt}</label>
      <textarea id={input} ref={field} rows={1} maxLength={500} value={question} readOnly={busy} required placeholder={labels.prompt}
        aria-describedby={input + "-notice"}
        onChange={e => { setQuestion(e.target.value); setError(null); }}
        onKeyDown={e => {
          // Enter sends; Shift+Enter adds a line. Leave the key alone while an input method is composing.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
        }} />
      <button type="submit" className="btn btn-primary btn-compact" disabled={busy || !question.trim()}>{error ? labels.retry : labels.send}</button>
    </form>
    {(busy || turns.length > 0) && <div className={styles.tools}>
      {busy && <button type="button" className="btn-ghost" onClick={cancel}>{labels.cancel}</button>}
      {turns.length > 0 && <button type="button" className="btn-ghost" onClick={() => { cancel(); setTurns([]); setQuestion(""); setError(null); }}>{labels.reset}</button>}
    </div>}
    <p role="status" className="sr-only">{busy ? labels.waiting : error ? labels[error] : ""}</p>
    <details className={styles.scope}><summary>{labels.about}</summary>
      <p className={styles.notice} id={input + "-notice"}>{labels.privacy}</p>
      <p className={styles.notice}><strong>{labels.kinds[context.kind]}</strong></p>
      {context.rows.length > 0 && <ul>{context.rows.map((row, i) => <li key={i}><b>{row.site}</b> · {row.from} → {row.to} (UTC)<br />
        {labels.hours} · {[row.sunHours, row.earthHours, row.bothHours].map(h => h ?? labels.unknown).join(" / ")} · {row.source}</li>)}</ul>}
    </details>
  </div>;
}

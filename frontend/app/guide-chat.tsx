"use client";

import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
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
    waiting: "The AI guide is typing…", failed: "The guide couldn’t answer just now.",
    offline: "The language model is unavailable. You can still enter your travel dates and ask which site has the most hours with both the Sun and Earth visible.", slow: "The guide timed out. Try again.", limited: "Too many questions. Wait a few seconds, then try again.",
    openSummary: "Open visibility summary", openObservations: "Open site observations", openPlanner: "Open planner",
    you: "You", guide: "AI guide", actions: { workspace: "Open workspace", saved: "Open saved result", sources: "View sources", compareSites: "Compare sites", compareDates: "Compare dates" },
  },
  vi: {
    title: "Trò chuyện với trợ lý AI", suggested: "Câu hỏi gợi ý", about: "Về câu trả lời và dữ liệu của bạn", source: "Chọn dữ liệu để hỏi", saved: "Kết quả đã lưu", workspace: "Dữ liệu đang xem", pair: "Cặp địa điểm đang so sánh",
    kinds: { saved: "Kết quả mô hình đã lưu", terrain: "Mô hình địa hình", scenario: "Kịch bản đã tải", synthetic: "Dữ liệu mô phỏng", unavailable: "Chưa có dữ liệu quan sát phù hợp để gửi" },
    summary: "Xem khoảng thời gian UTC và số giờ", sourceId: "Nguồn", privacy: "Câu hỏi lập kế hoạch về dữ liệu đang xem, cặp địa điểm đang so sánh và các bản đã lưu dùng dữ liệu trên thiết bị của bạn. Công cụ lập kế hoạch trực tuyến truy vấn API của nhóm. Với các câu hỏi khác, máy chủ của trang nhận câu hỏi hiện tại, câu hỏi ngay trước đó (nếu có) và phần dữ liệu tóm tắt đã chọn. Khi dùng OpenAI, máy chủ gửi cho OpenAI câu hỏi hiện tại, câu hỏi trước đó, tên địa điểm và khoảng ngày. Tệp gốc vẫn nằm trên thiết bị của bạn.",
    hours: "Số giờ nhìn thấy · Mặt Trời / Trái Đất / cả hai", unknown: "chưa xác định", invalid: "Hãy sửa câu hỏi rồi gửi lại.", prompt: "Câu hỏi của bạn", send: "Gửi", cancel: "Hủy", reset: "Xóa cuộc trò chuyện", retry: "Thử lại",
    waiting: "Trợ lý AI đang trả lời…", failed: "Trợ lý chưa trả lời được lúc này.",
    offline: "Mô hình ngôn ngữ hiện chưa hoạt động. Bạn vẫn có thể nhập khoảng ngày và hỏi địa điểm nào có nhiều giờ cùng thấy Mặt Trời và Trái Đất nhất.", slow: "Đã hết thời gian chờ. Hãy thử lại.", limited: "Bạn hỏi hơi nhanh. Hãy đợi vài giây rồi thử lại.",
    openSummary: "Mở tóm tắt thời gian quan sát", openObservations: "Mở kết quả quan sát địa điểm", openPlanner: "Mở công cụ lập kế hoạch",
    you: "Bạn", guide: "Trợ lý AI", actions: { workspace: "Mở phần quan sát", saved: "Mở kết quả đã lưu", sources: "Xem nguồn dữ liệu", compareSites: "So sánh hai địa điểm", compareDates: "So sánh hai khoảng thời gian" },
  },
} as const;

export type GuideDestination = string | (() => void);
export type GuideActions = Partial<Record<GuideAction, GuideDestination>>;
export type GuideScope = "saved" | "workspace" | "pair";
export type GuideSuggestion = { question: string; answer?: string };

// The last conversation stays in this tab's sessionStorage, so it survives page navigation until "New chat".
const HISTORY_KEY = "moon-plan-b-guide-chat";
export function clearGuideHistory() {
  try { sessionStorage.removeItem(HISTORY_KEY); } catch { /* The chat still clears when storage is unavailable. */ }
}
function storedTurns(): Turn[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((turn): turn is Turn => typeof turn === "object" && turn !== null &&
      typeof (turn as Turn).question === "string" && typeof (turn as Turn).answer === "string").slice(-4)
      .map(turn => ({ question: turn.question, answer: turn.answer, action: null, href: typeof turn.href === "string" && turn.href.startsWith("/") ? turn.href : undefined, canned: turn.canned === true }));
  } catch { return []; }
}

// Presentation only: one paragraph per line, site names and figures in bold, timestamps shortened,
// and the per-row source ids dropped because one "Source" line follows the answer.
function formatAnswer(text: string, sites: string[]): ReactNode {
  const names = [...new Set(sites.flatMap(site => [site, site.split(" · ")[0]]))].filter(Boolean)
    .sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const strong = new RegExp(`(${[...names, "\\d+(?:[.,]\\d+)?\\s?(?:h|giờ|%|°)(?![\\p{L}\\d])"].join("|")})`, "gu");
  return text.split("\n").map(line => line
      .replace(/\s*·\s*(?:Source|Nguồn)\s*·\s*[\w.-]+/g, "")
      .replace(/(\d{4}-\d{2}-\d{2})T00:00:00Z/g, "$1")
      .replace(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):00Z/g, "$1 $2 UTC").trim())
    .filter(Boolean).map((line, i) => <p key={i}>{line.split(strong).map((part, j) => j % 2 ? <strong key={j}>{part}</strong> : part)}</p>);
}

type Props = { suggestions?: GuideSuggestion[]; epoch?: number; planningSource?: PlanningSource; scope: GuideScope; savedPlanning: boolean; onChoice: (choice: GuideScope) => void; saved: GuideContext; workspace?: GuideContext; workspaceEvidence?: TerrainSummary | null; pair?: DisplayedPair; savedActions: GuideActions; workspaceActions?: GuideActions };
type Turn = GuideReply & { question: string; plan?: PlanningIntent; href?: string; canned?: boolean } & Pick<PlanningAnswer, "siteChoices" | "choiceSource">;

export default function GuideChat({ suggestions = [], epoch = 0, planningSource, scope, savedPlanning, onChoice, saved, workspace, workspaceEvidence, pair, savedActions, workspaceActions }: Props) {
  const { locale } = useLanguage();
  const labels = copy[locale];
  const context = (scope === "pair" ? pair?.context : scope === "workspace" ? workspace : saved) ?? saved;
  const localScope = scope === "workspace" || scope === "pair";
  const evidence = scope === "pair" ? pair?.comparison : workspaceEvidence;
  const [lastEvidence, setLastEvidence] = useState({ evidence, revision: 0 });
  // A replacement export can retain the same run, totals and site names with different windows.
  if (lastEvidence.evidence !== evidence) setLastEvidence({ evidence, revision: lastEvidence.revision + 1 });
  const source = planningSource ?? (savedPlanning ? "saved" : undefined);
  const conversationKey = [epoch, locale, scope, lastEvidence.revision, JSON.stringify(context), typeof source === "object" ? source.runId : source].join("|");
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
  const [turns, setTurns] = useState<Turn[]>(storedTurns);
  // The question being sent, or the one that failed and can be retried.
  const [pending, setPending] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<GuideErrorKey | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  // On a desktop the field is ready to type in as soon as the panel opens; a phone keeps its keyboard down.
  useEffect(() => { if (window.matchMedia("(min-width: 1000px)").matches) field.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(turns.map(({ question, answer, href, canned }) => ({ question, answer, href, canned })))); }
    catch { /* The chat works without storage. */ }
  }, [turns]);
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
    setPending(null);
  }
  async function send(override?: string) {
    const text = (override ?? question).trim();
    if (!text || text.length > 500 || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    setPending(text);
    try {
      const previous = turns.at(-1);
      const plan = planningIntent(text, previous?.plan, previous?.siteChoices);
      let reply: Omit<Turn, "question">;
      if (plan && localScope) reply = { ...answerWorkspacePlanning(plan, locale, context, evidence), plan };
      else if (plan) reply = { ...await answerPlanning(plan, locale, controller.signal, undefined, source ?? (plan.continuesSiteChoice ? previous?.choiceSource : undefined)), plan, action: null };
      else reply = await askGuide({ locale, question: text, previousQuestion: previous?.question, context }, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      setTurns(old => [...old.slice(-3), { question: text, ...reply }]);
      setPending(null);
      setQuestion("");
    } catch (cause) {
      if (request.current === controller && !controller.signal.aborted) setError(cause instanceof GuideRequestError ? cause.reason : "failed");
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }
  const sourceLine = context.rows.length > 0 ? `${labels.sourceId}: ${context.rows[0].source}` : "";
  return <div className={styles.body} data-guide-pending={busy || undefined}>
    {turns.length === 0 && !pending && suggestions.length > 0 && <div className={styles.chips} role="group" aria-label={labels.suggested}>
      {suggestions.map(item => <button type="button" className="chip" key={item.question} disabled={busy} onClick={() => {
        if (item.answer) { setError(null); setTurns([{ question: item.question, answer: item.answer, action: null, canned: true }]); }
        else void send(item.question);
      }}>{item.question}</button>)}
    </div>}
    <div role="log" ref={log} className={styles.log} aria-label={labels.title} aria-live="polite">{turns.map((turn, i) => {
      const dest = turn.action && actions[turn.action];
      return <Fragment key={i}>
        <p className={styles.user}><span className="sr-only">{labels.you}: </span>{turn.question}</p>
        <div className={styles.guide}><span className="sr-only">{labels.guide}: </span>{formatAnswer(turn.answer, context.rows.map(row => row.site))}
          {turn.href && <a href={turn.href}>{turn.href.endsWith("#workspace") ? labels.openSummary : turn.href.startsWith("/compare?") ? labels.openObservations : labels.openPlanner}</a>}
          {turn.action && dest && (typeof dest === "string" ? <a href={dest} onClick={e => e.currentTarget.closest("aside")?.hidePopover()}>{labels.actions[turn.action]}</a>
            : <button type="button" onClick={e => { e.currentTarget.closest("aside")?.hidePopover(); dest(); }}>{labels.actions[turn.action]}</button>)}
          {!turn.canned && sourceLine && <small className={styles.meta}>{sourceLine}</small>}
        </div>
      </Fragment>;
    })}
      {pending && <p className={styles.user}><span className="sr-only">{labels.you}: </span>{pending}</p>}
      {busy && <p className={styles.typing}><i /><i /><i /><span>{labels.waiting}</span></p>}
      {!busy && error && <div className={styles.error}><p>{labels[error]}</p>
        {pending && error !== "invalid" && <button type="button" onClick={() => void send(pending)}>{labels.retry}</button>}
      </div>}
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
      <button type="submit" className="btn btn-primary btn-compact" disabled={busy || !question.trim()}>{labels.send}</button>
    </form>
    {busy && <div className={styles.tools}><button type="button" className="btn-ghost" onClick={cancel}>{labels.cancel}</button></div>}
    <p role="status" className="sr-only">{busy ? labels.waiting : error ? labels[error] : ""}</p>
    <details className={styles.scope}><summary>{labels.about}</summary>
      <p className={styles.notice} id={input + "-notice"}>{labels.privacy}</p>
      <p className={styles.notice}><strong>{labels.kinds[context.kind]}</strong></p>
      {context.rows.length > 0 && <ul>{context.rows.map((row, i) => <li key={i}><b>{row.site}</b> · {row.from} → {row.to} (UTC)<br />
        {labels.hours} · {[row.sunHours, row.earthHours, row.bothHours].map(h => h ?? labels.unknown).join(" / ")} · {row.source}</li>)}</ul>}
    </details>
  </div>;
}

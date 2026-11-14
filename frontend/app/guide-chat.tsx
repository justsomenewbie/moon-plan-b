"use client";

import { useEffect, useId, useRef, useState } from "react";
import { askGuide, GuideRequestError, type GuideErrorKey, type GuideAction, type GuideContext, type GuideReply } from "../lib/api/guide-chat";
import { useLanguage } from "./language";
import styles from "./guide-chat.module.css";

const copy = {
  en: {
    title: "Ask the astronaut", source: "Use data from", saved: "Saved comparison", workspace: "Current workspace",
    kinds: { saved: "Saved team model", terrain: "Terrain model", scenario: "Supplied scenario", synthetic: "Simulated example", unavailable: "No shareable observation summary" },
    summary: "See UTC ranges and hours", sourceId: "Source", privacy: "Sending shares your question, the previous question if any, and the selected summary with this site's server. Your file stays on your device.",
    hours: "Hours visible · Sun / Earth / both", unknown: "unknown", invalid: "Edit the question and send it again.", prompt: "Your question", send: "Send", cancel: "Cancel", reset: "Clear chat", retry: "Try again",
    waiting: "Waiting for the guide…", failed: "The guide couldn’t answer. You can try again or use the questions below.",
    offline: "The model is unavailable. You can still use the questions below.", slow: "The guide timed out. Try again.", limited: "The guide is busy. Please try again shortly.",
    you: "You", guide: "Astronaut", actions: { workspace: "Open workspace", saved: "Open saved result", sources: "View sources", compareSites: "Compare sites", compareDates: "Compare dates" },
  },
  vi: {
    title: "Hỏi phi hành gia", source: "Chọn dữ liệu để hỏi", saved: "Kết quả đã lưu", workspace: "Dữ liệu đang xem",
    kinds: { saved: "Kết quả mô hình đã lưu", terrain: "Mô hình địa hình", scenario: "Kịch bản đã tải", synthetic: "Dữ liệu mô phỏng", unavailable: "Chưa có dữ liệu quan sát phù hợp để gửi" },
    summary: "Xem khoảng thời gian UTC và số giờ", sourceId: "Nguồn", privacy: "Khi bạn bấm Gửi, máy chủ của trang nhận câu hỏi, câu hỏi ngay trước đó (nếu có) và phần dữ liệu tóm tắt đã chọn. Tệp gốc vẫn nằm trên thiết bị của bạn.",
    hours: "Số giờ nhìn thấy · Mặt Trời / Trái Đất / cả hai", unknown: "chưa xác định", invalid: "Hãy sửa câu hỏi rồi gửi lại.", prompt: "Câu hỏi của bạn", send: "Gửi", cancel: "Hủy", reset: "Xóa cuộc trò chuyện", retry: "Thử lại",
    waiting: "Phi hành gia đang trả lời…", failed: "Chưa có câu trả lời. Bạn có thể thử lại hoặc chọn một câu hỏi bên dưới.",
    offline: "Mô hình hiện chưa hoạt động. Bạn vẫn có thể chọn một câu hỏi bên dưới.", slow: "Đã hết thời gian chờ. Hãy thử lại.", limited: "Phi hành gia đang bận. Bạn vui lòng thử lại sau.",
    you: "Bạn", guide: "Phi hành gia", actions: { workspace: "Mở phần quan sát", saved: "Mở kết quả đã lưu", sources: "Xem nguồn dữ liệu", compareSites: "So sánh hai địa điểm", compareDates: "So sánh hai khoảng thời gian" },
  },
} as const;

export type GuideDestination = string | (() => void);
export type GuideActions = Partial<Record<GuideAction, GuideDestination>>;
type Props = { saved: GuideContext; workspace?: GuideContext; savedActions: GuideActions; workspaceActions?: GuideActions };
type Turn = GuideReply & { question: string };

export default function GuideChat({ saved, workspace, savedActions, workspaceActions }: Props) {
  const { locale } = useLanguage();
  const labels = copy[locale];
  const [opened, setOpened] = useState(false);
  const [useSaved, setUseSaved] = useState(!workspace);
  const context = (useSaved ? saved : workspace) ?? saved;
  return <details className={styles.chat} onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>{labels.title}</summary>
    {opened && <>
      {workspace && <label className={styles.label}>{labels.source}<select value={useSaved ? "saved" : "workspace"} onChange={e => setUseSaved(e.target.value === "saved")}>
        <option value="workspace">{labels.workspace}</option><option value="saved">{labels.saved}</option>
      </select></label>}
      <Conversation key={locale + JSON.stringify(context) + useSaved} context={context} actions={useSaved ? savedActions : workspaceActions ?? {}} />
    </>}
  </details>;
}

function Conversation({ context, actions }: { context: GuideContext; actions: GuideActions }) {
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
      const reply = await askGuide({ locale, question: text, previousQuestion: turns.at(-1)?.question, context }, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      setTurns(old => [...old.slice(-3), { question: text, ...reply }]);
      setQuestion("");
    } catch (cause) {
      if (request.current === controller && !controller.signal.aborted) setError(cause instanceof GuideRequestError ? cause.reason : "failed");
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }
  return <div className={styles.body}>
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

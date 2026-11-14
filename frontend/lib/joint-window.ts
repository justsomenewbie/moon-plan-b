type Span = {
  start: string; end: string;
  clipped_start?: boolean; clipped_end?: boolean; truncated_start?: boolean; truncated_end?: boolean;
};
type JointWindow = { start: string; end: string; hours: number; startClipped?: boolean; endClipped?: boolean };

// Model windows are validated and ordered. Adjacent visible spans form one uninterrupted interval.
export function longestJointWindow(windows: readonly Span[], from: string, to: string): JointWindow | null {
  const lower = Date.parse(from), upper = Date.parse(to);
  let lastEnd = NaN, continuousStart = 0, startClipped = false;
  let best: JointWindow | null = null;
  const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
  for (const window of windows) {
    const start = Math.max(lower, Date.parse(window.start)), end = Math.min(upper, Date.parse(window.end));
    if (start >= end) continue;
    if (start !== lastEnd) {
      continuousStart = start;
      startClipped = Boolean(window.clipped_start || window.truncated_start);
    }
    lastEnd = end;
    const hours = (end - continuousStart) / 3600000;
    if (!best || hours > best.hours) {
      best = { start: iso(continuousStart), end: iso(end), hours, startClipped,
        endClipped: Boolean(window.clipped_end || window.truncated_end) };
    }
  }
  return best;
}

export function describeLongestJoint(rows: readonly { name: string; window: JointWindow | null }[], locale: "en" | "vi",
  period: { from: string; to: string; stepSeconds: number }) {
  const vi = locale === "vi";
  if (!rows.length) return vi ? "Chưa có địa điểm nào đủ dữ liệu trong khoảng yêu cầu." : "No site has complete coverage for the requested dates.";
  const longest = Math.max(...rows.map(row => row.window?.hours ?? 0));
  if (!longest) return vi ? "Không địa điểm nào đã đánh giá có khoảng cùng thấy Mặt Trời và Trái Đất." : "No evaluated site has a joint Sun and Earth visibility window.";
  const lines = [vi ? "Khoảng liên tục dài nhất cùng thấy Mặt Trời và Trái Đất" : "Longest uninterrupted Sun and Earth visibility"];
  for (const { name, window } of rows) {
    if (window?.hours !== longest) continue;
    let line = name + " · " + window.hours + " h · " + window.start + " → " + window.end;
    // The selected UTC limits can clip visibility already in progress.
    const starts = !window.startClipped && window.start > period.from;
    const ends = !window.endClipped && window.end < period.to;
    if (starts || ends) {
      const label = starts && ends ? (vi ? "Bắt đầu và kết thúc cùng thấy" : "Visibility starts and ends")
        : starts ? (vi ? "Bắt đầu cùng thấy" : "Visibility starts") : (vi ? "Kết thúc cùng thấy" : "Visibility ends");
      const step = period.stepSeconds;
      const precision = step % 3600 === 0 ? step / 3600 + " h" : step % 60 === 0 ? step / 60 + " min" : step + " s";
      line += " · " + label + " ±" + precision;
    }
    lines.push(line);
  }
  lines.push(vi ? "Mỗi địa điểm đồng hạng hiển thị khoảng sớm nhất trong các ngày đã chọn (UTC, không gồm mốc cuối)." : "Each tied site shows its earliest matching interval within the selected dates (UTC, end exclusive).");
  return lines.join("\n");
}

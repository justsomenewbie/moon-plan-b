type Span = { start: string; end: string };
type JointWindow = Span & { hours: number };

// Model windows are validated and ordered. Adjacent visible spans form one uninterrupted interval.
export function longestJointWindow(windows: readonly Span[], from: string, to: string): JointWindow | null {
  const lower = Date.parse(from), upper = Date.parse(to);
  let lastEnd = NaN, continuousStart = 0, bestStart = 0, bestDuration = 0;
  for (const window of windows) {
    const start = Math.max(lower, Date.parse(window.start)), end = Math.min(upper, Date.parse(window.end));
    if (start >= end) continue;
    if (start !== lastEnd) continuousStart = start;
    lastEnd = end;
    if (end - continuousStart > bestDuration) {
      bestStart = continuousStart;
      bestDuration = end - continuousStart;
    }
  }
  if (!bestDuration) return null;
  const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
  return { start: iso(bestStart), end: iso(bestStart + bestDuration), hours: bestDuration / 3600000 };
}

export function describeLongestJoint(rows: readonly { name: string; window: JointWindow | null }[], locale: "en" | "vi") {
  const vi = locale === "vi";
  if (!rows.length) return vi ? "Chưa có địa điểm nào đủ dữ liệu trong khoảng yêu cầu." : "No site has complete coverage for the requested dates.";
  const longest = Math.max(...rows.map(row => row.window?.hours ?? 0));
  if (!longest) return vi ? "Không địa điểm nào đã đánh giá có khoảng cùng thấy Mặt Trời và Trái Đất." : "No evaluated site has a joint Sun and Earth visibility window.";
  const lines = [vi ? "Khoảng liên tục dài nhất cùng thấy Mặt Trời và Trái Đất" : "Longest uninterrupted Sun and Earth visibility"];
  for (const { name, window } of rows) {
    if (window?.hours === longest) lines.push(name + " · " + window.hours + " h · " + window.start + " → " + window.end);
  }
  lines.push(vi ? "Mỗi địa điểm đồng hạng hiển thị khoảng sớm nhất trong các ngày đã chọn (UTC, không gồm mốc cuối)." : "Each tied site shows its earliest matching interval within the selected dates (UTC, end exclusive).");
  return lines.join("\n");
}

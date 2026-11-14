// Keep UTC dates in the visitor's words. A language-model classification must never supply a missing year or a different window.
export type PlanningMode = "sites" | "dates" | "observation";
export type PlanningIntent = {
  mode: PlanningMode; from: string | null; to: string | null; missionHours: number | null;
  priority: "joint" | "sun" | "earth"; siteText: string; dateProblem: boolean;
};
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthPattern = months.map(m => m.slice(0, 3) + "(?:" + m.slice(3) + ")?").join("|");
const year = "(20[0-9]{2})", day = "([0-9]{1,2})(?:st|nd|rd|th)?", between = "(?:\\s*(?:to|until|through|đến|tới|[-–—])\\s*)";

export function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value + "T");
}
const utcDay = (y: string, m: number, d: string) => y + "-" + String(m).padStart(2, "0") + "-" + d.padStart(2, "0");
const monthNumber = (m: string) => months.findIndex(name => name.startsWith(m.slice(0, 3))) + 1;

function calendarDays(text: string) {
  const iso = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map(m => m[1]);
  if (iso.length) return iso;
  const vi = text.match(/\b(\d{1,2})(?:\s*\/\s*(\d{1,2}))?\s*(?:đến|tới|[-–—])\s*(\d{1,2})\s*(?:tháng|\/)\s*(\d{1,2})\s*(?:năm|\/)?\s*(20\d{2})\b/);
  if (vi) return [utcDay(vi[5], Number(vi[2] ?? vi[4]), vi[1]), utcDay(vi[5], Number(vi[4]), vi[3])];
  const en = text.match(new RegExp("\\b(" + monthPattern + ")\\s+" + day + between + "(?:(" + monthPattern + ")\\s+)?" + day + ",?\\s+" + year + "\\b", "i"));
  if (en) return [utcDay(en[5], monthNumber(en[1]), en[2]), utcDay(en[5], monthNumber(en[3] ?? en[1]), en[4])];
  const reversed = text.match(new RegExp("\\b" + day + between + day + "\\s+(" + monthPattern + "),?\\s+" + year + "\\b", "i"));
  if (reversed) return [utcDay(reversed[4], monthNumber(reversed[3]), reversed[1]), utcDay(reversed[4], monthNumber(reversed[3]), reversed[2])];
  const viFull = [...text.matchAll(/\b(\d{1,2})\s*(?:tháng|\/)\s*(\d{1,2})\s*(?:năm|\/)\s*(20\d{2})\b/g)];
  if (viFull.length) return viFull.map(m => utcDay(m[3], Number(m[2]), m[1]));
  const enFull = [...text.matchAll(new RegExp("\\b(" + monthPattern + ")\\s+" + day + ",?\\s+" + year + "\\b", "g"))];
  if (enFull.length) return enFull.map(m => utcDay(m[3], monthNumber(m[1]), m[2]));
  return [...text.matchAll(new RegExp("\\b" + day + "\\s+(" + monthPattern + "),?\\s+" + year + "\\b", "g"))].map(m => utcDay(m[3], monthNumber(m[2]), m[1]));
}

export function planningIntent(question: string, previous?: PlanningIntent): PlanningIntent | null {
  const q = question.trim().toLowerCase().normalize("NFC");
  const dates = calendarDays(q);
  const mentionsDate = dates.length > 0 || /\b20\d{2}\b|\d\s*\/\s*\d|tháng\s+\d|\b(?:today|tomorrow|next week)\b|ngày mai|hôm nay|tuần tới/.test(q)
    || new RegExp("\\b(?:" + monthPattern + ")\\b[^?!]{0,12}\\d|\\d[^?!]{0,12}\\b(?:" + monthPattern + ")\\b").test(q);
  const when = /\bwhen\b|best (?:date|time|window)|khi nào|lúc nào|bao giờ|thời điểm nào|ngày nào|thời gian nào/.test(q);
  const where = /\b(?:best site|best place|best destination)\b|\bwhere\b|\bwhich (?:lunar |landing )?(?:site|place|location|destination)s?\b|địa điểm nào|nơi nào|ở đâu|đi đâu|chỗ nào|điểm nào/.test(q);
  const visiting = /\b(go|visit|trip|travel|land|mission|choose|recommend)\b|muốn đi|muon di|nên đi|hạ cánh|ghé|lựa chọn|nên chọn|gợi ý/.test(q);
  const duration = q.match(/\b(\d+(?:\.\d+)?)\s*[- ]?\s*(hours?|hrs?|h\b|days?|giờ|ngày)/);
  const miss = /an toàn|\bsafe(?:st|ty)?\b|\bfuel\b|\bradiation\b|nhiên liệu|bức xạ/.test(q);
  const informational = /\bwhen (?:was|were|did|is (?:the )?(?:sun|earth)|does (?:the )?(?:sun|earth))\b|\bwhen did\b|phóng (?:vào )?khi nào|hạ cánh vào năm nào/.test(q);
  const aboutSource = /\b(?:source|provenance|who computed|how was|where did)\b|nguồn|tính bằng cách nào/.test(q);
  const unrelated = /\b(weather|hotel|restaurant|flight to|football|ticket|disney|stock)\b|khách sạn|vé máy bay|thời tiết|nhà hàng/.test(q);
  if (miss || unrelated || informational || aboutSource || /[?;]\s*\S|\b(?:and|or)\s+(?:wh(?:at|ich|ere|en|y)|how|can|is|does)\b/.test(q) || /\b(?:switch|open)\b.{0,20}\b(?:mode|comparison)\b|chuyển sang/.test(q)) return null;
  const followup = previous && !when && !where && !visiting && (mentionsDate || duration || (previous.mode !== "sites" && q.split(/\s+/).length <= 5 && !/[?]/.test(q)));
  const specificWhere = /\b(?:best site|which (?:site|location) (?:is |would be )?best)\b|địa điểm nào (?:oke|ok|ổn|tốt)|nơi nào (?:phù hợp|ổn|tốt)/.test(q);
  if (!(when || where && (mentionsDate || visiting || specificWhere) || visiting && mentionsDate || mentionsDate && /sun|earth|visibility|lunar|moon|mặt trời|trái đất|mặt trăng|thấy/.test(q) || followup)) return null;
  const namedObservation = !visiting && !where && !when && mentionsDate && !/\b(?:where|which|best site)\b|địa điểm|nơi nào/.test(q);
  const mode: PlanningMode = followup ? previous.mode : when ? "dates" : where ? "sites" : namedObservation ? "observation" : "sites";
  let from = followup ? previous.from : null, to = followup ? previous.to : null;
  const clock = /(?:T|\s)\d{1,2}:\d{2}|\b(?:am|pm)\b|giờ\s*\d+\s*phút/i.test(q);
  let dateProblem = followup ? previous.dateProblem : false;
  if (mentionsDate) {
    const explicitRange = /(?:\bfrom\b[^?]+\b(?:to|through|until)\b|từ[^?]+(?:đến|tới)|\d\s*[-–—]\s*\d\s+(?:tháng|[a-z]{3}))/u.test(q);
    dateProblem = clock || (explicitRange && dates.length !== 2) || dates.length < 1 || dates.length > 2 || !dates.every(validDay);
    from = dateProblem ? null : dates[0];
    to = !from ? null : dates[1] ?? new Date(Date.parse(from + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
    if (from && to && from >= to) { from = null; to = null; dateProblem = true; }
  }
  const sun = /sun(?:light)?|solar|mặt trời|ánh sáng|nắng/.test(q);
  const earth = /earth|radio|trái đất|liên lạc/.test(q);
  const missionHours = duration ? Number(duration[1]) * (/^(?:day|ngày)/.test(duration[2]) ? 24 : 1) : followup ? previous.missionHours : null;
  return { mode, from, to, dateProblem, missionHours, priority: sun || earth ? (sun && earth ? "joint" : sun ? "sun" : "earth") : followup ? previous.priority : "joint",
    siteText: followup ? [previous.siteText, question].join(" ").slice(-1000) : question };
}

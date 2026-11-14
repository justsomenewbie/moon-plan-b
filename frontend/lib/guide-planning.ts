// Keep UTC dates in the visitor's words. A language-model classification must never supply a missing year or a different window.
export type PlanningMode = "sites" | "dates" | "observation";
export type PlanningSite = { id: string; name: string };
export type PlanningIntent = {
  mode: PlanningMode; from: string | null; to: string | null; missionHours: number | null;
  priority: "joint" | "sun" | "earth"; siteText: string; dateProblem: boolean; continuesSiteChoice?: true; longestJoint?: true;
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

// Common mission lengths in either UI language. Other amounts can be entered as digits.
const numberWords: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, một: 1, hai: 2, ba: 3, bốn: 4, năm: 5,
  sáu: 6, bảy: 7, tám: 8, chín: 9, mười: 10 };
const amount = "[−-]?\\d+(?:[.,]\\d+)?|" + Object.keys(numberWords).join("|");
const durationPattern = new RegExp("(?<![\\p{L}\\d.,])(" + amount + ")\\s*[- ]?\\s*(hours?|hrs?|h|days?|weeks?|giờ|tiếng|ngày|tuần)(?![\\p{L}\\d])", "gu");

const durationRangePrefix = new RegExp("(?<![\\p{L}\\d])(?:" + amount + ")\\s+(?:to|or|hoặc|đến|tới)$"
  + "|(?:between|giữa)\\s+(?:" + amount + ")\\s+(?:and|và)$", "u");

const longest = /\blongest\b|(?:dài|lâu) nhất/iu;
const continuity = /\b(?:continuous(?:ly)?|uninterrupted|consecutive|unbroken|in a row|without (?:a |any )?(?:gaps?|interruptions?|breaks?))\b|liên (?:tục|tiếp)|không (?:bị )?(?:gián đoạn|ngắt quãng)/iu;
const longestInterval = /\blongest (?:[\w-]+ ){0,3}(?:window|interval|stretch|streak|overlap)\b|(?:khoảng|chuỗi) (?:chồng lấn|trùng nhau|quan sát đồng thời) (?:dài|lâu) nhất/iu;
const jointWindow = /\b(?:joint|simultaneous) (?:visibility|window|interval)|\b(?:visibility overlap|overlap (?:window|interval))\b|khoảng (?:chồng lấn|trùng nhau)|(?:nhìn|quan sát) thấy đồng thời/iu;
const separateObjectives = /\b(?:either|separately|individually|versus|vs\.?)\b|\b(?:sun(?:light)?|earth)\s+or\s+(?:the\s+)?(?:sun(?:light)?|earth)\b|(?:mặt trời|trái đất)\s+(?:hay|hoặc)\s+(?:mặt trời|trái đất)|riêng (?:biệt|lẻ)/iu;
const qualifications = /\b(?:at least|at most|without|except|least|fewest|shortest|minimum|exclude|not|battery|fuel|power)\b|ngoại trừ|ít nhất|ít hơn|ngắn hơn|tối thiểu|tối đa|không (?:có|gồm)|pin sống|nhiên liệu|công suất/i;

export function hasPlanningQualifications(text: string) {
  return qualifications.test(text) || continuity.test(text) || longestInterval.test(text);
}

export function planningIntent(question: string, previous?: PlanningIntent, siteChoices?: readonly PlanningSite[]): PlanningIntent | null {
  const q = question.trim().toLowerCase().normalize("NFC");
  const dates = calendarDays(q);
  const mentionsDate = dates.length > 0 || /\b20\d{2}\b|\d\s*\/\s*\d|tháng\s+\d|\b(?:today|tomorrow|next week)\b|ngày mai|hôm nay|tuần tới/.test(q)
    || new RegExp("\\b(?:" + monthPattern + ")\\b[^?!]{0,12}\\d|\\d[^?!]{0,12}\\b(?:" + monthPattern + ")\\b").test(q);
  const when = /\bwhen\b|best (?:date|time|window)|khi nào|lúc nào|bao giờ|thời điểm nào|ngày nào|thời gian nào/.test(q);
  const where = /\b(?:best site|best place|best destination)\b|\bwhere\b|\b(?:which|what) (?:lunar |landing )?(?:site|place|location|destination)s?\b|địa điểm nào|nơi nào|ở đâu|đi đâu|chỗ nào|điểm nào/.test(q);
  const visiting = /\b(go|visit|trip|travel|land|mission|choose|recommend)\b|muốn đi|muon di|nên đi|hạ cánh|ghé|lựa chọn|nên chọn|gợi ý/.test(q);
  const durations = [...q.matchAll(durationPattern)];
  const duration = durations[0];
  const miss = /an toàn|\bsafe(?:st|ty)?\b|\bfuel\b|\bradiation\b|nhiên liệu|bức xạ/.test(q);
  const informational = /\bwhen (?:was|were|did|is (?:the )?(?:sun|earth)|does (?:the )?(?:sun|earth))\b|\bwhen did\b|phóng (?:vào )?khi nào|hạ cánh vào năm nào/.test(q);
  const aboutSource = /\b(?:source|provenance|who computed|how was|where did)\b|nguồn|tính bằng cách nào/.test(q);
  const unrelated = /\b(weather|hotel|restaurant|flight to|football|ticket|disney|stock)\b|khách sạn|vé máy bay|thời tiết|nhà hàng/.test(q);
  if (miss || unrelated || informational || aboutSource || /[?;]\s*\S|\b(?:and|or)\s+(?:wh(?:at|ich|ere|en|y)|how|can|is|does)\b/.test(q) || /\b(?:switch|open)\b.{0,20}\b(?:mode|comparison)\b|chuyển sang/.test(q)) return null;
  const choiceReply = Boolean(previous && siteChoices?.length && !when && !where && !(visiting && mentionsDate));
  const choices = choiceReply && siteChoices ? matchSites(question, siteChoices) : [];
  const followup = previous && (choiceReply && (choices.length || q.split(/\s+/).length <= 5 && !q.includes("?")) ||
    !when && !where && !visiting && (mentionsDate || duration || (previous.mode !== "sites" && q.split(/\s+/).length <= 5 && !/[?]/.test(q))));
  const continuesSiteChoice = Boolean(followup && choiceReply);
  const specificWhere = /\b(?:best site|which (?:site|location) (?:is |would be )?best)\b|địa điểm nào (?:oke|ok|ổn|tốt)|nơi nào (?:phù hợp|ổn|tốt)/.test(q);
  const sun = /sun(?:light)?|solar|mặt trời|ánh sáng|nắng/.test(q);
  const earth = /earth|radio|trái đất|liên lạc/.test(q);
  const asksLongest = longest.test(q) && (continuity.test(q) || longestInterval.test(q));
  if (!(when || where && (mentionsDate || visiting || specificWhere || asksLongest && (sun || earth || jointWindow.test(q))) || visiting && mentionsDate || mentionsDate && /sun|earth|visibility|lunar|moon|mặt trời|trái đất|mặt trăng|thấy/.test(q) || followup)) return null;
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
  let missionHours = followup ? previous.missionHours : null;
  if (duration) {
    const unit = duration[2], count = numberWords[duration[1]] ?? Number(duration[1].replace(",", ".").replace("−", "-"));
    const multiplier = /^(week|tuần)/.test(unit) ? 168 : /^(day|ngày)/.test(unit) ? 24 : 1;
    // A range or compound duration needs clarification before the planner can score visits.
    const before = q.slice(0, duration.index).trimEnd();
    const ambiguous = durations.length > 1 || durationRangePrefix.test(before) || /(?:[\d\p{L}]\s*[-–—]$|(?:twenty|thirty|forty|fifty|mươi|mười)$)/u.test(before);
    missionHours = ambiguous ? 0 : count * multiplier;
  }
  let siteText = question;
  if (previous && continuesSiteChoice) {
    // A reply narrows the offered sites. Unknown names keep the existing choices.
    siteText = choices.length ? choices.map(site => site.id).join(" ") : previous.siteText;
    if (hasPlanningQualifications(question)) siteText += " " + question;
  } else if (followup) siteText = [previous.siteText, question].join(" ").slice(-1000);
  const priority = sun || earth ? (sun && earth ? "joint" : sun ? "sun" : "earth") : followup ? previous.priority : "joint";
  // An uninterrupted maximum is a different objective from a fixed visit or total hours.
  const asksJoint = where && asksLongest && (sun && earth || jointWindow.test(q));
  const keepsJoint = followup && previous.longestJoint && mentionsDate && !sun && !earth;
  const longestJoint = mode === "sites" && missionHours === null && priority === "joint" && (asksJoint || keepsJoint) &&
    !separateObjectives.test(siteText) && !qualifications.test(siteText.replace(/\bwithout (?:a |any )?(?:gaps?|interruptions?|breaks?)\b/gi, ""));
  return { mode, from, to, dateProblem, missionHours, priority, siteText,
    ...(longestJoint ? { longestJoint: true as const } : {}), ...(continuesSiteChoice ? { continuesSiteChoice: true as const } : {}) };
}

const normalize = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, " ").trim();
export function matchSites<S extends { id: string; name: string }>(text: string, sites: readonly S[]) {
  const query = " " + normalize(text) + " ";
  // Prefer a mission designation or exact site name over a shared term such as “Apollo” or “Nobile”.
  const exact = sites.map(site => {
    const title = normalize(site.name.split("(")[0].split(":").at(-1) ?? "");
    const designation = title.match(/^(?:apollo|im|chang e|chandrayaan) ?\d+/)?.[0];
    const matched = [normalize(site.id), title, designation].filter((p): p is string => Boolean(p && query.includes(" " + p + " ")));
    return { site, matched };
  }).filter(row => row.matched.length);
  if (exact.length) {
    // A longer catalog name can contain a shorter one, such as “Mons Mouton Plateau”.
    const longest = exact.filter(row => row.matched.some(p => !exact.some(other => other.site !== row.site &&
      other.matched.some(full => full.length > p.length && (" " + full + " ").includes(" " + p + " ")))));
    return longest.map(row => row.site);
  }
  return sites.filter(site => {
    const tokens = normalize(site.name.split("(")[0] + " " + site.id).split(" ");
    return tokens.some(token => token.length >= 4
      && !["region", "artemis", "site", "landing", "connecting", "crater", "point", "near", "peak", "plain", "plateau", "slope", "ridge", "mons"].includes(token)
      && query.includes(" " + token + " "));
  });
}

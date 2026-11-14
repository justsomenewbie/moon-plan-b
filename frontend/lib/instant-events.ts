import type { SiteInstant } from "./api/site-instant";
import type { Locale } from "./i18n";

export function instantEventText(locale: Locale, key: keyof SiteInstant["next_events"], instant: SiteInstant) {
  const vi = locale === "vi", event = instant.next_events[key];
  const label = {
    sunset: vi ? "Mặt Trời lặn" : "Sunset", sunrise: vi ? "Mặt Trời mọc" : "Sunrise",
    earthset: vi ? "Trái Đất lặn" : "Earthset", earthrise: vi ? "Trái Đất mọc" : "Earthrise",
  }[key];
  const fmt = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 6 });
  let text: string;
  if (!event) text = vi ? "Chưa có dữ liệu" : "Unavailable";
  else if (event.lower_bound) text = vi ? `Ít nhất ${fmt(event.hours)} giờ · chưa xảy ra trước khi dữ liệu kết thúc`
    : `At least ${fmt(event.hours)} h · no event before model coverage ends`;
  else if (event.hours === 0) text = event.state_now ? (vi ? "Đang nhìn thấy" : "Already visible") : (vi ? "Đang bị khuất" : "Already hidden");
  else text = vi ? `Còn ${fmt(event.hours)} giờ (±${fmt(instant.precision_h)} giờ)` : `In ${fmt(event.hours)} h (±${fmt(instant.precision_h)} h)`;
  return { label, text, at: event && event.hours > 0 ? event.at : null };
}

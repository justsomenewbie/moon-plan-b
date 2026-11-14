// The source links live outside the form; serialize its current entries for ordinary links,
// keyboard activation and opening in a new tab.
export type PlannerSource = "live" | "saved" | "saved-b2";
const extraDefaults = { minBothPct: "0", minSunPct: "0", minEarthPct: "0", maxDarkGap: "", maxEarthGap: "", separationHours: "12", maxResults: "5" } as const;
export type ExtraField = keyof typeof extraDefaults;
const hour = 3600000;
const day = 24 * hour;
const text = (form: FormData, name: string) => String(form.get(name) ?? "");

export function liveExtras(seed: URLSearchParams) {
  const extras: Partial<Record<ExtraField, string>> = {};
  for (const [key, fallback] of Object.entries(extraDefaults)) {
    const raw = seed.get(key);
    if (!raw || raw.length > 16 || !/^\d+(\.\d+)?$/.test(raw)) continue;
    if (fallback === "" || Number(raw) !== Number(fallback)) extras[key as ExtraField] = raw;
  }
  return extras;
}

export function hasLiveOptions(seed: URLSearchParams) {
  return Object.keys(liveExtras(seed)).length > 0 || seed.get("sunAtLanding") === "1" || seed.get("earthAtLanding") === "1"
    || ["earliest", "balanced"].includes(seed.get("liveObjective") ?? "");
}

function utcClock(raw: string | null) {
  if (!raw || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(raw)) return undefined;
  const full = raw.length === 16 ? raw + ":00" : raw;
  const ms = Date.parse(full + "Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === full ? full : undefined;
}

export function landingClock(seed: URLSearchParams, name: "earliest" | "latest") {
  return utcClock(seed.get(name));
}

// Keep the entered bounds in the form and link, but evaluate only hourly starts inside them.
export function savedLandingHour(raw: string, edge: "earliest" | "latest") {
  if (!raw) return "";
  const utc = utcClock(raw);
  if (!utc) return raw;
  const round = edge === "earliest" ? Math.ceil : Math.floor;
  return new Date(round(Date.parse(utc + "Z") / hour) * hour).toISOString().slice(0, 19);
}

export function plannerFormState(seed: URLSearchParams, mode: string, source: PlannerSource, form: FormData) {
  const p = new URLSearchParams(seed);
  const set = (key: string, value: string) => { if (value) p.set(key, value); else p.delete(key); };
  p.set("mode", mode);
  if (mode === "sites") {
    for (const name of ["from", "to", "priority"]) set(name, text(form, name));
    return p;
  }
  if (source === "live") {
    const hours = text(form, "missionHours");
    const objective = text(form, "objective");
    set("site", text(form, "landingSite"));
    set("missionHours", hours);
    set("earliest", text(form, "earliest"));
    set("latest", text(form, "latest"));
    const first = landingClock(p, "earliest"), latest = landingClock(p, "latest");
    if (first) p.set("from", first.slice(0, 10));
    if (latest && Number(hours) > 0) {
      // The saved archive accepts a travel date end (exclusive) plus exact inclusive start limits.
      const finish = Math.ceil((Date.parse(latest + "Z") + Number(hours) * hour) / day) * day;
      if (Number.isFinite(finish) && Math.abs(finish) <= 8640000000000000) p.set("to", new Date(finish).toISOString().slice(0, 10));
    }
    set("priority", objective === "earth" || objective === "sun" ? objective : "joint");
    set("liveObjective", objective === "earliest" || objective === "balanced" ? objective : "");
    for (const [key, fallback] of Object.entries(extraDefaults)) {
      const v = text(form, key);
      set(key, v && (fallback === "" || Number(v) !== Number(fallback)) ? v : "");
    }
    for (const key of ["sunAtLanding", "earthAtLanding"]) set(key, form.has(key) ? "1" : "");
  } else {
    const savedFields = {
      savedLandingSite: "site", savedFrom: "from", savedTo: "to", savedEarliest: "earliest",
      savedLatest: "latest", savedDuration: "missionHours", savedPriority: "priority",
    };
    for (const [name, key] of Object.entries(savedFields)) {
      const v = text(form, name);
      if (key === "priority" && v !== (p.get("priority") ?? "joint")) p.delete("liveObjective");
      set(key, v);
    }
  }
  return p;
}

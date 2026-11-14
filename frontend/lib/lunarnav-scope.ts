// Route and field scope shared by the server relay and its public API explorer.
const prefix = "/api/v1/";
const id = "[A-Za-z0-9_:.-]{1,64}";
const reads: [RegExp, string[]][] = [
  [/^dataset$/, ["run_id", "site_ids", "start", "end", "step_s", "max_points", "horizon_step_deg", "criteria_hours", "include"]],
  [/^sites$/, ["run_id", "format"]],
  [new RegExp("^sites/" + id + "$"), ["run_id"]],
  [new RegExp("^sites/" + id + "/instant$"), ["run_id", "t"]],
  [new RegExp("^sites/" + id + "/export/series\\.csv$"), ["run_id", "start", "end", "fields"]],
  [new RegExp("^sites/" + id + "/export/windows\\.csv$"), ["run_id", "start", "end", "kinds"]],
  [/^ranking$/, ["run_id", "start", "end", "weights"]],
  [/^runs$/, ["limit"]],
  [new RegExp("^runs/" + id + "$"), []],
  [/^export\/summary\.csv$/, ["run_id"]],
];
const postFields = {
  compare: ["run_id", "site_ids", "start", "end", "weights", "include"],
  "alt-dates": ["run_id", "site_id", "earliest", "latest", "mission_h", "max_results", "constraints"],
};

export function publicRoute(pathname: string, method: string) {
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname.slice(prefix.length).split("/");
  // Decode identifiers once, and allow nested paths only in the producer's manifest-file parameter.
  const decoded = segments.map(s => decodeURIComponent(s));
  const safe = (s: string) => /^[A-Za-z0-9_.:-]+$/.test(s) && s !== "." && s !== "..";
  if (method === "GET" && decoded[0] === "runs" && decoded[2] === "files" &&
      decoded.length >= 4 && safe(decoded[1]) && decoded[1].length <= 64) {
    const file = decoded.slice(3).join("/");
    if (file.length <= 512 && file.split("/").every(safe))
      return { path: "runs/" + encodeURIComponent(decoded[1]) + "/files/" + encodeURIComponent(file), query: [], body: undefined };
    return null;
  }
  if (!decoded.every(safe)) return null;
  const path = decoded.join("/");
  if (method === "POST" && (path === "compare" || path === "alt-dates")) return { path, query: [], body: postFields[path] };
  const read = method === "GET" && reads.find(([pattern]) => pattern.test(path));
  return read ? { path: decoded.map(encodeURIComponent).join("/"), query: read[1], body: undefined } : null;
}

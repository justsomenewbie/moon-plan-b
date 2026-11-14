import { answerGuide, BodyLimitError, classifyGuide, parseGuideRequest, readBoundedJson } from "../../../lib/guide-chat.ts";

export const runtime = "nodejs";
let inFlight = 0;
let recentRequests: number[] = [];

function reply(body: { error: string } | ReturnType<typeof answerGuide>, status: number, retry?: string) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...(retry ? { "retry-after": retry } : {}) } });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  let client: URL;
  try { client = new URL(origin ?? ""); } catch { return reply({ error: "Same-origin request required." }, 403); }
  // A fixed origin is needed off loopback, including to prevent a re-bound hostname from borrowing a local model.
  const trusted = process.env.ASTRONAUT_CHAT_ORIGIN || (["localhost", "127.0.0.1", "[::1]"].includes(client.hostname) ? client.origin : "");
  if (origin !== trusted || !["http:", "https:"].includes(client.protocol) ||
      (request.headers.get("host") ?? new URL(request.url).host) !== client.host ||
      request.headers.get("sec-fetch-site") === "cross-site") return reply({ error: "Same-origin request required." }, 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return reply({ error: "Send a JSON question." }, 415);

  const now = Date.now();
  recentRequests = recentRequests.filter(time => now - time < 60_000);
  if (inFlight >= 2 || recentRequests.length >= 12) return reply({ error: "Guide is busy. Try again shortly." }, 429, inFlight >= 2 ? "3" : String(Math.ceil((60_000 - (now - recentRequests[0])) / 1000)));

  inFlight++;
  try {
    let input;
    const bodySignal = AbortSignal.any([request.signal, AbortSignal.timeout(8000)]);
    try {
      input = parseGuideRequest(await readBoundedJson(request, 16 * 1024, bodySignal));
    } catch (error) {
      if (bodySignal.aborted) return reply({ error: "Question timed out." }, 408);
      if (error instanceof BodyLimitError) return reply({ error: "Question payload is too large." }, 413);
      return reply({ error: "Invalid question or comparison rows." }, 400);
    }
    recentRequests.push(now);
    const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
    try {
      const plan = await classifyGuide(input, deadline);
      return reply(answerGuide(input, plan), 200);
    } catch {
      return deadline.aborted
        ? reply({ error: "The guide did not respond in time." }, 504)
        : reply({ error: "The guide is unavailable." }, 503);
    }
  } finally { inFlight--; }
}

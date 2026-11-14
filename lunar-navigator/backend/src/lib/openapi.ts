/**
 * Post-processing of the generated OpenAPI document (wired in app.ts as swagger `transformObject`).
 *
 * fastify-type-provider-zod emits every registered schema twice (`X` for responses, `XInput` for
 * requests). For the FE that is noise, so we:
 *   1. drop component schemas not reachable from any path;
 *   2. rename `XInput` -> `X` when only the input variant is used (request bodies such as CompareRequest).
 * Schemas genuinely used on both sides (e.g. RankWeights / RankWeightsInput) keep both names.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

const REF_PREFIX = '#/components/schemas/';

function collectRefs(node: Json, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectRefs(n, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string' && v.startsWith(REF_PREFIX)) out.add(v.slice(REF_PREFIX.length));
    else collectRefs(v, out);
  }
}

function rewriteRefs(node: Json, rename: Map<string, string>): Json {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, rename));
  if (node === null || typeof node !== 'object') return node;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string' && v.startsWith(REF_PREFIX)) {
      const name = v.slice(REF_PREFIX.length);
      out[k] = REF_PREFIX + (rename.get(name) ?? name);
    } else {
      out[k] = rewriteRefs(v, rename);
    }
  }
  return out;
}

export function pruneComponents<T extends object>(doc: T): T {
  const d = JSON.parse(JSON.stringify(doc)) as JsonObject;
  const components = (d['components'] ?? {}) as JsonObject;
  const schemas = (components['schemas'] ?? {}) as JsonObject;

  // 1. reachability from paths, transitively through components
  const reachable = new Set<string>();
  collectRefs(d['paths'] ?? {}, reachable);
  const queue = [...reachable];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined) break;
    const found = new Set<string>();
    collectRefs(schemas[name] ?? null, found);
    for (const f of found) {
      if (!reachable.has(f)) {
        reachable.add(f);
        queue.push(f);
      }
    }
  }

  // 2. XInput -> X when X itself is unused
  const rename = new Map<string, string>();
  for (const name of reachable) {
    if (name.endsWith('Input')) {
      const base = name.slice(0, -'Input'.length);
      if (!reachable.has(base)) rename.set(name, base);
    }
  }

  const kept: JsonObject = {};
  for (const name of [...reachable].sort()) {
    const schema = schemas[name];
    if (schema !== undefined) kept[rename.get(name) ?? name] = rewriteRefs(schema, rename);
  }
  const sorted: JsonObject = {};
  for (const k of Object.keys(kept).sort()) sorted[k] = kept[k] ?? null;

  d['paths'] = rewriteRefs(d['paths'] ?? {}, rename);
  d['components'] = { ...components, schemas: sorted };
  return d as T;
}

// ---- response examples on the media type ---------------------------------------------------------
// The zod type provider keeps only `schema` of a response `content` entry, so an example that differs
// from the component's own example (e.g. the 200 "cache hit" of createJob vs its 202) is registered here
// and written onto `paths.<path>.<method>.responses.<status>.content.<media>.example` afterwards.
interface ResponseExample {
  operationId: string;
  status: number;
  mediaType: string;
  example: unknown;
}
const responseExamples: ResponseExample[] = [];

/** Register an example for one response of an operation (route modules call this at load time). */
export function registerResponseExample(operationId: string, status: number, example: unknown, mediaType = 'application/json'): void {
  if (!responseExamples.some((e) => e.operationId === operationId && e.status === status && e.mediaType === mediaType)) {
    responseExamples.push({ operationId, status, mediaType, example });
  }
}

const isObj = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Apply the registered examples (mutates and returns `doc`). */
export function applyResponseExamples<T extends object>(doc: T): T {
  const paths = (doc as { paths?: Json }).paths;
  if (!isObj(paths)) return doc;
  for (const item of Object.values(paths)) {
    if (!isObj(item)) continue;
    for (const op of Object.values(item)) {
      if (!isObj(op)) continue;
      for (const ex of responseExamples) {
        if (op['operationId'] !== ex.operationId) continue;
        const responses = op['responses'];
        const res = isObj(responses) ? responses[String(ex.status)] : undefined;
        const content = isObj(res) ? res['content'] : undefined;
        const media = isObj(content) ? content[ex.mediaType] : undefined;
        if (isObj(media)) media['example'] = JSON.parse(JSON.stringify(ex.example)) as Json;
      }
    }
  }
  return doc;
}

// ---- security: 401 on every protected operation ------------------------------------------------------
/**
 * Add the 401 UNAUTHORIZED problem response to every operation that does not opt out of the global
 * security requirement (`security: []`, e.g. GET /health), so FE types know it. Mutates and returns `doc`.
 * The 401 entry is inserted before the first status above 401 (keeps the numeric order of the others).
 */
export function applySecurityResponses<T extends object>(doc: T, description: string, mediaType: string): T {
  const paths = (doc as { paths?: Json }).paths;
  if (!isObj(paths)) return doc;
  const response: JsonObject = {
    description,
    headers: {
      'WWW-Authenticate': { description: 'ApiKey header="X-API-Key"', schema: { type: 'string' } },
    },
    content: { [mediaType]: { schema: { $ref: `${REF_PREFIX}Problem` } } },
  };
  for (const item of Object.values(paths)) {
    if (!isObj(item)) continue;
    for (const op of Object.values(item)) {
      if (!isObj(op)) continue;
      const security = op['security'];
      if (Array.isArray(security) && security.length === 0) continue;
      const responses = op['responses'];
      if (!isObj(responses) || responses['401'] !== undefined) continue;
      const ordered: JsonObject = {};
      let added = false;
      for (const [status, r] of Object.entries(responses)) {
        if (!added && /^\d{3}$/.test(status) && Number(status) > 401) {
          ordered['401'] = JSON.parse(JSON.stringify(response)) as Json;
          added = true;
        }
        ordered[status] = r;
      }
      if (!added) ordered['401'] = JSON.parse(JSON.stringify(response)) as Json;
      op['responses'] = ordered;
    }
  }
  return doc;
}

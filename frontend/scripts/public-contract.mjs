import { publicRoute } from '../lib/lunarnav-scope.ts';

// Pin the examples so they remain reproducible if the producer switches its default run.
const runId = 'B2_spice_pgda_bruteforce_2026_2030_fix676af9d';
const sites = ['im1_odysseus', 'im2_athena'];
const start = '2026-11-14T00:00:00Z';
const end = '2026-11-21T00:00:00Z';
const parameterExamples = {
  run_id: runId, site_id: sites[0], site_ids: sites.join(','), start, end,
  t: start, max_points: 168, file_path: 'sites/im1_odysseus/horizon_bruteforce.csv',
};
const bodyExamples = {
  CompareRequest: { run_id: runId, site_ids: sites, start, end, include: { windows: ['both'] } },
  AltDatesRequest: {
    run_id: runId, site_id: sites[1], earliest: start, latest: '2026-11-20T00:00:00Z',
    mission_h: 24, max_results: 3, constraints: { objective: 'both' },
  },
};

function publicParameter(parameter) {
  if (!Object.hasOwn(parameterExamples, parameter.name)) return parameter;
  const exposed = { ...parameter, example: parameterExamples[parameter.name] };
  if (parameter.in === 'path' && parameter.name === 'run_id')
    exposed.description = 'Use a run ID returned by GET /api/v1/runs. The example selects a pinned B2 run.';
  if (parameter.name === 'file_path')
    exposed.description = 'Paste manifest.json or a relative path from the run manifest. Enter literal slashes in Swagger UI. When constructing a URL yourself, encode this path parameter once.';
  return exposed;
}

// Keep producer problem bodies alongside the relay's own JSON response for a shared status.
function addRelayErrors(responses, post) {
  const messages = {
    400: 'The relay rejected the path, query parameters or JSON body.',
    502: 'The relay could not obtain an authorized data response from the team service.',
    503: 'The production data service is not configured on this relay.',
    ...(post && { 403: 'The relay requires a same-origin request.', 408: 'The incoming JSON upload timed out.',
      413: 'The incoming JSON exceeds 16 KiB.', 415: 'The relay requires application/json.' }),
  };
  for (const [status, description] of Object.entries(messages)) {
    const prior = responses[status];
    responses[status] = { ...prior, description: [prior?.description, description].filter(Boolean).join(' '),
      content: { ...prior?.content, 'application/json': { schema: { type: 'object', required: ['status', 'detail'],
        properties: { status: { type: 'integer', const: Number(status) }, detail: { type: 'string' } } } } } };
  }
  const priorTimeout = responses['504'];
  const timeoutType = 'application/problem+json';
  const producerTimeout = priorTimeout?.content?.[timeoutType]?.schema;
  const relayTimeout = { $ref: '#/components/schemas/RelayTimeout' };
  responses['504'] = { ...priorTimeout, description: [priorTimeout?.description, 'The relay waited 180 seconds for upstream headers.'].filter(Boolean).join(' '),
    content: { ...priorTimeout?.content, [timeoutType]: { schema: producerTimeout ? { anyOf: [producerTimeout, relayTimeout] } : relayTimeout } } };
  responses['429'] = { ...responses['429'], headers: { ...responses['429']?.headers,
    'Retry-After': { description: 'Wait until this time or for this many seconds before manually retrying.', schema: { type: 'string' } } } };
}

export function publicContract(producer) {
  const paths = {};
  const schemas = { ...producer.components.schemas, RelayTimeout: {
    type: 'object', required: ['type', 'title', 'status', 'code', 'detail'],
    properties: { type: { const: 'about:blank' }, title: { const: 'Upstream timeout' }, status: { const: 504 },
      code: { const: 'UPSTREAM_TIMEOUT' }, detail: { type: 'string' } },
  } };
  for (const [path, methods] of Object.entries(producer.paths)) {
    const example = path.replaceAll(/\{[^}]+\}/g, 'example');
    for (const [method, operation] of Object.entries(methods)) {
      const match = publicRoute(example, method.toUpperCase());
      if (!match) continue;
      const exposed = { ...operation, responses: { ...operation.responses } };
      // Authentication is between the server relay and the producer. Its 401 challenge never reaches the browser.
      delete exposed.security;
      delete exposed.responses['401'];
      addRelayErrors(exposed.responses, Boolean(match.body));
      if (operation.parameters) {
        exposed.parameters = operation.parameters.filter(p => p.in === 'path' || (p.in === 'query' && match.query.includes(p.name))).map(publicParameter);
      }
      if (match.body) {
        const name = operation.requestBody.content['application/json'].schema.$ref.split('/').at(-1);
        const schema = schemas[name];
        const properties = Object.fromEntries(Object.entries(schema.properties).filter(([field]) => match.body.includes(field)));
        properties.run_id = { ...properties.run_id, examples: [runId], description: 'Run ID from GET /api/v1/runs. Omit it to use the default run.' };
        schemas[name] = { ...schema, properties, required: schema.required.filter(field => match.body.includes(field)), additionalProperties: false, examples: [bodyExamples[name]] };
      }
      (paths[path] ??= {})[method] = exposed;
    }
  }
  paths['/api/v1/ranking'].get.description = 'The full run with its default weights uses the source summary. Other rankings use computed scores, with ties ordered by shorter longest_dark_h, then site_id.';

  const siteExports = paths['/api/v1/sites/{site_id}/export/series.csv'].get;
  siteExports.description = 'One row per native sample of the snapped UTC range. The download name includes the site, run, requested UTC bounds, and a hash of the fields when specified.';
  const windows = paths['/api/v1/sites/{site_id}/export/windows.csv'].get;
  windows.description = 'Windows are clipped to the range, grouped by kind and sorted by start. The download name includes the site, run, requested UTC bounds, and a hash of the kinds when specified.';

  const original = paths['/api/v1/runs/{run_id}/files/{file_path}'].get;
  original.description = 'Download a file listed in the run manifest. Swagger UI encodes the file path for you. The relay keeps the original bytes and SHA-256 ETag. The local download name identifies the run and file path.';

  // Swagger also displays component schemas. Keep the request/response models reached by these operations.
  const used = new Set();
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      const name = value.$ref.split('/').at(-1);
      if (!used.has(name)) {
        used.add(name);
        collect(schemas[name]);
      }
    }
    Object.values(value).forEach(collect);
  }
  collect(paths);
  return { openapi: producer.openapi, info: producer.info, security: [], paths, components: { schemas: Object.fromEntries([...used].map(name => [name, schemas[name]])) } };
}

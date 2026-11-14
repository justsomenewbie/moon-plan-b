import { publicRoute } from '../lib/lunarnav-scope.ts';

export function publicContract(producer) {
  const paths = {};
  const schemas = { ...producer.components.schemas };
  for (const [path, methods] of Object.entries(producer.paths)) {
    const example = path.replaceAll(/\{[^}]+\}/g, 'example');
    for (const [method, operation] of Object.entries(methods)) {
      const match = publicRoute(example, method.toUpperCase());
      if (!match) continue;
      const exposed = { ...operation, responses: { ...operation.responses } };
      // Authentication is between the server relay and the producer. Its 401 challenge never reaches the browser.
      delete exposed.security;
      delete exposed.responses['401'];
      exposed.responses['502'] = {
        description: 'The relay could not obtain an authorized data response from the team service.',
        content: { 'application/json': { schema: { type: 'object', required: ['status', 'detail'],
          properties: { status: { const: 502, type: 'integer' }, detail: { type: 'string' } } } } },
      };
      if (operation.parameters) {
        exposed.parameters = operation.parameters.filter(p => p.in === 'path' || (p.in === 'query' && match.query.includes(p.name)));
      }
      if (match.body) {
        const name = operation.requestBody.content['application/json'].schema.$ref.split('/').at(-1);
        const schema = schemas[name];
        const properties = Object.fromEntries(Object.entries(schema.properties).filter(([field]) => match.body.includes(field)));
        schemas[name] = { ...schema, properties, required: schema.required.filter(field => match.body.includes(field)), additionalProperties: false };
      }
      (paths[path] ??= {})[method] = exposed;
    }
  }
  paths['/api/v1/runs'].get.description = 'Default run first, then most recently imported first. Use limit to choose the maximum number of results.';
  paths['/api/v1/ranking'].get.description = 'The full run with its default weights uses the source summary. Other rankings use computed scores, with ties ordered by shorter longest_dark_h, then site_id.';

  const siteExports = paths['/api/v1/sites/{site_id}/export/series.csv'].get;
  siteExports.description = 'One row per native sample of the snapped UTC range. The download name includes the site, run, requested UTC bounds, and a hash of the fields when specified.';
  const windows = paths['/api/v1/sites/{site_id}/export/windows.csv'].get;
  windows.description = 'Windows are clipped to the range, grouped by kind and sorted by start. The download name includes the site, run, requested UTC bounds, and a hash of the kinds when specified.';

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

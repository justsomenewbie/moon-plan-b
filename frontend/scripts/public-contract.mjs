import { publicRoute } from '../lib/lunarnav-scope.ts';

export function publicContract(producer) {
  const paths = {};
  const schemas = { ...producer.components.schemas };
  for (const [path, methods] of Object.entries(producer.paths)) {
    const example = path.replaceAll(/\{[^}]+\}/g, 'example');
    for (const [method, operation] of Object.entries(methods)) {
      const match = publicRoute(example, method.toUpperCase());
      if (!match) continue;
      const exposed = { ...operation };
      if (operation.parameters) {
        exposed.parameters = operation.parameters.filter(p => p.in === 'path' || match.query.includes(p.name));
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
  return { ...producer, paths, components: { schemas: Object.fromEntries([...used].map(name => [name, schemas[name]])) } };
}

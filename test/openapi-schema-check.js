/**
 * Prueft einen Wert gegen ein Schema der OpenAPI-Spec. Bewusst klein und ohne
 * Fremdpaket: es kann, was `server/openapi` benutzt, und meldet jede Abweichung
 * mit ihrem Pfad.
 *
 * STRENG IN EINER RICHTUNG. Ein Feld in der Antwort, das das Schema nicht nennt,
 * ist ein Fehler, sofern das Schema `properties` hat und keine
 * `additionalProperties`: Sonst fehlt es im erzeugten Modell, und niemand merkt es.
 * Was ein Client bewusst nicht liest, nennt der Aufrufer in `ignore`.
 *
 * `format: date-time` HEISST HIER, WAS SWIFT LIEST: Sekunden und eine Zone, keine
 * Sekundenbruchteile. Der Standard-Decoder (`.iso8601`) scheitert an allem anderen,
 * und mit ihm die ganze Antwort. Ein Wert mit Millisekunden oder ohne Zone gehoert
 * also in ein Feld ohne `format`.
 */

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  return typeof value === type;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

function formatProblem(format, value) {
  if (typeof value !== 'string') return null;
  if (format === 'date-time' && !DATE_TIME.test(value)) return 'kein date-time, das Swift liest';
  if (format === 'date') {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== value) return 'kein date';
  }
  return null;
}

/** Fasst `allOf` samt Enkeln und Feldern daneben zu einem Objekt zusammen. */
function mergedAllOf(node, resolve) {
  const merged = { type: 'object', required: [...(node.required ?? [])], properties: { ...node.properties } };
  for (const part of node.allOf.map(resolve)) {
    const flat = part.allOf ? mergedAllOf(part, resolve) : part;
    Object.assign(merged.properties, flat.properties);
    merged.required.push(...(flat.required ?? []));
  }
  return merged;
}

export function schemaProblems(spec, schema, value, path = '$', { ignore = [] } = {}) {
  const resolve = (node) => {
    let current = node;
    while (current?.$ref) {
      current = current.$ref.replace(/^#\//, '').split('/').reduce((at, key) => at?.[key], spec);
    }
    return current;
  };
  const check = (raw, current, at) => {
    const node = resolve(raw);
    if (!node) return [`${at}: Schema-Ziel fehlt`];
    if (ignore.includes(at)) return [];
    if (node.allOf) return check(mergedAllOf(node, resolve), current, at);
    for (const key of ['oneOf', 'anyOf']) {
      if (node[key]) {
        const outcomes = node[key].map((part) => check(part, current, at));
        const hits = outcomes.filter((problems) => problems.length === 0).length;
        if (hits === 1 || (key === 'anyOf' && hits > 1)) return [];
        if (hits > 1) return [`${at}: ${hits} oneOf-Zweige passen, ein Generator nimmt blind den ersten`];
        return [`${at}: passt zu keinem ${key}-Zweig (${outcomes.flat().slice(0, 3).join('; ')})`];
      }
    }
    const types = [node.type].flat().filter(Boolean);
    if (types.length && !types.some((type) => matchesType(current, type))) {
      return [`${at}: erwartet ${types.join('|')}, bekam ${current === null ? 'null' : typeof current} ${JSON.stringify(current)?.slice(0, 60)}`];
    }
    if (node.enum && !node.enum.includes(current)) return [`${at}: ${JSON.stringify(current)} nicht im enum`];
    if ('const' in node && node.const !== current) return [`${at}: ${JSON.stringify(current)} ist nicht ${node.const}`];
    const badFormat = formatProblem(node.format, current);
    if (badFormat) return [`${at}: ${badFormat}: ${JSON.stringify(current)}`];
    if (node.pattern && typeof current === 'string' && !new RegExp(node.pattern).test(current)) {
      return [`${at}: ${JSON.stringify(current)} passt nicht zu ${node.pattern}`];
    }
    if (Array.isArray(current)) {
      return node.items ? current.flatMap((item, i) => check(node.items, item, `${at}[${i}]`)) : [];
    }
    if (current === null || typeof current !== 'object') return [];

    const problems = [];
    const properties = node.properties ?? {};
    for (const name of node.required ?? []) {
      if (!(name in current)) problems.push(`${at}.${name}: Pflichtfeld fehlt`);
    }
    const extra = node.additionalProperties;
    for (const [name, item] of Object.entries(current)) {
      const child = `${at}.${name}`;
      if (properties[name]) problems.push(...check(properties[name], item, child));
      else if (extra && typeof extra === 'object') problems.push(...check(extra, item, child));
      else if (node.properties && extra !== true && !ignore.includes(child)) problems.push(`${child}: nicht im Schema`);
    }
    return problems;
  };
  return check(schema, value, path);
}

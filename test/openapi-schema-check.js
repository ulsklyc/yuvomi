/**
 * Prueft einen Wert gegen ein Schema der OpenAPI-Spec. Bewusst klein und ohne
 * Fremdpaket: es kann, was `server/openapi` benutzt, und meldet jede Abweichung
 * mit ihrem Pfad.
 *
 * STRENG IN EINER RICHTUNG. Ein Feld in der Antwort, das das Schema nicht nennt,
 * ist ein Fehler, sofern das Schema `properties` hat und keine
 * `additionalProperties`: Sonst fehlt es im erzeugten Modell, und niemand merkt es.
 * Was ein Client bewusst nicht liest, nennt der Aufrufer in `ignore`.
 */

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  return typeof value === type;
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
    if (node.allOf) {
      // Felder, die erst die Summe der Teile nennt, darf kein Teil allein ablehnen.
      const merged = { type: 'object', required: [], properties: {} };
      for (const part of node.allOf.map(resolve)) {
        Object.assign(merged.properties, part.properties);
        merged.required.push(...(part.required ?? []));
      }
      return check({ ...merged, ...(node.nullable ? { nullable: true } : {}) }, current, at);
    }
    for (const key of ['oneOf', 'anyOf']) {
      if (node[key]) {
        const outcomes = node[key].map((part) => check(part, current, at));
        if (outcomes.some((problems) => problems.length === 0)) return [];
        return [`${at}: passt zu keinem ${key}-Zweig (${outcomes.flat().slice(0, 3).join('; ')})`];
      }
    }
    if (current === null && node.nullable) return [];
    const types = [node.type].flat().filter(Boolean);
    if (types.length && !types.some((type) => matchesType(current, type))) {
      return [`${at}: erwartet ${types.join('|')}, bekam ${current === null ? 'null' : typeof current} ${JSON.stringify(current)?.slice(0, 60)}`];
    }
    if (node.enum && !node.enum.includes(current)) return [`${at}: ${JSON.stringify(current)} nicht im enum`];
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

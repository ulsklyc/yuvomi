/**
 * Paperless saved-view rules -> document API filters.
 * Rule IDs are Paperless's persisted API contract (documents/models.py).
 * Unknown rules fail closed: dropping one could disclose an entire archive.
 * Reference: paperless-ngx src-ui/src/app/data/filter-rule-type.ts (MIT).
 */
export class PaperlessViewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaperlessViewError';
  }
}

// [query parameter, multiple values, null parameter, boolean value]
const RULES = new Map([
  [0, ['title__icontains']], [1, ['content__icontains']],
  [2, ['archive_serial_number']],
  [3, ['correspondent__id', false, 'correspondent__isnull']],
  [4, ['document_type__id', false, 'document_type__isnull']],
  [5, ['is_in_inbox', false, null, true]],
  [6, ['tags__id__all', true]], [7, ['is_tagged', false, null, true]],
  [8, ['created__date__lt']], [9, ['created__date__gt']],
  [10, ['created__year']], [11, ['created__month']], [12, ['created__day']],
  [13, ['added__date__lt']], [14, ['added__date__gt']],
  [15, ['modified__date__lt']], [16, ['modified__date__gt']],
  [17, ['tags__id__none', true]], [18, ['archive_serial_number__isnull', false, null, true]],
  [19, ['title_content']], [20, ['query']], [21, ['more_like_id']],
  [22, ['tags__id__in', true]],
  [23, ['archive_serial_number__gt']], [24, ['archive_serial_number__lt']],
  [25, ['storage_path__id', false, 'storage_path__isnull']],
  [26, ['correspondent__id__in', true]], [27, ['correspondent__id__none', true]],
  [28, ['document_type__id__in', true]], [29, ['document_type__id__none', true]],
  [30, ['storage_path__id__in', true]], [31, ['storage_path__id__none', true]],
  [32, ['owner__id']], [33, ['owner__id__in', true]],
  [34, ['owner__isnull', false, null, true]], [35, ['owner__id__none', true]],
  [36, ['custom_fields__icontains']], [37, ['shared_by__id', true]],
  [38, ['custom_fields__id__all', true]], [39, ['custom_fields__id__in', true]],
  [40, ['custom_fields__id__none', true]], [41, ['has_custom_fields', false, null, true]],
  [42, ['custom_field_query']],
  [43, ['created__date__lte']], [44, ['created__date__gte']],
  [45, ['added__date__lte']], [46, ['added__date__gte']],
  [47, ['mime_type']], [48, ['title_search']], [49, ['text']],
  [50, ['has_duplicates', false, null, true]],
]);

export function savedViewParams(view) {
  if (!view || !Array.isArray(view.filter_rules) || view.filter_rules.length > 200) {
    throw new PaperlessViewError('Invalid saved-view filter definition.');
  }
  const params = new URLSearchParams();
  for (const rule of view.filter_rules) {
    const def = RULES.get(rule?.rule_type);
    if (!def) throw new PaperlessViewError('Unsupported saved-view filter.');
    let [key, multi, nullKey, boolean] = def;
    let value = rule.value;
    if (nullKey && (value === null || String(value) === '-1')) {
      key = nullKey;
      value = value === null ? '1' : '0';
    } else {
      if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 10000) {
        throw new PaperlessViewError('Invalid saved-view filter value.');
      }
      if (boolean) {
        if (![true, false, 1, 0, 'true', 'false', '1', '0'].includes(value)) {
          throw new PaperlessViewError('Invalid saved-view boolean.');
        }
        value = [true, 1, 'true', '1'].includes(value) ? '1' : '0';
      }
    }
    value = String(value);
    // Paperless's own client combines multi-value rules with commas. Keep
    // singleton collisions explicit instead of silently overwriting a rule.
    if (params.has(key) && !multi && params.get(key) !== value) {
      throw new PaperlessViewError('Conflicting saved-view filters.');
    }
    params.set(key, multi && params.has(key) ? `${params.get(key)},${value}` : value);
  }
  const sort = view.sort_field || 'created';
  if (typeof sort !== 'string' || !/^[a-z][a-z0-9_]{0,80}$/.test(sort)) {
    throw new PaperlessViewError('Unsupported saved-view ordering.');
  }
  params.set('ordering', `${view.sort_reverse ? '-' : ''}${sort}`);
  return params;
}

export function positiveId(value) {
  const text = String(value ?? '');
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}

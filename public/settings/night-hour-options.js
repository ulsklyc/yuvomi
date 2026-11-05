/** Whole-hour choices for both device-local and administrator-managed night windows. */
import { formatTime } from '/i18n.js';
import { esc } from '/utils/html.js';

export function nightHourOptions(selected, other) {
  return Array.from({ length: 24 }, (_, hour) => `
    <option value="${hour}"${hour === selected ? ' selected' : ''}${hour === other ? ' disabled' : ''}>${esc(formatTime(`${String(hour).padStart(2, '0')}:00`))}</option>`).join('');
}

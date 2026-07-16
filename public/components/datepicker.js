/**
 * Modul: yuvomi-datepicker Web Component
 * Zweck: Gemeinsame Datum-/Zeit-Eingabe für die ganze App. Tippen bleibt der
 *        schnelle Pfad (locale-Parsing wie bisher, #442); ein Icon-Trigger
 *        öffnet auf Desktop ein Glass-Popover (Kalender-Grid / Zeit-Liste),
 *        auf Touch das native OS-Sheet (showPicker()).
 * Abhängigkeiten: /i18n.js (Format/Parse/Locale), /utils/html.js (esc)
 *
 * API (an nativem Input orientiert, damit der Umstieg mechanisch ist):
 *   type="date" | "time" | "datetime"   (default: date)
 *   value  — kanonisch ISO: "YYYY-MM-DD", "HH:MM" oder "YYYY-MM-DDTHH:MM".
 *            Der Setter toleriert auch locale-Anzeigeformat und normalisiert.
 *   min / max — ISO-Grenzen (nur Datum; optional)
 *   step   — Minuten-Raster der Zeit-Liste (default 15)
 *   disabled
 *   Property `.value` liefert immer die kanonische ISO-Form (oder "").
 *   Feuert `input` + `change` (bubbles) bei jeder Wertänderung.
 */
import {
  t,
  getLocale,
  parseDateInput,
  formatDateInput,
  parseTimeInput,
  formatTimeInput,
  dateInputPlaceholder,
  timeInputPlaceholder,
  getTimeFormat,
} from '/i18n.js';
import { esc } from '/utils/html.js';

// ── lokale Datums-Helfer (kanonisches ISO, lokale Zeitzone) ──────────────
const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
}

function todayIso() {
  const now = new Date();
  return isoOf(now.getFullYear(), now.getMonth(), now.getDate());
}

// Wochentagskürzel (Montag-first) und Monats-/Jahres-Label rein aus Intl —
// keine eigenen Locale-Strings für Kalenderbeschriftung nötig.
function weekdayLabels(locale) {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  // 2024-01-01 war ein Montag → 7 aufeinanderfolgende Tage ab Montag.
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(Date.UTC(2024, 0, 1 + i))));
}

function monthLabel(locale, year, month) {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(year, month, 1)));
}

// Minimale, lucide-nahe Inline-Icons (das Popover lebt im Top-Layer außerhalb
// der Seite; Inline-SVG ist dort robuster als data-lucide + createIcons).
const ICON = {
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
};

const VALID_TYPES = ['date', 'time', 'datetime'];

class YuvomiDatepicker extends HTMLElement {
  // form-associated: erscheint in form.elements / FormData über `name`,
  // damit `name`-basierte Reads (form.elements.x.value) den ISO-Wert erhalten.
  static formAssociated = true;

  static get observedAttributes() {
    return ['type', 'value', 'min', 'max', 'step', 'disabled', 'placeholder'];
  }

  constructor() {
    super();
    this._internals = this.attachInternals?.();
    this._type = 'date';
    this._subs = [];          // [{ kind, wrap, input, native, trigger, iso }]
    this._popover = null;     // wiederverwendetes Top-Layer-Popover
    this._activeSub = null;   // Subfeld, dessen Popover offen ist
    this._viewYear = 0;       // aktuell angezeigter Kalendermonat
    this._viewMonth = 0;
    this._onDocPointer = this._onDocPointer.bind(this);
    this._reposition = this._reposition.bind(this);
  }

  connectedCallback() {
    if (this._built) return;
    this._type = VALID_TYPES.includes(this.getAttribute('type'))
      ? this.getAttribute('type') : 'date';
    this._built = true;
    this._render();
    // value-Attribut initial übernehmen (toleriert ISO & Anzeigeformat)
    if (this.hasAttribute('value')) this.value = this.getAttribute('value');
  }

  disconnectedCallback() {
    this._closePopover();
    this._popover?.remove();
    this._popover = null;
  }

  attributeChangedCallback(name, oldV, newV) {
    if (!this._built || oldV === newV) return;
    if (name === 'value') this.value = newV;
    else if (name === 'disabled') this._syncDisabled();
    else if (name === 'placeholder') this._syncPlaceholders();
  }

  // ── öffentliche Property: kanonisches ISO ──────────────────────────────
  get value() {
    if (this._type === 'datetime') {
      const d = this._subs.find((s) => s.kind === 'date')?.iso || '';
      const tm = this._subs.find((s) => s.kind === 'time')?.iso || '';
      if (d && tm) return `${d}T${tm}`;
      return d || '';
    }
    return this._subs[0]?.iso || '';
  }

  set value(v) {
    const raw = v == null ? '' : String(v);
    if (this._type === 'datetime') {
      const [datePart, timePart] = raw.split('T');
      this._setSubIso(this._subs.find((s) => s.kind === 'date'), datePart, false);
      this._setSubIso(this._subs.find((s) => s.kind === 'time'), timePart, false);
    } else {
      this._setSubIso(this._subs[0], raw, false);
    }
    this._internals?.setFormValue(this.value);
  }

  get type() { return this._type; }

  focus() { this._subs[0]?.input?.focus(); }

  // ── Aufbau ─────────────────────────────────────────────────────────────
  _render() {
    const kinds = this._type === 'datetime' ? ['date', 'time']
      : this._type === 'time' ? ['time'] : ['date'];
    this.classList.add('ydp');
    if (this._type === 'datetime') this.classList.add('ydp--datetime');

    this.replaceChildren();
    this.insertAdjacentHTML('beforeend',
      `<div class="ydp__fields">${kinds.map((k) => this._subHtml(k)).join('')}</div>`);

    this._subs = kinds.map((kind, i) => {
      const wrap = this.querySelectorAll('.ydp__sub')[i];
      const sub = {
        kind,
        wrap,
        input: wrap.querySelector('.ydp__input'),
        native: wrap.querySelector('.ydp__native'),
        trigger: wrap.querySelector('.ydp__trigger'),
        iso: '',
      };
      this._bindSub(sub);
      return sub;
    });
    this._syncDisabled();
  }

  // Zugänglicher Name des inneren Feldes: explizites `label`-Attribut, sonst
  // ein zugehöriges <label for="hostId">, sonst ein umschließendes <label>.
  // So erben migrierte native Felder ihren Namen ohne Extra-Verdrahtung.
  _resolveLabel() {
    const explicit = this.getAttribute('label');
    if (explicit) return explicit;
    if (this.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(this.id)}"]`);
      if (forLabel) return forLabel.textContent.trim();
    }
    const wrapping = this.closest('label');
    if (wrapping) return wrapping.textContent.trim();
    return '';
  }

  _subHtml(kind) {
    const isDate = kind === 'date';
    const placeholder = isDate ? dateInputPlaceholder() : timeInputPlaceholder();
    const nativeType = isDate ? 'date' : 'time';
    const triggerLabel = isDate ? t('datepicker.openCalendar') : t('datepicker.openTimePicker');
    const icon = isDate ? ICON.calendar : ICON.clock;
    // Der Host trägt die id (für den .value-Kontrakt), ist aber nicht labelbar;
    // deshalb bekommt das innere Feld über das `label`-Attribut einen Namen.
    const fieldLabel = this._resolveLabel();
    const ariaLabel = fieldLabel
      ? ` aria-label="${esc(fieldLabel)}"` : '';
    // aria-describedby (z. B. Fehler-/Hinweisregion) an das innere Feld reichen
    const describedBy = this.getAttribute('aria-describedby');
    const ariaDescribedBy = describedBy
      ? ` aria-describedby="${esc(describedBy)}"` : '';
    return `
      <div class="ydp__sub ydp__sub--${kind}">
        <input type="text" class="form-input ydp__input" autocomplete="off"
               inputmode="text" placeholder="${esc(placeholder)}"
               aria-invalid="false"${ariaLabel}${ariaDescribedBy}>
        <input type="${nativeType}" class="ydp__native" tabindex="-1" aria-hidden="true">
        <button type="button" class="ydp__trigger" aria-haspopup="dialog"
                aria-expanded="false" aria-label="${esc(triggerLabel)}">${icon}</button>
      </div>`;
  }

  _bindSub(sub) {
    const isDate = sub.kind === 'date';
    const parse = isDate ? parseDateInput : parseTimeInput;
    const format = isDate ? formatDateInput : formatTimeInput;

    // Tippen: nur sinnvolle Zeichen zulassen (wie bisherige js-date/time-Inputs)
    const allow = isDate ? /[\d./\-]/ : /[\d:.,hH apmAPM]/;
    sub.input.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1) return;
      if (!allow.test(e.key)) e.preventDefault();
    });

    // Blur: normalisieren + Validität spiegeln (inkl. min/max-Grenzen)
    sub.input.addEventListener('blur', () => {
      const raw = sub.input.value.trim();
      const iso = parse(raw);
      if (raw && (!iso || this._outOfRange(sub.kind, iso))) {
        sub.wrap.classList.add('is-invalid');
        sub.input.setAttribute('aria-invalid', 'true');
        sub.iso = '';               // außerhalb der Grenzen nicht als gültig behalten
        this._emit();
        return;
      }
      sub.wrap.classList.remove('is-invalid');
      sub.input.setAttribute('aria-invalid', 'false');
      sub.iso = iso;
      if (iso) sub.input.value = format(iso);
      this._emit();
    });

    // Live-Tippen: ISO fortlaufend nachziehen, ohne die Anzeige umzuschreiben.
    // Rot markiert wird erst beim Blur; hier nur den Fehlerzustand aufheben,
    // sobald ein gültiger Wert innerhalb der Grenzen erreicht ist.
    sub.input.addEventListener('input', () => {
      const iso = parse(sub.input.value.trim());
      const valid = iso && !this._outOfRange(sub.kind, iso);
      sub.iso = valid ? iso : '';
      if (valid) {
        sub.wrap.classList.remove('is-invalid');
        sub.input.setAttribute('aria-invalid', 'false');
      }
      this._emit();
    });

    // Trigger: das DOM-Popover ist auf jedem Pointer-Typ der Primärpfad - es ist
    // vollständig DOM-getrieben und öffnet auf Desktop wie Touch zuverlässig.
    // Das native OS-Sheet (showPicker) bleibt nur Fallback für Touch-Browser
    // ohne Popover-API (sehr altes iOS <17): auf iOS ist showPicker() bei einem
    // versteckten Proxy-Input (opacity:0/aria-hidden) ein stilles No-op ohne
    // Exception, weshalb es nicht als Primärpfad taugt.
    sub.trigger.addEventListener('click', () => {
      if (this.hasAttribute('disabled')) return;
      const coarse = window.matchMedia?.('(pointer: coarse)').matches;
      if (coarse && !this._supportsPopover() && this._openNative(sub)) return;
      this._openPopover(sub);
    });

    // natives Input schreibt ISO zurück
    sub.native.addEventListener('change', () => {
      if (sub.native.value) this._setSubIso(sub, sub.native.value, true);
    });
  }

  // Popover-API vorhanden? (Top-Layer-Popover ist der bevorzugte Pfad; nur ohne
  // sie greift auf Touch das native OS-Sheet.)
  _supportsPopover() {
    return typeof HTMLElement !== 'undefined'
      && typeof HTMLElement.prototype.showPopover === 'function';
  }

  _openNative(sub) {
    try {
      sub.native.value = sub.iso || '';
      if (this.getAttribute('min')) sub.native.min = this.getAttribute('min');
      if (this.getAttribute('max')) sub.native.max = this.getAttribute('max');
      sub.native.showPicker();
      return true;
    } catch {
      return false; // showPicker nicht verfügbar → Fallback aufs Popover
    }
  }

  // ── Wert setzen (aus Popover / native / Property) ──────────────────────
  _setSubIso(sub, rawValue, emit) {
    if (!sub) return;
    const parse = sub.kind === 'date' ? parseDateInput : parseTimeInput;
    const format = sub.kind === 'date' ? formatDateInput : formatTimeInput;
    const iso = parse(rawValue == null ? '' : String(rawValue).trim());
    sub.iso = iso;
    sub.input.value = iso ? format(iso) : '';
    sub.wrap.classList.remove('is-invalid');
    sub.input.setAttribute('aria-invalid', 'false');
    if (emit) this._emit();
  }

  // Datum außerhalb der optionalen min/max-Grenzen? (nur für getippte Werte —
  // bereits gespeicherte Werte via Attribut werden bewusst nicht verworfen)
  _outOfRange(kind, iso) {
    if (kind !== 'date' || !iso) return false;
    const min = this.getAttribute('min');
    const max = this.getAttribute('max');
    return (!!min && iso < min) || (!!max && iso > max);
  }

  // Schreibrichtung (RTL für ar/fa): am nächsten dir-Vorfahren, sonst <html>
  _dir() {
    const d = this.closest('[dir]')?.getAttribute('dir')
      || document.documentElement.getAttribute('dir') || 'ltr';
    return d.toLowerCase() === 'rtl' ? 'rtl' : 'ltr';
  }

  _emit() {
    this._internals?.setFormValue(this.value);
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }

  _syncDisabled() {
    const off = this.hasAttribute('disabled');
    this._subs.forEach((s) => {
      s.input.disabled = off;
      s.trigger.disabled = off;
    });
  }

  _syncPlaceholders() {
    const ph = this.getAttribute('placeholder');
    if (ph == null) return;
    this._subs.forEach((s) => { s.input.placeholder = ph; });
  }

  // ── Popover (Top-Layer) ────────────────────────────────────────────────
  _ensurePopover() {
    if (this._popover) return this._popover;
    const el = document.createElement('div');
    el.className = 'ydp-popover';
    el.setAttribute('popover', 'manual');
    el.setAttribute('role', 'dialog');
    document.body.appendChild(el);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this._closePopover(); this._activeSub?.trigger.focus(); return; }
      if (e.key === 'Tab') this._trapTab(e, el);
    });
    this._popover = el;
    return el;
  }

  // Fokus im Popover halten (role="dialog"): Tab am Rand zirkulieren lassen.
  _trapTab(e, el) {
    const focusable = [...el.querySelectorAll('button:not([tabindex="-1"]):not(:disabled), [tabindex="0"]')]
      .filter((n) => n.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !el.contains(active))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (active === last || !el.contains(active))) {
      e.preventDefault(); first.focus();
    }
  }

  _openPopover(sub) {
    const el = this._ensurePopover();
    this._activeSub = sub;
    // Zugänglicher Name des Dialogs + Schreibrichtung (RTL für ar/fa)
    el.setAttribute('aria-label', this._resolveLabel()
      || (sub.kind === 'date' ? t('datepicker.openCalendar') : t('datepicker.openTimePicker')));
    el.dir = this._dir();
    if (sub.kind === 'date') this._renderCalendar(el, sub);
    else this._renderTimeList(el, sub);

    sub.trigger.setAttribute('aria-expanded', 'true');
    try { el.showPopover(); } catch { /* bereits offen */ }
    this._position(sub.trigger, el);
    document.addEventListener('pointerdown', this._onDocPointer, true);
    window.addEventListener('resize', this._reposition, { passive: true });
    window.addEventListener('scroll', this._reposition, { passive: true, capture: true });

    // Fokus in die aktive Auswahl
    (el.querySelector('[aria-selected="true"]') || el.querySelector('[tabindex="0"]')
      || el.querySelector('button'))?.focus();
    if (sub.kind === 'time') {
      el.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    }
  }

  _closePopover() {
    if (!this._popover) return;
    try { this._popover.hidePopover(); } catch { /* war zu */ }
    this._activeSub?.trigger.setAttribute('aria-expanded', 'false');
    this._activeSub = null;
    document.removeEventListener('pointerdown', this._onDocPointer, true);
    window.removeEventListener('resize', this._reposition);
    window.removeEventListener('scroll', this._reposition, true);
  }

  _onDocPointer(e) {
    if (this._popover?.contains(e.target)) return;
    if (this._activeSub?.wrap.contains(e.target)) return;
    this._closePopover();
  }

  _reposition() {
    if (this._activeSub) this._position(this._activeSub.trigger, this._popover);
  }

  _position(anchor, el) {
    const r = anchor.getBoundingClientRect();
    const pw = el.offsetWidth || 320;
    const ph = el.offsetHeight || 320;
    const gap = 6;
    // LTR: rechtsbündig zum Trigger; RTL: linksbündig — dann kollisionssicher klemmen
    let left = this._dir() === 'rtl' ? r.left : (r.right - pw);
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = r.bottom + gap;
    if (top + ph > window.innerHeight - 8) {
      const above = r.top - gap - ph;
      top = above > 8 ? above : Math.max(8, window.innerHeight - ph - 8);
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  // ── Kalender ───────────────────────────────────────────────────────────
  _renderCalendar(el, sub) {
    const base = parseIso(sub.iso) || parseIso(todayIso());
    this._viewYear = base.y;
    this._viewMonth = base.m;
    el.replaceChildren();
    el.insertAdjacentHTML('beforeend', `
      <div class="ydp-cal">
        <div class="ydp-cal__head">
          <button type="button" class="ydp-navbtn ydp-nav-prev" aria-label="${esc(t('datepicker.previousMonth'))}">${this._dir() === 'rtl' ? ICON.next : ICON.prev}</button>
          <span class="ydp-cal__label" aria-live="polite"></span>
          <button type="button" class="ydp-navbtn ydp-nav-next" aria-label="${esc(t('datepicker.nextMonth'))}">${this._dir() === 'rtl' ? ICON.prev : ICON.next}</button>
        </div>
        <div class="ydp-cal__grid ydp-cal__weekdays" aria-hidden="true"></div>
        <div class="ydp-cal__grid ydp-cal__days" role="grid"></div>
        <div class="ydp-cal__foot">
          <button type="button" class="ydp-textbtn ydp-textbtn--today ydp-today">${esc(t('datepicker.today'))}</button>
          <button type="button" class="ydp-textbtn ydp-textbtn--clear ydp-clear">${esc(t('datepicker.clear'))}</button>
        </div>
      </div>`);

    const locale = getLocale();
    const wdRow = el.querySelector('.ydp-cal__weekdays');
    weekdayLabels(locale).forEach((w) => {
      wdRow.insertAdjacentHTML('beforeend', `<span class="ydp-cal__wd">${esc(w)}</span>`);
    });

    el.querySelector('.ydp-nav-prev').addEventListener('click', () => this._shiftMonth(el, sub, -1));
    el.querySelector('.ydp-nav-next').addEventListener('click', () => this._shiftMonth(el, sub, 1));
    el.querySelector('.ydp-today').addEventListener('click', () => {
      this._setSubIso(sub, todayIso(), true);
      this._closePopover();
      sub.trigger.focus();
    });
    el.querySelector('.ydp-clear').addEventListener('click', () => {
      this._setSubIso(sub, '', true);
      this._closePopover();
      sub.trigger.focus();
    });

    this._paintDays(el, sub);
  }

  _shiftMonth(el, sub, delta) {
    let m = this._viewMonth + delta;
    let y = this._viewYear;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    this._viewMonth = m;
    this._viewYear = y;
    this._paintDays(el, sub);
    this._position(sub.trigger, el);
  }

  _paintDays(el, sub) {
    const locale = getLocale();
    el.querySelector('.ydp-cal__label').textContent =
      monthLabel(locale, this._viewYear, this._viewMonth);

    const grid = el.querySelector('.ydp-cal__days');
    grid.replaceChildren();

    const first = new Date(this._viewYear, this._viewMonth, 1);
    let offset = first.getDay() - 1;        // Montag = 0
    if (offset < 0) offset = 6;
    const start = new Date(this._viewYear, this._viewMonth, 1 - offset);

    const selIso = sub.iso;
    const today = todayIso();
    const min = this.getAttribute('min');
    const max = this.getAttribute('max');

    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = isoOf(d.getFullYear(), d.getMonth(), d.getDate());
      const outside = d.getMonth() !== this._viewMonth;
      const disabled = (min && iso < min) || (max && iso > max);
      const selected = iso === selIso;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ydp-cal__day'
        + (outside ? ' is-outside' : '')
        + (iso === today ? ' is-today' : '');
      btn.textContent = String(d.getDate());
      btn.dataset.iso = iso;
      btn.setAttribute('role', 'gridcell');
      btn.tabIndex = selected ? 0 : -1;
      if (selected) btn.setAttribute('aria-selected', 'true');
      if (disabled) btn.disabled = true;
      btn.addEventListener('click', () => {
        this._setSubIso(sub, iso, true);
        this._closePopover();
        sub.trigger.focus();
      });
      grid.appendChild(btn);
    }
    // Kein selektierter Tag im Monat → ersten fokussierbaren Tag markieren
    if (!grid.querySelector('[tabindex="0"]')) {
      const firstIn = [...grid.children].find((b) => !b.classList.contains('is-outside') && !b.disabled);
      if (firstIn) firstIn.tabIndex = 0;
    }
    this._bindGridKeys(grid, el, sub);
  }

  _bindGridKeys(grid, el, sub) {
    grid.addEventListener('keydown', (e) => {
      const cur = document.activeElement;
      if (!cur?.dataset?.iso) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (step != null) {
        e.preventDefault();
        const p = parseIso(cur.dataset.iso);
        const d = new Date(p.y, p.m, p.d + step);
        const iso = isoOf(d.getFullYear(), d.getMonth(), d.getDate());
        if (d.getFullYear() !== this._viewYear || d.getMonth() !== this._viewMonth) {
          this._viewYear = d.getFullYear();
          this._viewMonth = d.getMonth();
          this._paintDays(el, sub);
          this._position(sub.trigger, el);
        }
        const target = grid.querySelector(`[data-iso="${iso}"]`);
        if (target && !target.disabled) {
          grid.querySelectorAll('[tabindex="0"]').forEach((b) => { b.tabIndex = -1; });
          target.tabIndex = 0;
          target.focus();
        }
      } else if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        this._shiftMonth(el, sub, e.key === 'PageUp' ? -1 : 1);
        (grid.querySelector('[tabindex="0"]'))?.focus();
      }
    });
  }

  // ── Zeit-Liste ─────────────────────────────────────────────────────────
  _renderTimeList(el, sub) {
    el.replaceChildren();
    el.insertAdjacentHTML('beforeend', `<div class="ydp-time"><div class="ydp-time__list" role="listbox" aria-label="${esc(t('datepicker.openTimePicker'))}"></div></div>`);
    const list = el.querySelector('.ydp-time__list');
    const step = Math.max(1, Number(this.getAttribute('step')) || 15);
    const use12h = getTimeFormat() === '12h';

    for (let mins = 0; mins < 24 * 60; mins += step) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const iso = `${pad2(h)}:${pad2(m)}`;
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'ydp-time__opt';
      opt.setAttribute('role', 'option');
      opt.dataset.iso = iso;
      opt.textContent = use12h ? formatTimeInput(iso) : iso;
      opt.tabIndex = -1;
      if (iso === sub.iso) {
        opt.setAttribute('aria-selected', 'true');
        opt.tabIndex = 0;
      }
      opt.addEventListener('click', () => {
        this._setSubIso(sub, iso, true);
        this._closePopover();
        sub.trigger.focus();
      });
      list.appendChild(opt);
    }
    if (!list.querySelector('[tabindex="0"]') && list.firstElementChild) {
      list.firstElementChild.tabIndex = 0;
    }

    list.addEventListener('keydown', (e) => {
      const cur = document.activeElement;
      if (!cur?.classList.contains('ydp-time__opt')) return;
      let target = null;
      if (e.key === 'ArrowDown') target = cur.nextElementSibling;
      else if (e.key === 'ArrowUp') target = cur.previousElementSibling;
      else if (e.key === 'Home') target = list.firstElementChild;
      else if (e.key === 'End') target = list.lastElementChild;
      if (target) {
        e.preventDefault();
        cur.tabIndex = -1;
        target.tabIndex = 0;
        target.focus();
        target.scrollIntoView({ block: 'nearest' });
      }
    });
  }
}

if (!customElements.get('yuvomi-datepicker')) {
  customElements.define('yuvomi-datepicker', YuvomiDatepicker);
}

export { YuvomiDatepicker };

/**
 * Modul: Shared Modal-System
 * Zweck: Einheitliches Modal mit Focus-Trap, Escape-Handler, Overlay-Click,
 *        Focus-Restore, Scroll-Lock und aria-modal.
 *        Auf Mobile: Bottom Sheet mit Swipe-to-Close und Slide-out-Animation.
 * Abhängigkeiten: CSS-Klassen aus layout.css (.modal-overlay, .modal-panel, etc.)
 *                 i18n.js (t)
 *
 * API:
 *   openModal({ title, content, onSave, onDelete, onClose, size }) → void
 *   closeModal() → void
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

let activeOverlay = null;
let previouslyFocused = null;
let focusTrapHandler = null;
let _initialFormSnapshot = null;
let _initialFormTimeout = null;

// Modal-Lebenszyklus als explizite Zustandsmaschine (Audit 1.5). Ersetzt die
// frühere ad-hoc-Jonglage aus einem Boolean-Schließ-Flag plus temporär
// genullten Globals. Gültige Zustände:
//   idle       – kein Modal offen
//   open       – Modal sichtbar und interaktiv
//   confirming – „Änderungen verwerfen?"-Dialog liegt über einem dirty Modal
//   closing    – Schließ-Animation/Cleanup läuft (blockt erneutes Schließen)
let modalState = 'idle';

// Overlay-Dimming: theme-color abdunkeln im Standalone-Modus
const OVERLAY_THEME_COLOR = '#1A1A1A';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

// --------------------------------------------------------
// Focus-Trap (Spec §5.2)
// --------------------------------------------------------

function trapFocus(container) {
  focusTrapHandler = (e) => {
    // Tab-Trap: Fokus innerhalb des Modals halten
    if (e.key === 'Tab') {
      const focusable = container.querySelectorAll(FOCUSABLE);
      if (!focusable.length) return;
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }

    // Enter in einzeiligen Inputs/Selects → Formular absenden (Standard-Web-
    // Konvention, Audit 1.4). Textareas behalten ihr Standardverhalten (Zeilen-
    // umbruch), Submit-/Button-Elemente lösen ohnehin ihren eigenen Klick aus.
    if (e.key === 'Enter') {
      const active = document.activeElement;
      const isInput = active.tagName === 'INPUT' && active.type !== 'submit' && active.type !== 'button';
      const isSelect = active.tagName === 'SELECT';

      if (isInput || isSelect) {
        const submitBtn = container.querySelector('button[type="submit"], .btn--primary');
        if (submitBtn && !submitBtn.disabled) {
          e.preventDefault();
          submitBtn.click();
        }
      }
    }
  };
  container.addEventListener('keydown', focusTrapHandler);

  // Virtual Keyboard: Focused Input in sichtbaren Bereich scrollen
  function onInputFocus(e) {
    const tag = e.target.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
    setTimeout(() => {
      e.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
  }
  container.addEventListener('focusin', onInputFocus);
  container._onInputFocus = onInputFocus;

  // Focus first focusable element
  const first = container.querySelector(FOCUSABLE);
  if (first) {
    setTimeout(() => first.focus(), 50);
  }
}

// --------------------------------------------------------
// Dirty-Check Helpers
// --------------------------------------------------------

function serializeForm(container) {
  const inputs = container.querySelectorAll('input:not([type="file"]), select, textarea');
  return Array.from(inputs).map((el) => `${el.name || el.id}=${el.value}`).join('&');
}

function isFormDirty(container) {
  if (_initialFormSnapshot === null) return false;
  return serializeForm(container) !== _initialFormSnapshot;
}

// --------------------------------------------------------
// Escape-Handler
// --------------------------------------------------------

function onEscape(e) {
  if (e.key === 'Escape') closeModal();
}

// --------------------------------------------------------
// Swipe-to-Close (Mobile)
// --------------------------------------------------------

function _wireSheetSwipe(panel) {
  let startY = 0;
  let dragging = false;

  // Scroll position is now on the body, not the panel itself
  const scrollBody = panel.querySelector('.modal-panel__body');

  panel.addEventListener('touchstart', (e) => {
    // Nur von der Handle-Zone (obere 48px) oder wenn Panel ganz oben → Swipe erlauben
    const touchY = e.touches[0].clientY;
    const rect = panel.getBoundingClientRect();
    const isHandleZone = touchY - rect.top < 48;
    const isScrolledToTop = (scrollBody ? scrollBody.scrollTop : panel.scrollTop) <= 0;
    if (!isHandleZone && !isScrolledToTop) return;
    startY = touchY;
    dragging = true;
  }, { passive: true });

  panel.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < 0) { panel.style.transform = 'translateY(0)'; return; } // Aufwärts: Panel zurücksetzen, dragging bleibt aktiv
    // Erst ab 10px Bewegung animieren: Verhindert winzige Transforms durch
    // normale Taps, die danach zurückgesetzt werden müssten.
    if (dy > 10) panel.style.transform = `translateY(${(dy - 10) * 0.6}px)`;
  }, { passive: true });

  panel.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 80) {
      panel.style.transform = '';
      closeModal();
    } else {
      // Transform-Reset per rAF verzögern: DOM-Mutationen direkt in touchend
      // unterbrechen auf iOS WebKit die Touch→Click-Konvertierung – der click-Event
      // auf Child-Elementen (Buttons) wird gecancelt → Buttons reagieren nicht.
      requestAnimationFrame(() => { panel.style.transform = ''; });
    }
  });
}

// --------------------------------------------------------
// Suspend/Restore für den Dirty-Confirm-Dialog (Audit 1.5)
//
// Das Shared-Modal kennt bewusst kein Stacking: ein „Verwerfen?"-Dialog nutzt
// denselben Overlay-Slot wie das dirty Formular darunter. Damit der nachfolgende
// openModal()-Aufruf (in confirmModal) das dirty Modal nicht wegräumt, wird es
// kurzzeitig aus dem aktiven Slot gelöst und in einem Token geparkt. Diese drei
// Helfer kapseln die Übergänge, statt die Globals frei „auszuleihen".
// --------------------------------------------------------

function _suspendActiveModal() {
  const overlay = activeOverlay;
  const token = { overlay, id: overlay.id, snapshot: _initialFormSnapshot };
  overlay.removeAttribute('id');
  activeOverlay = null;
  modalState = 'confirming';
  return token;
}

// Nutzer bricht das Verwerfen ab → dirty Modal exakt wiederherstellen.
function _resumeSuspendedModal({ overlay, id, snapshot }) {
  if (id) overlay.id = id;
  activeOverlay = overlay;
  _initialFormSnapshot = snapshot;
  document.body.style.overflow = 'hidden';
  modalState = 'open';
  if (window.oikos?.setThemeColor) {
    window.oikos.setThemeColor(OVERLAY_THEME_COLOR, OVERLAY_THEME_COLOR);
  }
}

// Nutzer bestätigt das Verwerfen → dirty Modal wieder zum aktiven Overlay
// machen, damit die nachfolgende Schließ-Logik es regulär abräumt.
function _discardSuspendedModal({ overlay }) {
  activeOverlay = overlay;
}

// --------------------------------------------------------
// _doClose - gemeinsame Cleanup-Logik
// --------------------------------------------------------

function _doClose(overlayEl) {
  const target = overlayEl ?? activeOverlay;
  if (!target) return;

  target.remove();

  // Globalen State nur zurücksetzen wenn kein neues Modal zwischenzeitlich geöffnet wurde.
  if (activeOverlay === target) {
    activeOverlay = null;
    modalState = 'idle';

    // Scroll-Lock aufheben
    document.body.style.overflow = '';

    // Focus-Restore
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
      previouslyFocused = null;
    }

    // Standalone: Statusbar-Farbe zur aktuellen Route wiederherstellen
    if (window.oikos?.restoreThemeColor) {
      window.oikos.restoreThemeColor();
    }
  }
}

// --------------------------------------------------------
// openModal
// --------------------------------------------------------

/**
 * Öffnet ein Modal mit dem Shared-System.
 *
 * @param {Object}   opts
 * @param {string}   opts.title    - Titel im Modal-Header
 * @param {string}   opts.content  - HTML-String für den Modal-Body
 * @param {Function} [opts.onSave]   - Callback, wird nach Einfügen in DOM aufgerufen
 * @param {Function} [opts.onClose]  - Callback, wird aufgerufen wenn das Modal geschlossen wird
 * @param {Function} [opts.onDelete] - Falls vorhanden, wird ein Löschen-Button eingebaut
 * @param {string}   [opts.size='md'] - 'sm' (400px) | 'md' (520px) | 'lg' (680px) | 'xl' (min(960px, 95vw)); Breiten siehe layout.css .modal-panel--*
 */
export function openModal({ title, content, onSave, onDelete, onClose, size = 'md' } = {}) {
  // Vorheriges Modal schließen (kein Stacking).
  if (activeOverlay) {
    activeOverlay.removeAttribute('id');
    // force:true ensures we don't trigger another dirty check while opening a new modal
    closeModal({ force: true });
  }

  // Focus-Restore vorbereiten
  previouslyFocused = document.activeElement;

  // Scroll-Lock
  document.body.style.overflow = 'hidden';

  const sizeClass = size !== 'md' ? ` modal-panel--${size}` : '';

  const html = `
    <div class="modal-overlay" id="shared-modal-overlay" aria-label="${t('modal.overlayLabel')}">
      <div class="modal-panel${sizeClass}" role="dialog" aria-modal="true"
           aria-labelledby="shared-modal-title">
        <div class="modal-panel__header">
          <h2 class="modal-panel__title" id="shared-modal-title">${esc(title)}</h2>
          <button class="modal-panel__close" data-action="close-modal" aria-label="${t('modal.closeLabel')}">
            <i data-lucide="x" style="width:16px;height:16px" aria-hidden="true"></i>
          </button>
        </div>
        <div class="modal-panel__body">
          ${content}
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
  activeOverlay = document.getElementById('shared-modal-overlay');
  activeOverlay._onCloseCallback = onClose;

  // Lucide-Icons rendern
  if (window.lucide) window.lucide.createIcons({ el: activeOverlay });

  // Focus-Trap
  const panel = activeOverlay.querySelector('.modal-panel');
  trapFocus(panel);

  // Snapshot für Dirty-Check (kurzer Delay: Felder könnten noch per JS befüllt werden)
  if (_initialFormTimeout) clearTimeout(_initialFormTimeout);
  _initialFormSnapshot = null;
  _initialFormTimeout = setTimeout(() => {
    if (activeOverlay) {
      _initialFormSnapshot = serializeForm(activeOverlay.querySelector('.modal-panel') ?? activeOverlay);
    }
  }, 150);

  // Swipe-to-Close auf Mobile
  if (window.innerWidth < 768) {
    _wireSheetSwipe(panel);
  }

  // Overlay-Click schließt Modal
  activeOverlay.addEventListener('click', (e) => {
    if (e.target === activeOverlay) closeModal();
  });

  // iOS PWA: touchend als Fallback
  activeOverlay.addEventListener('touchend', (e) => {
    if (e.target === activeOverlay) closeModal();
  }, { passive: true });

  // Close-Button
  activeOverlay.querySelector('[data-action="close-modal"]')
    ?.addEventListener('click', () => closeModal());

  // Escape (nur einmal binden)
  document.removeEventListener('keydown', onEscape);
  document.addEventListener('keydown', onEscape);

  // Callback für Aufrufer
  if (typeof onSave === 'function') onSave(panel);

  // Loading-State
  panel.addEventListener('submit', (e) => {
    const btn = e.target.querySelector('[type="submit"], .btn--primary');
    if (!btn || btn.disabled) return;
    btn.classList.add('btn--loading');
    requestAnimationFrame(() => {
      if (!btn.disabled) { btn.classList.remove('btn--loading'); return; }
      const mo = new MutationObserver(() => {
        if (!btn.disabled) { btn.classList.remove('btn--loading'); mo.disconnect(); }
      });
      mo.observe(btn, { attributes: true, attributeFilter: ['disabled'] });
    });
  }, { capture: true });

  // Standalone: Statusbar abdunkeln
  if (window.oikos?.setThemeColor) {
    window.oikos.setThemeColor(OVERLAY_THEME_COLOR, OVERLAY_THEME_COLOR);
  }

  modalState = 'open';
}

// --------------------------------------------------------
// closeModal
// --------------------------------------------------------

export async function closeModal({ force = false } = {}) {
  // Bereits im Schließ-Lauf? Erneute Aufrufe (z.B. schnelles Doppel-Schließen,
  // Hardware-Back) ignorieren.
  if (!activeOverlay || modalState === 'closing') return;

  if (!force) {
    const panel = activeOverlay.querySelector('.modal-panel');
    if (panel && isFormDirty(panel)) {
      // Dirty Modal in den Confirm-Slot parken (modalState → 'confirming').
      const suspended = _suspendActiveModal();

      const confirmed = await confirmModal(t('modal.unsavedChanges'), {
        danger: false,
        confirmLabel: t('modal.discardChanges'),
      });

      if (!confirmed) {
        // Verwerfen abgebrochen → dirty Modal exakt wiederherstellen.
        _resumeSuspendedModal(suspended);
        return;
      }

      // Verwerfen bestätigt → dirty Modal wieder aktiv, regulär abräumen.
      _discardSuspendedModal(suspended);
    }
  }

  // Finale Schließphase beginnt hier.
  modalState = 'closing';

  if (_initialFormTimeout) {
    clearTimeout(_initialFormTimeout);
    _initialFormTimeout = null;
  }
  _initialFormSnapshot = null;

  document.removeEventListener('keydown', onEscape);

  const capturedOverlay = activeOverlay;
  const panel = capturedOverlay.querySelector('.modal-panel');

  if (typeof capturedOverlay._onCloseCallback === 'function') {
    capturedOverlay._onCloseCallback();
  }

  // Focus-Trap Cleanup
  if (focusTrapHandler) {
    if (panel) panel.removeEventListener('keydown', focusTrapHandler);
    focusTrapHandler = null;
  }
  if (panel?._onInputFocus) {
    panel.removeEventListener('focusin', panel._onInputFocus);
  }

  // Animation handling
  const isMobile = window.innerWidth < 768;
  if (isMobile && panel) {
    panel.classList.add('modal-panel--closing');
    // _doClose setzt modalState auf 'idle', sobald der Overlay final entfernt wird.
    const fallback = setTimeout(() => {
      _doClose(capturedOverlay);
    }, 400); // Slightly longer fallback
    panel.addEventListener('animationend', () => {
      clearTimeout(fallback);
      _doClose(capturedOverlay);
    }, { once: true });
    return;
  }

  _doClose(capturedOverlay);
}

// --------------------------------------------------------
// promptModal
// --------------------------------------------------------

export function promptModal(label, defaultValue = '') {
  return new Promise((resolve) => {
    let resolved = false;

    function finish(value) {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    }

    openModal({
      title: label,
      size: 'sm',
      content: `
        <form id="prompt-modal-form" class="form-stack">
          <div class="form-field">
            <input class="form-input" id="prompt-modal-input" type="text"
                   value="${esc(defaultValue)}" autocomplete="off">
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn--ghost" id="prompt-modal-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary" id="prompt-modal-ok">${t('common.save')}</button>
          </div>
        </form>`,
      onClose: () => finish(null),
      onSave(panel) {
        const form  = panel.querySelector('#prompt-modal-form');
        const input = panel.querySelector('#prompt-modal-input');
        const cancel = panel.querySelector('#prompt-modal-cancel');

        form.addEventListener('submit', (e) => {
          e.preventDefault();
          finish(input.value.trim() || null);
        });

        cancel.addEventListener('click', () => finish(null));

        setTimeout(() => {
          input.focus();
          input.select();
        }, 50);
      },
    });
  });
}

// --------------------------------------------------------
// selectModal
// --------------------------------------------------------

export function selectModal(label, options) {
  return new Promise((resolve) => {
    let resolved = false;

    function finish(value) {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    }

    const optionsHtml = options
      .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
      .join('');

    openModal({
      title: label,
      size: 'sm',
      content: `
        <form id="select-modal-form" class="form-stack">
          <div class="form-field">
            <select class="form-input" id="select-modal-input">${optionsHtml}</select>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn--ghost" id="select-modal-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary" id="select-modal-ok">${t('common.save')}</button>
          </div>
        </form>`,
      onClose: () => finish(null),
      onSave(panel) {
        const form   = panel.querySelector('#select-modal-form');
        const select = panel.querySelector('#select-modal-input');
        const cancel = panel.querySelector('#select-modal-cancel');

        form.addEventListener('submit', (e) => {
          e.preventDefault();
          finish(select.value);
        });

        cancel.addEventListener('click', () => finish(null));
      },
    });
  });
}

// --------------------------------------------------------
// confirmModal
// --------------------------------------------------------

export function confirmModal(message, { confirmLabel, danger = false } = {}) {
  return new Promise((resolve) => {
    let resolved = false;

    function finish(value) {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(value);
    }

    openModal({
      title: message,
      size: 'sm',
      content: `
        <div class="modal-actions">
          <button type="button" class="btn btn--ghost" id="confirm-modal-cancel">${t('common.cancel')}</button>
          <button type="button" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" id="confirm-modal-ok">
            ${confirmLabel ?? t('common.confirm')}
          </button>
        </div>`,
      onClose: () => finish(false),
      onSave(panel) {
        panel.querySelector('#confirm-modal-ok')?.addEventListener('click', () => finish(true));
        panel.querySelector('#confirm-modal-cancel')?.addEventListener('click', () => finish(false));
      },
    });
  });
}

// --------------------------------------------------------
// Validation & Feedback
// --------------------------------------------------------

function _validateField(input) {
  const group = input.closest('.form-field') ?? input.parentElement;
  const hasValue = input.value.trim().length > 0;
  group?.classList.toggle('form-field--error', !hasValue);
  group?.classList.toggle('form-field--valid', hasValue);
  input.setAttribute('aria-invalid', String(!hasValue));

  if (!hasValue && group) {
    const count = parseInt(group.dataset.errorCount ?? '0', 10) + 1;
    group.dataset.errorCount = String(count);
    if (count >= 2) {
      group.classList.remove('form-field--error-repeat');
      void group.offsetWidth;
      group.classList.add('form-field--error-repeat');
      group.addEventListener('animationend', () => group.classList.remove('form-field--error-repeat'), { once: true });
    }
  } else if (hasValue && group) {
    group.dataset.errorCount = '0';
  }

  return hasValue;
}

export function wireBlurValidation(formContainer) {
  formContainer.querySelectorAll('input[required], select[required], textarea[required]').forEach((input) => {
    input.addEventListener('blur', () => _validateField(input));
  });
}

export function validateAll(formContainer) {
  let firstInvalid = null;
  let allValid = true;

  formContainer.querySelectorAll('input[required], select[required], textarea[required]').forEach((input) => {
    const valid = _validateField(input);
    if (!valid && !firstInvalid) firstInvalid = input;
    if (!valid) allValid = false;
  });

  if (firstInvalid) firstInvalid.focus();
  return allValid;
}

export function btnSuccess(btn, originalLabel) {
  btn.classList.remove('btn--loading');
  const label = originalLabel ?? btn.textContent;
  btn.classList.add('btn--success');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reducedMotion) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('aria-hidden', 'true');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', '20 6 9 17 4 12');
    svg.appendChild(poly);
    btn.replaceChildren(svg);
  }
  setTimeout(() => {
    btn.classList.remove('btn--success');
    btn.textContent = label;
  }, 700);
}

export function btnLoading(btn) {
  btn.classList.add('btn--loading');
  btn.disabled = true;
  return () => {
    btn.classList.remove('btn--loading');
    btn.disabled = false;
  };
}

export function btnError(btn) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    btn.classList.add('btn--error-static');
    setTimeout(() => btn.classList.remove('btn--error-static'), 700);
    return;
  }
  btn.classList.remove('btn--shaking');
  void btn.offsetWidth;
  btn.classList.add('btn--shaking');
  btn.addEventListener('animationend', () => btn.classList.remove('btn--shaking'), { once: true });
}

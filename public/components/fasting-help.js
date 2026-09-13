/** Fasting-only tap/focus disclosure, following the repository's info-help pattern. */
import { esc } from '/utils/html.js';

let sequence = 0;
export function fastingHelpHtml(label, paragraphs, attrs = '') {
  const id = `fasting-help-${++sequence}`;
  return `<yuvomi-fasting-help><button class="fasting-help__button" type="button" aria-label="${esc(label)}" aria-describedby="${id}" aria-expanded="false"><i data-lucide="info" aria-hidden="true"></i></button><span class="fasting-help__tooltip" id="${id}" role="tooltip" popover="manual" hidden ${attrs}><strong>${esc(label)}</strong>${paragraphs.map((text) => `<span>${esc(text)}</span>`).join('')}</span></yuvomi-fasting-help>`;
}

// Pure markup is also imported by non-DOM dashboard rendering tests.
if (typeof customElements !== 'undefined' && !customElements.get('yuvomi-fasting-help')) {
  class FastingHelp extends HTMLElement {
    connectedCallback() {
      this._controller?.abort();
      const controller = this._controller = new AbortController();
      const { signal } = controller;
      const button = this.querySelector('button'), tooltip = this.querySelector('[role="tooltip"]');
      if (!button || !tooltip) return;
      window.lucide?.createIcons({ el: this });
      const nativePopover = typeof tooltip.showPopover === 'function';
      if (!nativePopover) tooltip.removeAttribute('popover');
      let pinned = false, opened = false, openController;
      const close = this._close = () => {
        pinned = false; openController?.abort();
        if (nativePopover && tooltip.isConnected && opened) tooltip.hidePopover();
        opened = false; tooltip.hidden = true;
        button.setAttribute('aria-expanded', 'false');
      };
      const position = () => {
        const anchor = button.getBoundingClientRect(), box = tooltip.getBoundingClientRect();
        const margin = parseFloat(getComputedStyle(tooltip).getPropertyValue('--space-3')) || 12;
        tooltip.style.left = `${Math.max(margin, Math.min(anchor.left, innerWidth - box.width - margin))}px`;
        tooltip.style.top = `${Math.max(margin, Math.min(anchor.bottom + margin, innerHeight - box.height - margin))}px`;
      };
      const open = () => {
        if (opened) return;
        tooltip.hidden = false;
        if (nativePopover) tooltip.showPopover();
        opened = true; button.setAttribute('aria-expanded', 'true'); position();
        openController = new AbortController();
        const options = { signal: openController.signal, capture: true };
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') { event.stopPropagation(); close(); }
        }, options);
        document.addEventListener('pointerdown', (event) => { if (!this.contains(event.target)) close(); }, options);
        // Keyboard focus may itself scroll an off-screen trigger into view.
        window.addEventListener('scroll', position, options);
        window.addEventListener('resize', position, options);
      };
      // Explicit disclosure avoids hover-only content disappearing en route to it.
      button.addEventListener('focus', open, { signal });
      button.addEventListener('blur', close, { signal });
      tooltip.addEventListener('pointerdown', (event) => event.preventDefault(), { signal });
      button.addEventListener('click', () => { if (pinned) close(); else { pinned = true; open(); } }, { signal });
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
        if (!opened) return;
        const offsets = { ArrowDown: 40, ArrowUp: -40, PageDown: tooltip.clientHeight, PageUp: -tooltip.clientHeight, Home: -tooltip.scrollHeight, End: tooltip.scrollHeight };
        if (Object.hasOwn(offsets, event.key)) {
          tooltip.scrollTop += offsets[event.key]; event.preventDefault(); event.stopPropagation();
        }
      }, { signal });
    }
    disconnectedCallback() { this._close?.(); this._controller?.abort(); }
  }
  customElements.define('yuvomi-fasting-help', FastingHelp);
}

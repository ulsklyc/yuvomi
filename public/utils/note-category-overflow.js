/** Largest ordered prefix that fits, reserving the measured +N control. */
export function visibleCategoryCount(widths, available, gap, moreWidth) {
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
  if (total <= available) return widths.length;
  let used = 0;
  let fits = 0;
  for (let count = 0; count < widths.length; count++) {
    if (used + count * gap + moreWidth(widths.length - count) <= available) fits = count;
    used += widths[count];
  }
  return fits;
}

let tooltipSequence = 0;

/** Keep virtual focus on the trigger while reading a scrollable tooltip. */
export function scrollCategoryTooltip(tooltip, key) {
  const offsets = {
    ArrowDown: 40, ArrowUp: -40,
    PageDown: tooltip.clientHeight, PageUp: -tooltip.clientHeight,
    Home: -tooltip.scrollHeight, End: tooltip.scrollHeight,
  };
  if (!Object.hasOwn(offsets, key)) return false;
  tooltip.scrollTop += offsets[key];
  return true;
}

/** Owns measurement, tooltip and listeners for one dashboard build. */
export function wireNoteCategoryOverflow(root, formatCount = String, formatMoreAction = String) {
  const controller = new AbortController();
  const { signal } = controller;
  const tooltips = [];
  const updates = new Map();
  const observer = new ResizeObserver((entries) => {
    if (signal.aborted) return;
    for (const entry of entries) updates.get(entry.target)?.();
  });

  for (const row of root.querySelectorAll('.note-item__categories')) {
    const badges = [...row.querySelectorAll('.note-item__category')];
    const button = row.querySelector('.note-item__categories-more');
    const tooltip = document.createElement('div');
    tooltip.className = 'note-category-overflow-tooltip u-meta';
    tooltip.id = `note-category-overflow-${++tooltipSequence}`;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('popover', 'manual');
    document.body.append(tooltip);
    tooltips.push(tooltip);
    button.setAttribute('aria-describedby', tooltip.id);
    let open = false;
    let dismissed = false;
    let pinned = false;
    const hide = () => {
      if (open) tooltip.hidePopover();
      open = false;
    };
    const position = () => {
      const anchor = button.getBoundingClientRect();
      const box = tooltip.getBoundingClientRect();
      const left = Math.max(0, Math.min(anchor.left, document.documentElement.clientWidth - box.width));
      const top = anchor.bottom + box.height <= window.innerHeight ? anchor.bottom : Math.max(0, anchor.top - box.height);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };
    const show = () => {
      if (button.hidden || dismissed) return;
      if (!open) tooltip.showPopover();
      open = true;
      position();
    };
    const maybeHide = () => {
      if (!pinned && document.activeElement !== button && !button.matches(':hover') && !tooltip.matches(':hover')) hide();
    };
    const update = () => {
      const available = row.clientWidth;
      if (!available) { hide(); return; }
      badges.forEach((badge) => { badge.hidden = false; });
      button.hidden = false;
      const widths = badges.map((badge) => badge.getBoundingClientRect().width);
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      const count = visibleCategoryCount(widths, available, gap, (remaining) => {
        button.textContent = `+${formatCount(remaining)}`;
        return button.getBoundingClientRect().width;
      });
      badges.forEach((badge, index) => { badge.hidden = index >= count; });
      button.hidden = count === badges.length;
      const hiddenCount = badges.length - count;
      button.textContent = `+${formatCount(hiddenCount)}`;
      button.setAttribute('aria-label', formatMoreAction(hiddenCount));
      tooltip.replaceChildren();
      const list = document.createElement('ul');
      for (const badge of badges.slice(count)) {
        const item = document.createElement('li');
        item.textContent = badge.textContent;
        list.append(item);
      }
      tooltip.append(list);
      if (button.hidden) { pinned = false; hide(); }
      else if (open) position();
    };
    button.addEventListener('mouseenter', () => { dismissed = false; show(); }, { signal });
    button.addEventListener('focus', () => { dismissed = false; show(); }, { signal });
    button.addEventListener('mouseleave', maybeHide, { signal });
    button.addEventListener('blur', maybeHide, { signal });
    tooltip.addEventListener('mouseleave', maybeHide, { signal });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      pinned = !pinned;
      dismissed = !pinned;
      if (pinned) show(); else hide();
    }, { signal });
    // Activation belongs to this control; Escape must reach the dismiss handler.
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      if (!open) return;
      if (scrollCategoryTooltip(tooltip, event.key)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, { signal });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { dismissed = true; pinned = false; hide(); }
    }, { signal });
    document.addEventListener('pointerdown', (event) => {
      if (!button.contains(event.target) && !tooltip.contains(event.target)) {
        dismissed = true;
        pinned = false;
        hide();
      }
    }, { signal });
    document.addEventListener('scroll', () => { if (open) position(); }, { signal, capture: true });
    updates.set(row, update);
    observer.observe(row);
    update();
  }
  // A font can change badge widths without changing the row's content box.
  const refresh = () => { if (!signal.aborted) updates.forEach((update) => update()); };
  document.fonts?.ready.then(refresh);
  document.fonts?.addEventListener('loadingdone', refresh, { signal });
  return () => {
    controller.abort();
    observer.disconnect();
    tooltips.forEach((tooltip) => tooltip.remove());
  };
}

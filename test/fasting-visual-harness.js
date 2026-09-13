/** Focused rendered AA/overflow measurements; same color arithmetic as document guards. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseColor, composite, contrastRatio } from './document-guards-harness.js';

export async function measureFasting(page, selector, name, { viewport = false } = {}) {
  await page.$eval(selector, async (root) => {
    root.scrollIntoView({ block: 'center', behavior: 'instant' });
    const animations = document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // Scrolling can start reveal animations on the next IntersectionObserver turn.
    await Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => {})));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const samples = await page.$eval(selector, (root) => [...root.querySelectorAll('*')].filter((el) => {
    if (el.closest('[aria-hidden="true"], .sr-only') || el.matches(':disabled') || el.closest(':disabled')) return false;
    const r = el.getBoundingClientRect(), css = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && css.visibility !== 'hidden' && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  }).map((el) => {
    const css = getComputedStyle(el), layers = [];
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node); layers.push({ bg: style.backgroundColor, image: style.backgroundImage });
    }
    return { text: el.textContent.trim().slice(0, 60), color: css.color, size: parseFloat(css.fontSize), weight: Number(css.fontWeight), layers };
  }));
  const measured = samples.map((sample) => {
    let bg = [255, 255, 255, 1];
    let opaque = sample.layers.findIndex((layer) => parseColor(layer.bg)[3] >= 1);
    if (opaque < 0) opaque = sample.layers.length - 1;
    const stops = [];
    for (let i = opaque; i >= 0; i--) {
      const layer = sample.layers[i]; bg = composite(parseColor(layer.bg), bg);
      assert.doesNotMatch(layer.image, /url\(/, 'Text background image needs pixel-based inspection');
      stops.push(...[...layer.image.matchAll(/color\(srgb[^)]*\)|rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi)].map((m) => m[0]));
    }
    const ratio = Math.min(...[null, ...stops].map((stop) => {
      const under = stop ? composite(parseColor(stop), bg) : bg;
      return contrastRatio(composite(parseColor(sample.color), under), under);
    }));
    const minimum = sample.size >= 24 || sample.size >= 18.66 && sample.weight >= 700 ? 3 : 4.5;
    return { text: sample.text, size: sample.size, ratio, minimum };
  });
  const geometry = await page.$eval(selector, (root) => ({ width: root.clientWidth, scrollWidth: root.scrollWidth, viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  if (process.env.FASTING_SCREENSHOT_DIR) {
    mkdirSync(process.env.FASTING_SCREENSHOT_DIR, { recursive: true });
    writeFileSync(`${process.env.FASTING_SCREENSHOT_DIR}/${name}-measurements.json`, JSON.stringify({ geometry, measured }, null, 2));
    if (viewport) {
      await page.screenshot({ path: `${process.env.FASTING_SCREENSHOT_DIR}/${name}.png`, captureBeyondViewport: false });
    } else if (selector === '.fasting-container') {
      await captureFastingViewport(page, '.fasting-hero', name);
      await captureFastingViewport(page, '#history', `${name}-history`);
    } else {
      const root = await page.$(selector); await root.screenshot({ path: `${process.env.FASTING_SCREENSHOT_DIR}/${name}.png`, scrollIntoView: false, captureBeyondViewport: false });
    }
  }
  assert.ok(measured.length >= 3, 'Nonempty rendered text sample');
  assert.deepEqual(measured.filter((sample) => sample.ratio + 0.01 < sample.minimum), [], 'Rendered text meets AA');
  assert.ok(geometry.scrollWidth <= geometry.width + 1, 'Component has no horizontal overflow');
  assert.ok(geometry.documentWidth <= geometry.viewport, 'Document has no horizontal overflow');
  return { geometry, measured };
}

export async function captureFastingViewport(page, selector, name) {
  if (!process.env.FASTING_SCREENSHOT_DIR) return;
  await page.$eval(selector, async (root) => {
    root.scrollIntoView({ block: 'start', behavior: 'instant' });
    const toolbarBottom = document.querySelector('.page-toolbar')?.getBoundingClientRect().bottom || 0;
    for (let node = root.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) {
        node.scrollTop -= Math.max(0, toolbarBottom - root.getBoundingClientRect().top); break;
      }
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => {})));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  mkdirSync(process.env.FASTING_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.FASTING_SCREENSHOT_DIR}/${name}.png`, captureBeyondViewport: false });
}

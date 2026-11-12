// Entry point (named in knip.json).
import { escapeText } from './utils/y.js';

export const render = (/** @type {string} */ s) => escapeText(s);

// Fixture for test:lint-baseline: run with the real knip.json, it gives exactly six findings
// (comments in each file); package.json lists `left-pad`, which nothing imports (finding 6,
// knip/dependencies). Entry point named in knip.json.
import { used } from './services/x.js';
import { helper } from './services/unlisted.js';

export const start = () => used() + helper();

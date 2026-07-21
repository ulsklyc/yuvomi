# SortableJS (vendored)

- **Version:** 1.15.7
- **Source:** `modular/sortable.esm.js` from the [`sortablejs`](https://github.com/SortableJS/Sortable) npm package (MIT License), tarball `sortablejs-1.15.7.tgz` from the npm registry.
- **Build:** the upstream ESM module was minified locally with `npx terser --module --compress --mangle --comments false`, no bundler and no runtime CDN involved. The attribution header stays in `sortable.esm.min.js`.
- **Plugins included:** upstream mounts `AutoScrollPlugin` and the remove/revert-on-spill plugins by default inside `sortable.esm.js` - no extra plugin files needed for Yuvomi's use (single-column reorderable lists).
- **License:** MIT, full text in `LICENSE`.

## Usage

Import lazily wherever a sortable list is rendered, same pattern as `/vendor/pdfjs`:

```js
const { default: Sortable } = await import('/vendor/sortablejs/sortable.esm.min.js');
```

Do not import this module eagerly from app-shell code - it stays a per-page lazy import so pages that never render a reorderable list don't pay for it. Use the shared wrapper in `public/utils/sortable.js` instead of calling `Sortable.create()` directly, so touch/keyboard/reduced-motion conventions stay consistent project-wide.

## Updating

1. Fetch the new version's tarball from `https://registry.npmjs.org/sortablejs/-/sortablejs-<version>.tgz`.
2. Minify `modular/sortable.esm.js` with terser using the same flags as above.
3. Prepend the attribution header (version, source, sha512, license pointer) that already sits atop `sortable.esm.min.js`.
4. Replace `LICENSE` if it changed upstream, and bump the version in this README.

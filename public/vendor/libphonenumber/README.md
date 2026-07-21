# libphonenumber-js (self-hosted, gepinnt)

Self-gehostete, gepinnte ESM-Vendor-Kopie von [libphonenumber-js](https://gitlab.com/catamphetamine/libphonenumber-js)
— analog zu PDF.js/Lucide. **Kein Runtime-CDN, keine npm-Frontend-Dependency zur Laufzeit.**

| Datei | Zweck | Quelle |
|-------|-------|--------|
| `core.min.mjs` | Single-File-ESM-Bundle des **metadatenfreien** `libphonenumber-js/core` (nur `parsePhoneNumberFromString`, `AsYouType`, `isValidPhoneNumber`, `isPossiblePhoneNumber`). | Bundle aus npm `libphonenumber-js@1.11.20`, Export `libphonenumber-js/core`. |
| `metadata.min.json` | Metadaten (~85 KB) für Formatierung / AsYouType / E.164. Wird **zur Laufzeit separat geladen** und den `/core`-Funktionen als letztes Argument übergeben. | `node_modules/libphonenumber-js/metadata.min.json` (1:1). |
| `LICENSE` | MIT-Lizenz des Pakets. | `node_modules/libphonenumber-js/LICENSE`. |

Der Wrapper [`public/utils/phone.js`](../../utils/phone.js) ist der **einzige** Einstiegspunkt.
Er importiert `core.min.mjs` lazy (dynamic `import()`) und lädt `metadata.min.json` per `fetch()`
— nur im Kontaktmodul, memoisiert.

## Version aktualisieren / neu erzeugen

```bash
# 1) Paketversion pinnen (auch server-seitig genutzt für Phase 2 / E.164)
npm install libphonenumber-js@<version>

# 2) Metadaten 1:1 übernehmen
cp node_modules/libphonenumber-js/metadata.min.json public/vendor/libphonenumber/metadata.min.json
cp node_modules/libphonenumber-js/LICENSE            public/vendor/libphonenumber/LICENSE

# 3) core zu einer Single-File-ESM bundeln (esbuild einmalig via npx, kein Projekt-Bundler)
cat > _lpn-entry.mjs <<'EOF'
export { default as parsePhoneNumberFromString, AsYouType, isValidPhoneNumber, isPossiblePhoneNumber } from 'libphonenumber-js/core'
EOF
npx --yes esbuild _lpn-entry.mjs --bundle --format=esm --minify --legal-comments=none \
  --banner:js='/*! libphonenumber-js core bundle (self-hosted) | version <version> | source: libphonenumber-js/core | siehe README.md */' \
  --outfile=public/vendor/libphonenumber/core.min.mjs
rm -f _lpn-entry.mjs
```

Beim Versions-Bump zusätzlich: `public/sw.js` (Precache-Liste ist versions-gecacht) und die
Versionsangabe in Banner + dieser Tabelle nachziehen.

> Diese Vendor-Kopie ist von den Frontend-Guards (typography / frontend-audit / layer-boundary)
> ausgenommen — wie `public/vendor/pdfjs` und Lucide.

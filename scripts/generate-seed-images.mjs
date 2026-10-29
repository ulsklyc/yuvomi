/**
 * Modul: Demo-Bilder des Seeds erzeugen
 * Zweck: Die Bildbelege des Demo-Seeds (Kassenbons, Versichertenkarte) waren
 *        Klartext mit MIME-Typ image/jpeg - jede Vorschau und jeder Screenshot
 *        im Dokumente-Modul zeigte ein kaputtes Bild (R24, Critique G4 P2-1).
 *        Dieses Skript zeichnet sie einmal als kleine, echte JPEGs nach
 *        `scripts/seed-images/`; der Seed liest sie von dort (die Dateien sind
 *        eingecheckt, der Seed braucht `sharp` also nicht - es ist nur eine
 *        Entwicklungsabhaengigkeit).
 * Ausfuehren: node scripts/generate-seed-images.mjs
 *
 * Bewusst ohne Schrift: Linien und Flaechen statt Text, damit dasselbe Bild in
 * jeder Seed-Sprache stimmt und kein Font des Rechners in die Datei geraet.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'seed-images');

/* Ein Kassenbon: schmales Papier, Kopfblock, Positionszeilen, Summenstrich. */
function receiptSvg({ lines, seed }) {
  const W = 360; const H = 120 + lines * 26 + 120;
  const rows = [];
  for (let i = 0; i < lines; i++) {
    const y = 120 + i * 26;
    const left = 120 + ((i * 37 + seed * 11) % 90);
    rows.push(`<rect x="40" y="${y}" width="${left}" height="9" rx="2" fill="#6b6b6b"/>`);
    rows.push(`<rect x="${W - 100}" y="${y}" width="60" height="9" rx="2" fill="#6b6b6b"/>`);
  }
  const total = 120 + lines * 26 + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 80}" height="${H + 80}">
    <rect width="100%" height="100%" fill="#d9d4cb"/>
    <rect x="40" y="40" width="${W}" height="${H}" fill="#fbfaf7"/>
    <g transform="translate(40 40)">
      <rect x="${W / 2 - 70}" y="30" width="140" height="18" rx="3" fill="#2f2f2f"/>
      <rect x="${W / 2 - 100}" y="62" width="200" height="8" rx="2" fill="#9a9a9a"/>
      <rect x="${W / 2 - 80}" y="78" width="160" height="8" rx="2" fill="#9a9a9a"/>
      ${rows.join('\n')}
      <rect x="40" y="${total}" width="${W - 80}" height="2" fill="#2f2f2f"/>
      <rect x="40" y="${total + 16}" width="90" height="14" rx="2" fill="#2f2f2f"/>
      <rect x="${W - 120}" y="${total + 16}" width="80" height="14" rx="2" fill="#2f2f2f"/>
      <rect x="${W / 2 - 90}" y="${total + 56}" width="180" height="26" fill="#2f2f2f" opacity=".8"/>
    </g>
  </svg>`;
}

/* Eine Versichertenkarte: Kartenformat, Farbband, Chip, Namenszeilen. */
function cardSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420">
    <rect width="100%" height="100%" fill="#d9d4cb"/>
    <rect x="40" y="40" width="560" height="340" rx="24" fill="#f4f7f6"/>
    <path d="M40 64a24 24 0 0 1 24-24h512a24 24 0 0 1 24 24v56H40z" fill="#0f766e"/>
    <rect x="80" y="160" width="76" height="58" rx="8" fill="#c9a227"/>
    <rect x="80" y="250" width="260" height="16" rx="3" fill="#3a3a3a"/>
    <rect x="80" y="282" width="200" height="12" rx="3" fill="#8a8a8a"/>
    <rect x="80" y="306" width="230" height="12" rx="3" fill="#8a8a8a"/>
    <circle cx="520" cy="250" r="44" fill="#0f766e" opacity=".18"/>
  </svg>`;
}

mkdirSync(OUT, { recursive: true });
const jobs = [
  ['receipt_rewe.jpg', receiptSvg({ lines: 14, seed: 1 })],
  ['receipt_boots.jpg', receiptSvg({ lines: 5, seed: 2 })],
  ['insurance_card.jpg', cardSvg()],
];
for (const [name, svg] of jobs) {
  await sharp(Buffer.from(svg)).jpeg({ quality: 72, mozjpeg: true }).toFile(join(OUT, name));
  console.log('wrote', name);
}

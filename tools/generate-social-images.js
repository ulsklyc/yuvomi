#!/usr/bin/env node
import sharp from 'sharp';
import { readFileSync } from 'fs';

const SCREENSHOT = 'docs/screenshots/dashboard-light-web.png';
const BG_COLOR = '#1A1A28';

// Social image dimensions
const DIMENSIONS = {
  'og-image.png': { width: 1200, height: 630 },
  'twitter-image.png': { width: 1200, height: 675 },
  'social-preview.png': { width: 1280, height: 640 }
};

async function createSocialImage(filename, width, height) {
  // Load and resize screenshot to fit right side (60% of width)
  const screenshotWidth = Math.floor(width * 0.55);
  const screenshotHeight = Math.floor(height * 0.7);

  const screenshot = await sharp(SCREENSHOT)
    .resize(screenshotWidth, screenshotHeight, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .toBuffer();

  // Create SVG with text and layout
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <!-- Background -->
      <rect width="${width}" height="${height}" fill="${BG_COLOR}"/>

      <!-- Left side content area -->
      <g transform="translate(60, ${height / 2 - 120})">
        <!-- Logo badge -->
        <rect x="0" y="0" width="160" height="28" rx="4" fill="#0A84FF" opacity="0.15"/>
        <text x="12" y="19" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="600" fill="#0A84FF" letter-spacing="0.5">
          SELF-HOSTED · OPEN SOURCE
        </text>

        <!-- Title -->
        <text x="0" y="80" font-family="system-ui, -apple-system, sans-serif" font-size="64" font-weight="700" fill="#FFFFFF">
          Yuvomi
        </text>

        <!-- Description -->
        <text x="0" y="130" font-family="system-ui, -apple-system, sans-serif" font-size="18" fill="#B0B0B8" font-weight="400">
          <tspan x="0" dy="0">The family planner that respects your</tspan>
          <tspan x="0" dy="28">privacy. Tasks, calendars, shopping, meals,</tspan>
          <tspan x="0" dy="28">budget — on your own server.</tspan>
        </text>

        <!-- Feature badges -->
        <g transform="translate(0, 240)">
          <g>
            <rect x="0" y="0" width="90" height="32" rx="6" fill="#2A2A38"/>
            <text x="12" y="21" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="500" fill="#8E8E93">✓ Tasks</text>
          </g>
          <g transform="translate(100, 0)">
            <rect x="0" y="0" width="110" height="32" rx="6" fill="#2A2A38"/>
            <text x="12" y="21" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="500" fill="#8E8E93">📅 Calendar</text>
          </g>
          <g transform="translate(220, 0)">
            <rect x="0" y="0" width="110" height="32" rx="6" fill="#2A2A38"/>
            <text x="12" y="21" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="500" fill="#8E8E93">🛒 Shopping</text>
          </g>
          <g transform="translate(340, 0)">
            <rect x="0" y="0" width="90" height="32" rx="6" fill="#2A2A38"/>
            <text x="12" y="21" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="500" fill="#8E8E93">🍽 Meals</text>
          </g>
        </g>
      </g>
    </svg>
  `;

  // Position screenshot on the right side
  const screenshotX = width - screenshotWidth - 40;
  const screenshotY = Math.floor((height - screenshotHeight) / 2);

  // Composite everything together
  const image = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: BG_COLOR
    }
  })
  .composite([
    {
      input: Buffer.from(svg),
      top: 0,
      left: 0
    },
    {
      input: screenshot,
      top: screenshotY,
      left: screenshotX
    }
  ])
  .png()
  .toFile(`docs/${filename}`);

  console.log(`✓ Created docs/${filename} (${width}x${height})`);
}

async function main() {
  console.log('Generating social preview images...\n');

  for (const [filename, { width, height }] of Object.entries(DIMENSIONS)) {
    await createSocialImage(filename, width, height);
  }

  console.log('\n✓ All social images generated successfully!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

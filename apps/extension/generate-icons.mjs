// Generates simple PNG icons from canvas
// Run: node generate-icons.mjs
// Creates icon16.png, icon48.png, icon128.png

import fs from 'fs';
import path from 'path';

// We'll generate SVG files and use them directly for development
// For production, convert these to PNG

const sizes = [16, 48, 128];

for (const size of sizes) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6366f1"/>
      <stop offset="100%" style="stop-color:#8b5cf6"/>
    </linearGradient>
  </defs>
  <circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="url(#grad)"/>
  <text x="${size/2}" y="${size * 0.68}" font-family="Arial,sans-serif" font-weight="bold" font-size="${size * 0.55}" fill="white" text-anchor="middle">S</text>
</svg>`;

  fs.writeFileSync(path.join('icons', `icon${size}.svg`), svg);
}

console.log('SVG icons generated in icons/');
console.log('Note: Chrome MV3 requires PNG icons. For now, we use SVGs for development.');
console.log('To convert: use any SVG-to-PNG tool or imagemagick: convert icon128.svg icon128.png');

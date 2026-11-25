'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createPng(width, height, pixelFn) {
  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = makeChunk('IHDR', ihdrData);

  const raw = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // Filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      raw[offset++] = Math.round(Math.min(255, Math.max(0, r)));
      raw[offset++] = Math.round(Math.min(255, Math.max(0, g)));
      raw[offset++] = Math.round(Math.min(255, Math.max(0, b)));
      raw[offset++] = Math.round(Math.min(255, Math.max(0, a)));
    }
  }

  const idatData = zlib.deflateSync(raw, { level: 9 });
  const idat = makeChunk('IDAT', idatData);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([header, ihdr, idat, iend]);
}

// Distance to rounded rectangle
function sdRoundBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.min(Math.max(qx, qy), 0.0) + Math.hypot(Math.max(qx, 0.0), Math.max(qy, 0.0)) - r;
}

// Smooth heart shape SDF
function sdHeart(px, py) {
  // px in [-1, 1], py in [-1, 1] (y pointing up)
  px = Math.abs(px);
  if (py + px > 1.0) {
    return Math.hypot(px - 0.5, py - 0.5) - 0.5 * Math.SQRT2;
  }
  return Math.max(px + py - 1.0, -py - 0.5);
}

// Render app icon pixel
function getIconPixel(x, y, size, isMaskable) {
  const nx = (x / (size - 1)) * 2 - 1; // [-1, 1]
  const ny = -((y / (size - 1)) * 2 - 1); // [-1, 1], y up

  // Base background: Deep gradient #0d081e -> #221244
  const gradT = (y / size);
  const bgR = 13 + gradT * (34 - 13);
  const bgG = 8 + gradT * (18 - 8);
  const bgB = 30 + gradT * (68 - 30);

  if (isMaskable) {
    // Maskable icon fills the entire canvas
    // Safe area is within central 80%
    const scale = 0.58;
    const hx = nx / scale;
    const hy = (ny + 0.08) / scale;
    const dHeart = sdHeart(hx, hy);

    // Heart fill
    if (dHeart <= 0) {
      // Radiant rose-to-pink gradient with subtle 3D highlight
      const ht = (hy + 1) / 2;
      const hr = 244 + ht * (255 - 244);
      const hg = 63 + ht * (130 - 63);
      const hb = 120 + ht * (175 - 120);
      return [hr, hg, hb, 255];
    } else if (dHeart < 0.12) {
      // Glow aura around heart
      const glow = (1 - dHeart / 0.12);
      const gr = bgR * (1 - glow) + 236 * glow;
      const gg = bgG * (1 - glow) + 72 * glow;
      const gb = bgB * (1 - glow) + 153 * glow;
      return [gr, gg, gb, 255];
    }

    return [bgR, bgG, bgB, 255];
  }

  // Non-maskable: Modern rounded squircle badge
  const boxDist = sdRoundBox(nx, ny, 0.88, 0.88, 0.38);
  if (boxDist > 0.02) {
    return [0, 0, 0, 0]; // Transparent outer edge
  }

  // Anti-aliased outer border
  const alpha = boxDist <= 0 ? 1 : Math.max(0, 1 - (boxDist / 0.02));

  // Vibrant gradient badge
  const badgeR = 124 - gradT * 40; // Violet/Indigo #7c3aed
  const badgeG = 58 + gradT * 20;
  const badgeB = 237 - gradT * 50;

  // Draw heart in center
  const scale = 0.52;
  const hx = nx / scale;
  const hy = (ny + 0.08) / scale;
  const dHeart = sdHeart(hx, hy);

  if (dHeart <= 0) {
    // Pure white to rose-tinted heart
    const ht = (hy + 1) / 2;
    const hr = 255;
    const hg = 250 - (1 - ht) * 30;
    const hb = 255 - (1 - ht) * 20;
    return [hr, hg, hb, 255 * alpha];
  } else if (dHeart < 0.15) {
    // Subtle inner glowing border
    const glow = (1 - dHeart / 0.15) * 0.45;
    const r = badgeR * (1 - glow) + 255 * glow;
    const g = badgeG * (1 - glow) + 255 * glow;
    const b = badgeB * (1 - glow) + 255 * glow;
    return [r, g, b, 255 * alpha];
  }

  return [badgeR, badgeG, badgeB, 255 * alpha];
}

const iconsDir = path.join(__dirname, '../client/icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

console.log('Generating 192x192 icon...');
const icon192 = createPng(192, 192, (x, y) => getIconPixel(x, y, 192, false));
fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), icon192);

console.log('Generating 512x512 icon...');
const icon512 = createPng(512, 512, (x, y) => getIconPixel(x, y, 512, false));
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), icon512);

console.log('Generating 512x512 maskable icon...');
const iconMaskable = createPng(512, 512, (x, y) => getIconPixel(x, y, 512, true));
fs.writeFileSync(path.join(iconsDir, 'icon-maskable-512.png'), iconMaskable);

// Also generate a clean SVG icon
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#8b5cf6"/>
      <stop offset="50%" stop-color="#ec4899"/>
      <stop offset="100%" stop-color="#f43f5e"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="16" stdDeviation="24" flood-color="#ec4899" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="128" fill="url(#bgGrad)"/>
  <path d="M256 420s-150-92-150-200c0-62 50-104 104-104 36 0 58 18 46 36 0 0 10-36 46-36 54 0 104 42 104 104 0 108-150 200-150 200z" 
        fill="#ffffff" 
        filter="url(#shadow)"/>
</svg>`;
fs.writeFileSync(path.join(iconsDir, 'icon.svg'), svgContent);

console.log('Icons generated successfully in client/icons:');
console.log('- icon-192.png:', icon192.length, 'bytes');
console.log('- icon-512.png:', icon512.length, 'bytes');
console.log('- icon-maskable-512.png:', iconMaskable.length, 'bytes');
console.log('- icon.svg:', svgContent.length, 'bytes');

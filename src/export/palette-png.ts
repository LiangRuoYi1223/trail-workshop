import { deflateSync } from 'node:zlib';
import { crc32 } from './zip.js';

function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 4, 'ascii');
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, data.length + 8)), data.length + 8);
  return bytes;
}

/** Exact opaque RGB swatches. This reference image adds neither gradients nor extra colors. */
export function writePalettePng(colors: readonly string[]): Buffer {
  if (!colors.length || colors.length > 6 || colors.some(color => !/^#[0-9a-f]{6}$/i.test(color))
    || new Set(colors.map(color => color.toLowerCase())).size !== colors.length) {
    throw new Error('调色板图片需要一至六种唯一 RGB 颜色');
  }
  const swatch = 16, width = colors.length * swatch, height = swatch;
  const rgb = colors.map(color => Buffer.from(color.slice(1), 'hex'));
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) {
    const start = row * (width * 3 + 1);
    for (let column = 0; column < width; column++) rgb[Math.floor(column / swatch)]!.copy(scanlines, start + 1 + column * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

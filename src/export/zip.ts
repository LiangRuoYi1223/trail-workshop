import { deflateRawSync } from 'node:zlib';

export interface ZipEntry { name: string; data: Buffer | string }

const crcTable = new Uint32Array(256);
for (let byte = 0; byte < 256; byte++) {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  crcTable[byte] = value >>> 0;
}

/** CRC-32/ISO-HDLC, used by both ZIP and PNG. */
export function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** A deterministic UTF-8 ZIP with ordinary deflate entries, without encryption or ZIP64. */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error('ZIP 包中的文件过多');
  const localParts: Buffer[] = [], centralParts: Buffer[] = [];
  const names = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    if (!entry.name || entry.name.includes('\\') || entry.name.includes('\0') || entry.name.startsWith('/') || /^[a-z]:/i.test(entry.name)
      || entry.name.split('/').some(part => !part || part === '.' || part === '..') || names.has(entry.name)) {
      throw new Error('ZIP 文件名称无效或重复');
    }
    names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    if (name.length > 0xffff || data.length > 0xffffffff) throw new Error('ZIP 文件过大');
    const compressed = deflateRawSync(data, {level: 6});
    if (compressed.length > 0xffffffff) throw new Error('ZIP 压缩文件过大');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12); // 1980-01-01, a fixed legal DOS date.
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
    if (offset > 0xffffffff) throw new Error('ZIP 包过大');
  }
  const central = Buffer.concat(centralParts);
  if (central.length > 0xffffffff || offset + central.length + 22 > 0xffffffff) throw new Error('ZIP 包过大');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

/**
 * @typedef {{name:string, data:Buffer|string}} ZipEntryInput
 */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let j = 0; j < 8; j += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} bytes
 */
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * @param {Date} date
 */
function toDosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = Math.floor(date.getUTCSeconds() / 2);
  const dosTime = (hour << 11) | (minute << 5) | second;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

/**
 * @param {ZipEntryInput[]} entries
 * @param {{mtime?: Date}} [opts]
 */
export function createDeterministicZip(entries, opts = {}) {
  const mtime = opts.mtime ?? new Date('1980-01-01T00:00:00.000Z');
  const { dosTime, dosDate } = toDosDateTime(mtime);
  const normalized = entries
    .map((entry) => ({
      name: entry.name,
      nameBytes: Buffer.from(entry.name, 'utf8'),
      data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const parts = [];
  const centralDirectory = [];
  let offset = 0;

  for (const entry of normalized) {
    const crc = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(entry.nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    parts.push(localHeader, entry.nameBytes, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(entry.nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectory.push(centralHeader, entry.nameBytes);

    offset += localHeader.length + entry.nameBytes.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(centralDirectory);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(normalized.length, 8);
  eocd.writeUInt16LE(normalized.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuffer, eocd]);
}

/**
 * @param {Buffer} zip
 */
export function listZipEntries(zip) {
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) !== 0x06054b50) continue;
    const total = zip.readUInt16LE(i + 10);
    const centralOffset = zip.readUInt32LE(i + 16);
    const entries = [];
    let pointer = centralOffset;
    for (let index = 0; index < total; index += 1) {
      if (zip.readUInt32LE(pointer) !== 0x02014b50) {
        throw new Error('invalid_zip_central_directory');
      }
      const compressedSize = zip.readUInt32LE(pointer + 20);
      const size = zip.readUInt32LE(pointer + 24);
      const nameLength = zip.readUInt16LE(pointer + 28);
      const extraLength = zip.readUInt16LE(pointer + 30);
      const commentLength = zip.readUInt16LE(pointer + 32);
      const crc = zip.readUInt32LE(pointer + 16);
      const name = zip.toString('utf8', pointer + 46, pointer + 46 + nameLength);
      entries.push({ name, size, compressed_size: compressedSize, crc32: crc });
      pointer += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }
  throw new Error('invalid_zip_eocd_missing');
}

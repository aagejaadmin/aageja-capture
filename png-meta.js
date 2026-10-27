'use strict';
/**
 * PNG text metadata. Writes iTXt chunks (UTF-8) just before IEND and reads
 * them back. No dependencies.
 *
 * Keywords written by the capture service: Title, Description, Alt, Screen,
 * Source, Captured, Elements, Environment, Software. Writing a keyword that is
 * already present replaces it, so a refreshed image never carries two values.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** Splits a PNG into its chunks. Throws on anything that is not a PNG. */
function readChunks(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Not a PNG file');
  }
  const chunks = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const end = off + 12 + len;
    if (end > buf.length) throw new Error('Truncated PNG chunk ' + type);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len), raw: buf.subarray(off, end) });
    off = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** Width and height from IHDR. */
function dimensions(buf) {
  const ihdr = readChunks(buf).find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG has no IHDR');
  return { width: ihdr.data.readUInt32BE(0), height: ihdr.data.readUInt32BE(4) };
}

function keywordOf(chunk) {
  const nul = chunk.data.indexOf(0);
  return nul > 0 ? chunk.data.toString('latin1', 0, nul) : '';
}

function iTXt(keyword, text) {
  // keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
  return makeChunk('iTXt', Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0, 0, 0, 0, 0]),
    Buffer.from(String(text), 'utf8'),
  ]));
}

/**
 * Returns a new PNG buffer carrying the given metadata. Empty values are
 * skipped. Existing text chunks with the same keywords are removed first.
 */
function embed(buf, meta) {
  const entries = Object.entries(meta || {})
    .filter(([k, v]) => /^[\x20-\x7e]{1,79}$/.test(k) && v !== undefined && v !== null && String(v).trim() !== '');
  const replacing = new Set(entries.map(([k]) => k));
  const out = [SIGNATURE];
  for (const c of readChunks(buf)) {
    if ((c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') && replacing.has(keywordOf(c))) continue;
    if (c.type === 'IEND') for (const [k, v] of entries) out.push(iTXt(k, v));
    out.push(c.raw);
  }
  return Buffer.concat(out);
}

/** Reads tEXt and uncompressed iTXt chunks into an object. */
function read(buf) {
  const meta = {};
  for (const c of readChunks(buf)) {
    if (c.type === 'tEXt') {
      const nul = c.data.indexOf(0);
      if (nul > 0) meta[c.data.toString('latin1', 0, nul)] = c.data.toString('latin1', nul + 1);
    } else if (c.type === 'iTXt') {
      const nul = c.data.indexOf(0);
      if (nul <= 0 || c.data[nul + 1] !== 0) continue; // compressed iTXt not read
      let p = nul + 3;
      p = c.data.indexOf(0, p) + 1; // language tag
      p = c.data.indexOf(0, p) + 1; // translated keyword
      meta[c.data.toString('latin1', 0, nul)] = c.data.toString('utf8', p);
    }
  }
  return meta;
}

module.exports = { embed, read, dimensions, crc32 };

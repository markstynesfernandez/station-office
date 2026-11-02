// PORTED from Virtual-workers/station/scripts/lib/zip.mjs (the owner's own code) at 16/10/2026 19:16 Irish time, source sha256 0b7f5008ed2f338437e38a5e35fe925ab0211001e1e38b87d5720ebd0c92bea8.
//   change: none
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// zip.mjs (lib) — the station's own minimal ZIP writer and reader for digital deliverables (owner go 2026-10-16: one zip of the props).
// No dependency. Writer: flat entries (no folders), fixed timestamp 1980-01-01 00:00 and fixed attributes, deflate only where it is smaller,
// so the same files always give the same bytes (idempotent builds; the manifest sha256 stays stable). Reader: refuses anything the writer
// would not make or a buyer's unzip could trip on (encryption, zip64, folders or paths, duplicate names, unknown methods, CRC or size
// mismatches, a total over maxTotalBytes), so the package gate can measure what is inside before anything is sold.
import zlib from 'node:zlib';

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;   // 1980-01-01 00:00:00
export const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

// entries: [{ name, data: Buffer }] -> Buffer. Names must be flat, plain and unique; order is kept (callers sort).
export function writeZip(entries) {
  const seen = new Set(), locals = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = String(e.name);
    if (!SAFE_NAME.test(name) || name.includes('..')) throw new Error('zip entry name not allowed: ' + JSON.stringify(name));
    if (seen.has(name.toLowerCase())) throw new Error('duplicate zip entry name: ' + name);
    seen.add(name.toLowerCase());
    const data = Buffer.from(e.data), crc = crc32(data), def = zlib.deflateRawSync(data, { level: 9 }), useDef = def.length < data.length;
    const body = useDef ? def : data, method = useDef ? 8 : 0, nb = Buffer.from(name, 'latin1');
    if (offset + 30 + nb.length + body.length > 0xfffffffe || data.length > 0xfffffffe) throw new Error('zip too large for a plain (non-zip64) archive');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nb, body); central.push(ch, nb);
    offset += 30 + nb.length + body.length;
  }
  if (entries.length > 0xfffe) throw new Error('too many zip entries');
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

// Buffer -> { ok, entries: [{ name, method, compressedBytes, data }], problems[] }. Never throws on bad input.
export function readZip(buf, { maxTotalBytes = 1e9, maxEntries = 1000 } = {}) {
  const problems = [], entries = [];
  const fail = (m) => ({ ok: false, entries: [], problems: [...problems, m] });
  if (!Buffer.isBuffer(buf) || buf.length < 22) return fail('not a zip archive (too short)');
  let eo = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
  if (eo < 0) return fail('not a zip archive (no end-of-central-directory record)');
  const disk = buf.readUInt16LE(eo + 4), cdDisk = buf.readUInt16LE(eo + 6), nThis = buf.readUInt16LE(eo + 8), n = buf.readUInt16LE(eo + 10), cdSize = buf.readUInt32LE(eo + 12), cdOff = buf.readUInt32LE(eo + 16);
  if (disk !== 0 || cdDisk !== 0 || nThis !== n) return fail('multi-part zip archives are not supported');
  if (n === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) return fail('zip64 archives are not supported');
  if (n > maxEntries) return fail('zip has ' + n + ' entries (max ' + maxEntries + ')');
  if (cdOff + cdSize > eo) return fail('zip central directory is out of bounds');
  let p = cdOff, total = 0;
  const names = new Set();
  for (let k = 0; k < n; k++) {
    if (p + 46 > eo || buf.readUInt32LE(p) !== 0x02014b50) return fail('zip central directory entry ' + (k + 1) + ' is damaged');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('latin1');
    p += 46 + nl + xl + cl;
    if (flags & 1) { problems.push(name + ': encrypted entries are not allowed'); continue; }
    if (name.endsWith('/')) { problems.push(name + ': folders inside the zip are not allowed (flat files only)'); continue; }
    if (!SAFE_NAME.test(name) || name.includes('..')) { problems.push(JSON.stringify(name) + ': entry name not allowed (flat, plain names only: no folders or paths)'); continue; }
    if (names.has(name.toLowerCase())) { problems.push(name + ': duplicate entry name'); continue; }
    names.add(name.toLowerCase());
    if (method !== 0 && method !== 8) { problems.push(name + ': compression method ' + method + ' is not supported (store or deflate only)'); continue; }
    total += usize;
    if (total > maxTotalBytes) return fail('zip contents exceed ' + maxTotalBytes + ' bytes uncompressed');
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) { problems.push(name + ': local header is damaged'); continue; }
    const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (ds + csize > buf.length) { problems.push(name + ': data is out of bounds'); continue; }
    let data;
    try { data = method === 8 ? zlib.inflateRawSync(buf.subarray(ds, ds + csize), { maxOutputLength: Math.max(1, usize) }) : Buffer.from(buf.subarray(ds, ds + csize)); }
    catch (e) { problems.push(name + ': could not be decompressed (' + e.code + ')'); continue; }
    if (data.length !== usize) { problems.push(name + ': size ' + data.length + ' differs from the recorded ' + usize); continue; }
    if (crc32(data) !== crc) { problems.push(name + ': CRC check failed (damaged data)'); continue; }
    entries.push({ name, method, compressedBytes: csize, data });
  }
  return { ok: problems.length === 0, entries, problems };
}

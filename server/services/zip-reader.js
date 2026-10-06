/**
 * Module: Hand-written ZIP reader
 * Purpose: Read an uploaded or downloaded module archive into memory, file by file,
 *          and refuse everything a module archive has no business containing.
 * Dependencies: node:zlib (no third-party unzip library - CONTRIBUTING.md forbids new
 *               dependencies, and the subset a module needs is small).
 *
 * WHY SO STRICT. The archive comes from an admin, but its CONTENT comes from whoever
 * built it. A generic unzip library is written to extract what it can; this reader is
 * written to extract only what it can prove is harmless and to name the reason for
 * everything else. Each rejection has a stable `code` the route turns into an HTTP
 * status and the UI into a localized message.
 *
 * WHAT IT READS. Only the central directory is trusted for the file list; the local
 * header is read just to find where the data starts (`30 + nameLen + extraLen`).
 * That is what every mainstream unzip does, and it avoids the classic confusion
 * where local and central headers disagree about a name.
 *
 * WHAT IT DOES NOT SUPPORT, ON PURPOSE: ZIP64, multi-disk archives, encryption and
 * every compression method except stored (0) and deflate (8). A module is a few
 * hundred kilobytes of JavaScript; an archive that needs any of those is either not a
 * module or crafted.
 */

import zlib from 'node:zlib';

const MiB = 1024 * 1024;

export const ZIP_LIMITS = Object.freeze({
  maxCompressed: 20 * MiB,
  maxEntries: 2000,
  maxFileSize: 10 * MiB,
  maxTotal: 50 * MiB,
  // Deflate reaches about 1000:1 on runs of zeros; real JavaScript and images sit
  // far below 20:1. The ratio only counts above 1 MiB, so a tiny file that happens
  // to compress well (an empty JSON array, a license text) never trips it.
  maxRatio: 200,
  ratioThreshold: 1 * MiB,
  // Folders per entry name. Every limit above counts bytes of content; this one
  // bounds the work the NAME causes. The duplicate check below collects every
  // folder prefix of every entry in a Set, and a 1024-character name holds about
  // 510 one-letter folders: 2000 such names (the entry limit, 4 MB of archive)
  // made 1,020,000 keys, 570 MB of heap and 5 s of blocked event loop. A module
  // sits two or three folders deep; sixteen is more than any real one needs.
  maxDepth: 16,
});

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const HOST_UNIX = 3;

// Device names Windows resolves in every folder, whatever the extension. The
// superscript digits are real: Win32 treats COM¹ like COM1. CONIN$/CONOUT$ are
// the console handles.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
// Characters Win32 refuses in a file name. On Linux they are legal, but a module
// is meant to be copyable to any server, and `?`/`*` in a name are wildcards to
// half the tools an admin would inspect the folder with.
const WINDOWS_ILLEGAL_CHARS = /[<>"|?*]/;
// `LONGFI~1.JS` is the 8.3 short-name alias of some other file on NTFS: writing
// it can land on a file the validator saw under its long name.
const SHORT_NAME_ALIAS = /~\d/;

/**
 * Whether `name` (one path segment, extension included or not) is a device
 * name Windows resolves in every folder. Shared with the installer, where a
 * module id becomes a folder name under modules/ and the same list applies.
 */
export function isWindowsReservedName(name) {
  return WINDOWS_RESERVED.test(String(name).split('.')[0]);
}

export class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

// zlib.crc32 exists since Node 22.2 / 20.15. The table is the fallback for the
// oldest runtime package.json still allows, not the expected path.
let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function looksLikeZip64(buf, pos) {
  return buf.readUInt16LE(pos + 4) === 0xffff || buf.readUInt16LE(pos + 6) === 0xffff
    || buf.readUInt16LE(pos + 8) === 0xffff || buf.readUInt16LE(pos + 10) === 0xffff
    || buf.readUInt32LE(pos + 12) === 0xffffffff || buf.readUInt32LE(pos + 16) === 0xffffffff
    || (pos >= 20 && buf.readUInt32LE(pos - 20) === SIG_ZIP64_LOCATOR);
}

/**
 * Finds THE end-of-central-directory record, or throws.
 *
 * Four bytes of signature prove nothing: the same bytes can sit in the archive
 * comment or inside stored file data, and a crafted archive can carry two
 * plausible records so that different unzip tools see different file lists (the
 * reviewer sees one module, the server installs another). So the whole tail
 * window is scanned and a candidate counts only if
 *   - its comment ends exactly at EOF, and
 *   - its central directory ends exactly where the record starts
 *     (cdOffset + cdSize === position).
 * The second rule also refuses archives with data prepended (self-extractors),
 * which a module never needs. More than one valid candidate is ambiguous and
 * refused outright instead of guessing.
 */
function findEocd(buf) {
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  const valid = [];
  let sawCandidate = false;
  let sawZip64 = false;
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    if (i + 22 + buf.readUInt16LE(i + 20) !== buf.length) continue;
    sawCandidate = true;
    if (buf.readUInt32LE(i + 16) + buf.readUInt32LE(i + 12) === i) {
      valid.push(i);
    } else if (looksLikeZip64(buf, i)) {
      // A ZIP64 archive keeps the real offsets elsewhere; its classic record
      // carries sentinels and never lines up. Name the actual reason.
      sawZip64 = true;
    }
  }
  if (valid.length > 1) throw new ZipError('corrupt', 'The archive has more than one end record and is ambiguous.');
  if (valid.length === 1) return valid[0];
  if (sawZip64) throw new ZipError('zip64', 'ZIP64 archives are not supported.');
  if (sawCandidate) throw new ZipError('corrupt', 'The archive directory does not line up with its end record.');
  return -1;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeName(bytes, flags) {
  if (flags & FLAG_UTF8) {
    try {
      return utf8Decoder.decode(bytes);
    } catch {
      throw new ZipError('unsafe_path', 'An archive entry name is not valid UTF-8.');
    }
  }
  // Without the UTF-8 flag the name is in some legacy code page (CP437 by the
  // spec, whatever the packer's locale was in practice). Guessing would let the
  // same bytes become different file names on different servers, so non-ASCII
  // names without the flag are refused.
  for (const b of bytes) {
    if (b >= 0x80) throw new ZipError('unsafe_path', 'An archive entry name uses non-ASCII characters without the UTF-8 flag.');
  }
  return bytes.toString('latin1');
}

/**
 * Normalizes an entry name to forward slashes and refuses anything that could
 * leave the extraction folder or mean something special to a filesystem.
 * Returns `{ path, isDir }`.
 */
export function validateEntryName(rawName) {
  const unsafe = (why) => new ZipError('unsafe_path', `Unsafe path in archive (${why}): ${JSON.stringify(rawName).slice(0, 120)}`);
  const name = rawName.replace(/\\/g, '/');
  if (!name) throw unsafe('empty name');
  if (name.length > 1024) throw unsafe('name too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw unsafe('control character');
  // `:` covers drive letters (C:), NTFS alternate data streams (file:stream) and
  // the odd URL-ish name; none of them is a legitimate module path.
  if (name.includes(':')) throw unsafe('colon');
  if (WINDOWS_ILLEGAL_CHARS.test(name)) throw unsafe('character not allowed in file names');
  // A leading slash is an absolute path; two of them is a UNC path.
  if (name.startsWith('/')) throw unsafe('absolute path');
  const isDir = name.endsWith('/');
  const body = isDir ? name.slice(0, -1) : name;
  const segments = body.split('/');
  // Before the per-segment checks and long before the prefix set in
  // readZipArchive: a name this deep is refused at the first entry that
  // carries one, with nothing allocated for it.
  if (segments.length > ZIP_LIMITS.maxDepth) throw unsafe(`more than ${ZIP_LIMITS.maxDepth} folders deep`);
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') throw unsafe('empty or relative segment');
    if (seg.length > 255) throw unsafe('segment too long');
    // Windows strips a trailing dot or space, so `index.js.` would silently land
    // on `index.js` - a second name for a file the validator already saw.
    if (/[. ]$/.test(seg)) throw unsafe('trailing dot or space');
    if (isWindowsReservedName(seg)) throw unsafe('reserved device name');
    if (SHORT_NAME_ALIAS.test(seg)) throw unsafe('8.3 short-name alias');
  }
  return { path: body, isDir };
}

/**
 * Reads a ZIP archive. Returns `{ files: [{ name, data }], comment }` with files
 * only (directory entries are dropped). Throws ZipError on anything it refuses.
 */
export function readZipArchive(buffer, limits = {}) {
  const lim = { ...ZIP_LIMITS, ...limits };
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new ZipError('not_zip', 'The file is not a ZIP archive.');
  }
  if (buffer.length > lim.maxCompressed) {
    throw new ZipError('too_large', 'The archive is too large.');
  }

  const eocd = findEocd(buffer);
  if (eocd < 0) throw new ZipError('not_zip', 'The file is not a ZIP archive.');
  // findEocd only returns a record whose directory ends right before it, so the
  // `cdOffset + cdSize > eocd` check below cannot fire for it any more. It stays
  // as a cheap second lock in case the search rule is ever relaxed.

  const diskNo = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const commentLen = buffer.readUInt16LE(eocd + 20);

  if (diskNo === 0xffff || cdDisk === 0xffff || entriesOnDisk === 0xffff || totalEntries === 0xffff
    || cdSize === 0xffffffff || cdOffset === 0xffffffff
    || (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR)) {
    throw new ZipError('zip64', 'ZIP64 archives are not supported.');
  }
  if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ZipError('corrupt', 'Multi-part (split) archives are not supported.');
  }
  if (totalEntries > lim.maxEntries) {
    throw new ZipError('too_many_entries', `The archive has more than ${lim.maxEntries} entries.`);
  }
  if (cdOffset + cdSize > eocd) {
    throw new ZipError('corrupt', 'The archive directory points outside the file.');
  }

  const comment = buffer.subarray(eocd + 22, eocd + 22 + commentLen).toString('latin1');

  const entries = [];
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let declaredTotal = 0;
  for (let n = 0; n < totalEntries; n += 1) {
    if (p + 46 > cdEnd || buffer.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipError('corrupt', 'The archive directory is damaged.');
    }
    const madeBy = buffer.readUInt16LE(p + 4);
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const csize = buffer.readUInt32LE(p + 20);
    const usize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const fileCommentLen = buffer.readUInt16LE(p + 32);
    const diskStart = buffer.readUInt16LE(p + 34);
    const externalAttr = buffer.readUInt32LE(p + 38);
    const localOffset = buffer.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + fileCommentLen;
    if (next > cdEnd) throw new ZipError('corrupt', 'The archive directory is damaged.');

    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff || diskStart === 0xffff) {
      throw new ZipError('zip64', 'ZIP64 archives are not supported.');
    }
    if (diskStart !== 0) throw new ZipError('corrupt', 'Multi-part (split) archives are not supported.');

    const rawName = decodeName(buffer.subarray(p + 46, p + 46 + nameLen), flags);
    const { path: name, isDir } = validateEntryName(rawName);

    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw new ZipError('encrypted', `Encrypted archive entries are not supported: ${name}`);
    }

    if ((madeBy >> 8) === HOST_UNIX) {
      const type = (externalAttr >>> 16) & S_IFMT;
      if (type === S_IFLNK) throw new ZipError('symlink', `Symbolic links are not allowed in a module archive: ${name}`);
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) {
        throw new ZipError('unsafe_path', `Special files are not allowed in a module archive: ${name}`);
      }
    }

    if (!isDir) {
      if (method !== 0 && method !== 8) {
        throw new ZipError('method', `Unsupported compression method ${method} for ${name}. Use deflate or store.`);
      }
      if (method === 0 && csize !== usize) {
        throw new ZipError('corrupt', `Stored entry has inconsistent sizes: ${name}`);
      }
      if (usize > lim.maxFileSize) {
        throw new ZipError('too_large', `A file in the archive is too large: ${name}`);
      }
      declaredTotal += usize;
      if (declaredTotal > lim.maxTotal) {
        throw new ZipError('bomb', 'The archive unpacks to more data than allowed.');
      }
      if (usize > lim.ratioThreshold && usize / Math.max(csize, 1) > lim.maxRatio) {
        throw new ZipError('bomb', `Suspicious compression ratio for ${name}.`);
      }
      // The per-file ratio misses many files that each stay under the 1 MiB
      // threshold (49 × 1 MiB of zeros is about 50 KB packed). The whole
      // archive against its own size closes that gap with the same limit.
      if (declaredTotal > lim.ratioThreshold && declaredTotal / buffer.length > lim.maxRatio) {
        throw new ZipError('bomb', 'Suspicious compression ratio for the archive as a whole.');
      }
    }

    entries.push({ name, isDir, flags, method, crc, csize, usize, localOffset });
    p = next;
  }
  if (p !== cdEnd) throw new ZipError('corrupt', 'The archive directory is damaged.');

  // Duplicates and file/directory conflicts. Compared case-insensitively and
  // NFC-normalized, because the target filesystem may be either: on macOS or
  // Windows `Index.js` and `index.js` are one file, and `é` decomposed and
  // composed are one name on APFS. The second write would replace the first
  // after validation already looked at it.
  const fileKeys = new Set();
  const dirKeys = new Set();
  const key = (s) => s.normalize('NFC').toLowerCase();
  for (const e of entries) {
    const k = key(e.name);
    if (e.isDir) {
      if (fileKeys.has(k)) throw new ZipError('duplicate', `A path is both a file and a folder: ${e.name}`);
      dirKeys.add(k);
      continue;
    }
    if (fileKeys.has(k)) throw new ZipError('duplicate', `Duplicate file in archive: ${e.name}`);
    if (dirKeys.has(k)) throw new ZipError('duplicate', `A path is both a file and a folder: ${e.name}`);
    fileKeys.add(k);
  }
  // validateEntryName capped the depth, so the set holds at most
  // entries × maxDepth keys. The bound is checked again here as the loop runs:
  // should the cap ever be loosened, the loop stops at the bound instead of
  // growing the set until the process dies.
  const maxPrefixes = entries.length * lim.maxDepth;
  for (const e of entries) {
    const parts = key(e.name).split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('/');
      if (fileKeys.has(prefix)) throw new ZipError('duplicate', `A path is both a file and a folder: ${prefix}`);
      dirKeys.add(prefix);
      if (dirKeys.size > maxPrefixes) throw new ZipError('unsafe_path', 'The archive has too many nested folders.');
    }
  }

  // Local headers: find the data, and make sure no two entries share bytes.
  // Overlapping entries are how "quines" and non-recursive bombs inflate one
  // compressed block into thousands of files.
  const spans = [];
  for (const e of entries) {
    const lo = e.localOffset;
    if (lo + 30 > cdOffset || buffer.readUInt32LE(lo) !== SIG_LOCAL) {
      throw new ZipError('corrupt', `Local header missing for ${e.name}.`);
    }
    const localFlags = buffer.readUInt16LE(lo + 6);
    if (localFlags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw new ZipError('encrypted', `Encrypted archive entries are not supported: ${e.name}`);
    }
    const dataStart = lo + 30 + buffer.readUInt16LE(lo + 26) + buffer.readUInt16LE(lo + 28);
    let end = dataStart + e.csize;
    if (end > cdOffset) throw new ZipError('corrupt', `Entry data runs past the archive directory: ${e.name}`);
    if (e.flags & FLAG_DATA_DESCRIPTOR) {
      const hasSig = end + 4 <= cdOffset && buffer.readUInt32LE(end) === SIG_DATA_DESCRIPTOR;
      end += hasSig ? 16 : 12;
      if (end > cdOffset) throw new ZipError('corrupt', `Data descriptor runs past the archive directory: ${e.name}`);
    }
    e.dataStart = dataStart;
    spans.push([lo, end, e.name]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i][0] < spans[i - 1][1]) {
      throw new ZipError('corrupt', `Archive entries overlap: ${spans[i][2]}`);
    }
  }

  // Inflate and the CRC run synchronously on the event loop, on purpose. The
  // work is bounded by the limits above: at most maxTotal (50 MiB) of output,
  // which inflateRawSync and zlib.crc32 handle in well under a second on a
  // small server, and the route behind it is admin-only, session-only and
  // limited to ten installs per ten minutes. A worker thread or a streaming
  // inflate would buy little against that and cost a second code path for
  // every error above. Measured and left as is in the review of #1671.
  const files = [];
  for (const e of entries) {
    if (e.isDir) continue;
    const raw = buffer.subarray(e.dataStart, e.dataStart + e.csize);
    let data;
    if (e.method === 0) {
      data = Buffer.from(raw);
    } else {
      try {
        // maxOutputLength is the real bomb guard: the declared size is only a
        // claim, and inflate stops with an error the moment output exceeds it.
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(e.usize, 1) });
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
          throw new ZipError('bomb', `Entry unpacks to more than its declared size: ${e.name}`);
        }
        throw new ZipError('corrupt', `Entry could not be decompressed: ${e.name}`);
      }
    }
    if (data.length !== e.usize) {
      throw new ZipError('corrupt', `Entry size does not match the archive directory: ${e.name}`);
    }
    if (crc32(data) !== e.crc) {
      throw new ZipError('crc', `Checksum mismatch for ${e.name}. The archive is damaged.`);
    }
    files.push({ name: e.name, data });
  }
  return { files, comment };
}

/** `readZip(buffer, limits?)` → `[{ name, data }]`, files only. */
export function readZip(buffer, limits) {
  return readZipArchive(buffer, limits).files;
}

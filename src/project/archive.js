import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { AppError, EXIT } from "../shared/errors.js";

const MiB = 1024 * 1024;
/** Batas awal = asumsi konfigurasi (bukan batas GitHub, bukan hasil ukur perangkat). */
export const DEFAULT_ZIP_LIMITS = { maxArchiveBytes: 256 * MiB, maxTotalBytes: 512 * MiB, maxEntryBytes: 100 * MiB, maxEntries: 10000, maxDepth: 64, maxRatio: 1000, timeoutMs: 120000 };
const METADATA = new Set(["__MACOSX", ".DS_Store", "Thumbs.db"]);

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const bad = (code, msg, detail = "") => new AppError(code, msg, detail, EXIT.USAGE);

/** Validasi nama entry; mengembalikan path posix ternormalisasi atau throw. */
export function normalizeEntryName(raw, maxDepth) {
  if (raw.includes("\0")) throw bad("ZIP_UNSAFE_PATH", "Entry ZIP berisi null byte.", raw);
  const name = raw.replace(/\\/g, "/");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw bad("ZIP_UNSAFE_PATH", "Entry ZIP memakai path absolut/drive.", raw);
  const parts = name.split("/").filter((p, i, a) => p !== "" || i === a.length - 1);
  const segs = parts.filter((p) => p !== "");
  if (segs.some((p) => p === ".." || p === ".")) throw bad("ZIP_UNSAFE_PATH", "Entry ZIP keluar dari root (path traversal).", raw);
  if (segs.length > maxDepth) throw bad("ZIP_TOO_DEEP", `Kedalaman path melebihi ${maxDepth} segmen.`, raw);
  return { rel: segs.join("/"), isDir: name.endsWith("/") };
}

function readCentralDirectory(buf, limits) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad("ZIP_CORRUPT", "File ZIP rusak atau bukan ZIP (EOCD tidak ditemukan).");
  const disk = buf.readUInt16LE(eocd + 4), total = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw bad("ZIP_UNSUPPORTED", "ZIP64/multi-disk tidak didukung.");
  if (total > limits.maxEntries) throw bad("ZIP_LIMIT", `Jumlah entry ${total} melebihi batas ${limits.maxEntries}.`);
  const entries = [];
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad("ZIP_CORRUPT", "Central directory ZIP rusak.");
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8, ext = buf.readUInt32LE(p + 38), off = buf.readUInt32LE(p + 42);
    if (p + 46 + nl > buf.length) throw bad("ZIP_CORRUPT", "Nama entry ZIP terpotong.");
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    if (csize === 0xffffffff || usize === 0xffffffff || off === 0xffffffff) throw bad("ZIP_UNSUPPORTED", "ZIP64 tidak didukung.", name);
    entries.push({ name, flags, method, crc, csize, usize, off, symlink: madeBy === 3 && ((ext >>> 16) & 0o170000) === 0o120000 });
    p += 46 + nl + el + cl;
  }
  return entries;
}

/**
 * Ekstrak ZIP dengan batas NYATA: dekompresi dibatasi maxOutputLength per entry (bukan hanya metadata),
 * total aktual dihitung, crc & ukuran diverifikasi. Parser sendiri (node:zlib), tanpa dependensi.
 */
export async function extractZip(zipPath, outDir, overrides = {}) {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides };
  const started = Date.now();
  const st = await fs.stat(zipPath);
  if (st.size > limits.maxArchiveBytes) throw bad("ZIP_LIMIT", `Ukuran arsip melebihi batas tool ${limits.maxArchiveBytes} byte.`);
  if (st.size === 0) throw bad("ZIP_EMPTY", "File ZIP kosong.");
  const buf = await fs.readFile(zipPath);
  const entries = readCentralDirectory(buf, limits);
  if (!entries.length) throw bad("ZIP_EMPTY", "File ZIP tidak berisi entry.");

  // validasi SEMUA entry sebelum menulis apa pun
  const seen = new Map(), lower = new Map(), plan = [];
  let declared = 0;
  for (const e of entries) {
    if (e.flags & 1) throw bad("ZIP_UNSUPPORTED", "ZIP terenkripsi tidak didukung.", e.name);
    if (e.method !== 0 && e.method !== 8) throw bad("ZIP_UNSUPPORTED", `Metode kompresi ${e.method} tidak didukung.`, e.name);
    if (e.symlink) throw bad("ZIP_SYMLINK", "Entry symlink ditolak.", e.name);
    const { rel, isDir } = normalizeEntryName(e.name, limits.maxDepth);
    if (!rel) continue;
    if (!isDir) {
      if (e.usize > limits.maxEntryBytes) throw bad("ZIP_LIMIT", `Entry melebihi ${limits.maxEntryBytes} byte.`, e.name);
      if (e.csize > 0 && e.usize / e.csize > limits.maxRatio) throw bad("ZIP_RATIO", `Rasio kompresi mencurigakan (> ${limits.maxRatio}:1).`, e.name);
      declared += e.usize;
      if (declared > limits.maxTotalBytes) throw bad("ZIP_LIMIT", `Total ekstraksi melebihi ${limits.maxTotalBytes} byte.`);
    }
    if (seen.has(rel) || lower.has(rel.toLowerCase()) && lower.get(rel.toLowerCase()) !== rel) throw bad("ZIP_DUPLICATE", "Path duplikat/bentrok dalam ZIP.", rel);
    seen.set(rel, isDir); lower.set(rel.toLowerCase(), rel);
    plan.push({ ...e, rel, isDir });
  }
  for (const p of plan) { // file tidak boleh dipakai sebagai direktori
    const parts = p.rel.split("/");
    for (let i = 1; i < parts.length; i++) if (seen.get(parts.slice(0, i).join("/")) === false) throw bad("ZIP_DUPLICATE", "Bentrok file/direktori dalam ZIP.", p.rel);
  }
  try { // ruang disk: snapshot + clone + staging ≈ 3x
    const sf = await fs.statfs(os.tmpdir());
    if (sf.bavail * sf.bsize < declared * 3) throw bad("DISK_SPACE", "Ruang disk tidak cukup untuk ekstraksi + clone + staging.");
  } catch (e) { if (e instanceof AppError) throw e; }

  await fs.mkdir(outDir, { recursive: true });
  const root = path.resolve(outDir) + path.sep;
  let actualTotal = 0;
  for (const e of plan) {
    if (Date.now() - started > limits.timeoutMs) throw bad("ZIP_TIMEOUT", "Ekstraksi ZIP melebihi batas waktu.");
    const target = path.resolve(outDir, ...e.rel.split("/"));
    if (!target.startsWith(root)) throw bad("ZIP_UNSAFE_PATH", "Entry keluar dari root ekstraksi.", e.rel);
    if (e.isDir) { await fs.mkdir(target, { recursive: true }); continue; }
    if (e.off + 30 > buf.length || buf.readUInt32LE(e.off) !== 0x04034b50) throw bad("ZIP_CORRUPT", "Local header ZIP rusak.", e.rel);
    const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
    if (start + e.csize > buf.length) throw bad("ZIP_CORRUPT", "Data entry ZIP terpotong.", e.rel);
    const raw = buf.subarray(start, start + e.csize);
    const room = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - actualTotal);
    let data;
    if (e.method === 0) data = raw;
    else {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(room, 1) }); }
      catch (err) { throw bad(err.code === "ERR_BUFFER_TOO_LARGE" ? "ZIP_LIMIT" : "ZIP_CORRUPT", err.code === "ERR_BUFFER_TOO_LARGE" ? "Hasil dekompresi aktual melebihi batas (ZIP bomb?)." : "Data entry ZIP rusak.", e.rel); }
    }
    if (data.length > room) throw bad("ZIP_LIMIT", "Hasil dekompresi aktual melebihi batas.", e.rel);
    if (data.length !== e.usize || crc32(data) !== e.crc) throw bad("ZIP_CORRUPT", "Ukuran/CRC entry tidak cocok (ZIP rusak atau dimanipulasi).", e.rel);
    actualTotal += data.length;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { flag: "wx" });
  }
  return { entries: plan.length, bytes: actualTotal };
}

/** Buka satu folder root hanya jika sibling-nya benar-benar metadata aman; selain itu pertahankan root. */
export async function detectProjectRoot(dir) {
  const items = await fs.readdir(dir, { withFileTypes: true });
  const meaningful = items.filter((i) => !METADATA.has(i.name));
  if (meaningful.length === 1 && meaningful[0].isDirectory()) return { root: path.join(dir, meaningful[0].name), candidates: [meaningful[0].name] };
  return { root: dir, candidates: meaningful.map((i) => i.name + (i.isDirectory() ? "/" : "")) };
}

/** Siapkan sumber dari ZIP; cleanup dimiliki sejak temp dir dibuat. */
export async function prepareZipSource(zipPath, limits) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gitship-zip-"));
  const cleanup = () => fs.rm(tempRoot, { recursive: true, force: true });
  try {
    const outDir = path.join(tempRoot, "x");
    const stats = await extractZip(zipPath, outDir, limits);
    const { root, candidates } = await detectProjectRoot(outDir);
    return { sourcePath: root, originalPath: zipPath, kind: "zip", stats, candidates, cleanup };
  } catch (e) { await cleanup(); throw e; }
}

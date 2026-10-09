import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildManifest } from "./policy.js";
import { prepareZipSource } from "./archive.js";
import { AppError, EXIT } from "../shared/errors.js";

/** Normalisasi input: spasi, kutip, ~, relatif. */
export function normalizeInputPath(raw) {
  let p = String(raw ?? "").trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  if (p === "~") p = os.homedir(); else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/** Folder/file/ZIP -> manifest + cleanup (sumber tidak pernah dimodifikasi). */
export async function prepareSource(raw, zipLimits) {
  const p = normalizeInputPath(raw);
  let st;
  try { st = await fs.lstat(p); } catch (e) {
    throw new AppError(e.code === "EACCES" ? "SOURCE_NO_ACCESS" : "SOURCE_NOT_FOUND", e.code === "EACCES" ? "Tidak punya akses baca ke sumber." : "Folder/file project tidak ditemukan.", p, EXIT.USAGE);
  }
  if (st.isFile() && path.extname(p).toLowerCase() === ".zip") {
    const z = await prepareZipSource(p, zipLimits);
    try {
      const manifest = await buildManifest(z.sourcePath);
      return { manifest, kind: "zip", originalPath: p, candidates: z.candidates, cleanup: z.cleanup };
    } catch (e) { await z.cleanup(); throw e; }
  }
  const manifest = await buildManifest(p);
  return { manifest, kind: st.isDirectory() ? "folder" : "file", originalPath: p, candidates: [], cleanup: async () => {} };
}

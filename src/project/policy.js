import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runGit } from "../git/client.js";
import { AppError, EXIT } from "../shared/errors.js";

export const GITHUB_MAX_FILE = 100 * 1024 * 1024;
export const GITHUB_WARN_FILE = 50 * 1024 * 1024;

const SECRET_CONTENT = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /_authToken\s*=\s*(?!\$\{)[^\s$]{8,}/
];
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/i;
const KEY_NAMES = /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i;
const KEY_EXT = /\.(pem|key|p12|pfx|jks|keystore)$/i;
const DEFAULT_IGNORED_DIRS = new Set(["node_modules", ".cache", ".tmp", "__pycache__", ".pytest_cache", ".parcel-cache", ".turbo"]);

/** Klasifikasi path relatif (posix): "block" = rahasia/hard-exclude, "ignore" = artefak default, null = boleh. */
export function classifyPath(rel, { allowArtifacts = [] } = {}) {
  const parts = rel.split("/");
  const base = parts[parts.length - 1];
  if (parts.includes(".git")) return { action: "block", reason: "direktori .git" };
  if (parts.includes(".alizz-gitship")) return { action: "block", reason: "direktori config GitShip" };
  if (base === ".env" || (/^\.env\./i.test(base) && !ENV_TEMPLATE.test(base))) return { action: "block", reason: "file .env (rahasia)" };
  if (base === ".netrc" || base === ".git-credentials" || base === ".pgpass") return { action: "block", reason: "credential store" };
  if (KEY_NAMES.test(base) || KEY_EXT.test(base)) return { action: "block", reason: "private key/sertifikat" };
  if (base === ".DS_Store" || /\.log$/i.test(base)) return { action: "ignore", reason: "temporary/log" };
  for (const p of parts.slice(0, -1)) {
    if (DEFAULT_IGNORED_DIRS.has(p) && !allowArtifacts.includes(p)) return { action: "ignore", reason: `artefak default (${p}/)` };
  }
  return null;
}

async function scanContent(abs, rel, size) {
  const base = path.posix.basename(rel);
  if (!(ENV_TEMPLATE.test(base) || base === ".npmrc" || size <= 256 * 1024)) return null;
  if (size > 1024 * 1024) return null;
  const text = await fs.readFile(abs, "utf8").catch(() => "");
  if (text.includes("\0")) return null;
  return SECRET_CONTENT.some((r) => r.test(text)) ? "berisi pola secret/token" : null;
}

/**
 * Bangun manifest sumber. Folder hanya DIBACA. Ignore memakai Git sebagai otoritas
 * (git-dir sementara, jadi sumber tidak disentuh): .gitignore nested/negation + .gitshipignore (root).
 */
export async function buildManifest(sourcePath, opts = {}) {
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) throw new AppError("SYMLINK_UNSUPPORTED", "Symlink sebagai sumber tidak didukung.", sourcePath, EXIT.USAGE);
  const files = [], excluded = [], blocked = [], large = [];

  const consider = async (abs, rel, st) => {
    const c = classifyPath(rel, opts);
    if (c?.action === "block") return blocked.push({ rel, reason: c.reason });
    if (c?.action === "ignore") return excluded.push({ rel, reason: c.reason });
    const hit = await scanContent(abs, rel, st.size);
    if (hit) return blocked.push({ rel, reason: hit });
    if (st.size > GITHUB_MAX_FILE) large.push({ rel, size: st.size, fatal: true });
    else if (st.size > GITHUB_WARN_FILE) large.push({ rel, size: st.size, fatal: false });
    files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
  };

  if (stat.isFile()) {
    await consider(sourcePath, path.basename(sourcePath), stat);
  } else if (stat.isDirectory()) {
    const gd = await fs.mkdtemp(path.join(os.tmpdir(), "gitship-ign-"));
    try {
      await runGit(["init", "--bare", "-q", gd]);
      const args = [`--git-dir=${gd}`, `--work-tree=${sourcePath}`, "ls-files", "-z", "--others", "--exclude-standard"];
      const own = path.join(sourcePath, ".gitshipignore");
      if (await fs.stat(own).then(() => true, () => false)) args.push(`--exclude-from=${own}`);
      const { stdout } = await runGit(args);
      const rels = stdout.split("\0").filter(Boolean).sort();
      const listed = new Set(rels);
      for (const rel of rels) {
        const abs = path.join(sourcePath, ...rel.split("/"));
        const st = await fs.lstat(abs);
        if (st.isSymbolicLink()) throw new AppError("SYMLINK_UNSUPPORTED", "Symlink ditolak (tidak diikuti agar tidak keluar dari root).", rel, EXIT.USAGE);
        if (!st.isFile()) continue;
        await consider(abs, rel, st);
      }
      // file yang diabaikan .gitignore tetap dilaporkan sebagai excluded (bukan dibuang diam-diam)
      void listed;
    } finally {
      await fs.rm(gd, { recursive: true, force: true });
    }
  } else {
    throw new AppError("PROJECT_NOT_SUPPORTED", "Sumber harus folder atau file biasa.", sourcePath, EXIT.USAGE);
  }

  if (large.some((l) => l.fatal))
    throw new AppError("FILE_TOO_LARGE", "Ada file di atas 100 MiB (batas GitHub). Gunakan Git LFS secara manual atau keluarkan file ini.", large.filter((l) => l.fatal).map((l) => l.rel).join("\n"), EXIT.USAGE);
  return { files, excluded, blocked, large, totalSize: files.reduce((n, f) => n + f.size, 0) };
}

/** Terapkan policy pada tree staged final (termasuk file target yang sudah tracked). */
export function checkTrackedPaths(paths, opts = {}) {
  const violations = [];
  for (const rel of paths) {
    const c = classifyPath(rel, opts);
    if (c?.action === "block") violations.push({ rel, reason: c.reason });
  }
  return violations;
}

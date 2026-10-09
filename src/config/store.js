import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const SCHEMA_VERSION = 2;
export const defaultConfigDir = () => path.join(os.homedir(), ".alizz-gitship");

const isStr = (v) => typeof v === "string" && v.trim().length > 0;

/** Env lengkap (3 variabel) = akun sesi, TIDAK disimpan. Parsial = dilaporkan, tidak dicampur. */
export function accountFromEnv(env = process.env) {
  const u = env.GITHUB_USERNAME?.trim(), e = env.GITHUB_EMAIL?.trim(), t = env.GITHUB_TOKEN?.trim();
  const present = [["GITHUB_USERNAME", u], ["GITHUB_EMAIL", e], ["GITHUB_TOKEN", t]];
  const missing = present.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length === 0) return { status: "ok", account: { username: u, email: e, token: t }, source: "env" };
  if (missing.length === 3) return { status: "none" };
  return { status: "partial", missing };
}

/** Baca config v1 (lama) atau v2. Tidak pernah throw: file rusak -> {status:"invalid"}. */
export async function readConfig(dir = defaultConfigDir()) {
  const file = path.join(dir, "config.json");
  let raw;
  try { raw = await fs.readFile(file, "utf8"); } catch (e) { return e.code === "ENOENT" ? { status: "none" } : { status: "invalid", reason: e.code || "read_error" }; }
  let j;
  try { j = JSON.parse(raw); } catch { return { status: "invalid", reason: "json_rusak" }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { status: "invalid", reason: "schema" };
  if (j.schemaVersion !== undefined && j.schemaVersion > SCHEMA_VERSION) return { status: "invalid", reason: "versi_lebih_baru" };
  if (!isStr(j.username) || !isStr(j.email) || !isStr(j.token)) return { status: "invalid", reason: "field_kurang" };
  return { status: "ok", account: { username: j.username, email: j.email, token: j.token }, source: "config", legacy: j.schemaVersion === undefined };
}

/** Atomic write: file temp 0600 di direktori 0700, lalu rename. 0600 BUKAN enkripsi. */
export async function writeConfig(account, dir = defaultConfigDir()) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try { await fs.chmod(dir, 0o700); } catch {}
  const file = path.join(dir, "config.json");
  const tmp = path.join(dir, `.config.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const body = JSON.stringify({ schemaVersion: SCHEMA_VERSION, username: account.username, email: account.email, token: account.token, savedAt: new Date().toISOString() }, null, 2);
  try {
    await fs.writeFile(tmp, body, { mode: 0o600 });
    try { await fs.chmod(tmp, 0o600); } catch {}
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return file;
}

/** Logout/reset: bekerja offline dan pada config rusak. */
export async function clearConfig(dir = defaultConfigDir()) {
  await fs.rm(path.join(dir, "config.json"), { force: true });
}

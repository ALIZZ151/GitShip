import { spawn } from "node:child_process";
import os from "node:os";
import { AppError, EXIT } from "../shared/errors.js";
import { redact } from "../shared/redact.js";

const MAX_OUTPUT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Kredensial dikirim lewat environment child (GIT_CONFIG_*), bukan argv/URL/.git/config. Butuh Git >= 2.31. */
export function authEnv(token) {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
  };
}

export function assertRemoteAllowed(url, { allowLocal = false } = {}) {
  if (/^https:\/\/github\.com\/[^/\s@]+\/[^/\s@]+?(\.git)?$/.test(url)) return;
  if (allowLocal && /^file:\/\//.test(url)) return;
  throw new AppError("REMOTE_NOT_ALLOWED", "Remote ditolak: hanya https://github.com/<owner>/<repo> yang diizinkan.", url, EXIT.USAGE);
}

/** spawn tanpa shell, env terisolasi dari config global Git, timeout, output dibatasi. */
export function runGit(args, { cwd, token, signal, timeoutMs = DEFAULT_TIMEOUT_MS, extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ASKPASS: "",
      ...authEnv(token),
      ...extraEnv
    };
    const child = spawn("git", args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const cap = (s, c) => (s.length < MAX_OUTPUT ? s + c.toString() : s);
    child.stdout.on("data", (c) => (stdout = cap(stdout, c)));
    child.stderr.on("data", (c) => (stderr = cap(stderr, c)));
    const safeCmd = redact(`git ${args.join(" ")}`, [token]);
    child.on("error", (e) => {
      clearTimeout(timer);
      if (e.code === "ENOENT") return reject(new AppError("GIT_NOT_INSTALLED", "Git belum terinstall atau belum masuk PATH.", "Termux: pkg install git -y", EXIT.USAGE));
      if (e.name === "AbortError") return reject(new AppError("CANCELLED", "Dibatalkan.", "", EXIT.CANCELLED));
      reject(new AppError("GIT_SPAWN_FAILED", "Gagal menjalankan Git.", redact(e.message, [token])));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new AppError("GIT_TIMEOUT", "Git melebihi batas waktu.", safeCmd, EXIT.NETWORK));
      if (code === 0) return resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      reject(mapGitError(safeCmd, redact(stderr.trim() || stdout.trim(), [token])));
    });
  });
}

export function mapGitError(cmd, detail) {
  const d = `${detail}`;
  if (/non-fast-forward|fetch first|\(fetch first\)|failed to push some refs.*(rejected)/is.test(d) && /rejected/i.test(d))
    return new AppError("PUSH_REJECTED", "Push ditolak: remote berubah atau tidak fast-forward. Tidak ada force push dilakukan.", d, EXIT.GIT);
  if (/protected branch|GH006|GH013|rule violations|ruleset/i.test(d))
    return new AppError("PUSH_BLOCKED_BY_RULES", "Branch dilindungi (protected branch/ruleset). Gunakan branch lain atau PR secara manual.", d, EXIT.GIT);
  if (/Authentication failed|could not read Username|Invalid username or password/i.test(d))
    return new AppError("AUTH_FAILED", "Autentikasi Git gagal. Periksa token dan izin Contents: write.", d, EXIT.AUTH);
  if (/Permission to .* denied|The requested URL returned error: 403/i.test(d))
    return new AppError("PERMISSION_DENIED", "Akses ditolak untuk repo/branch ini. Periksa izin token.", d, EXIT.AUTH);
  if (/Repository not found|repository .* not found/i.test(d))
    return new AppError("REPO_NOT_FOUND", "Repository tidak ditemukan atau token tidak punya akses.", d, EXIT.AUTH);
  if (/Could not resolve host|Failed to connect|Connection (refused|timed out)|unable to access/i.test(d))
    return new AppError("NETWORK_ERROR", "Koneksi ke GitHub bermasalah.", d, EXIT.NETWORK);
  return new AppError("GIT_FAILED", `Command gagal: ${cmd}`, d, EXIT.GIT);
}

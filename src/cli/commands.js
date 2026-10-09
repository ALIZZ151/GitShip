import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { accountFromEnv, readConfig, writeConfig, clearConfig, defaultConfigDir } from "../config/store.js";
import { createGitHubClient } from "../github/client.js";
import { runGit } from "../git/client.js";
import { prepareSource } from "../project/source.js";
import { runUpload } from "../operations/upload.js";
import { AppError, EXIT } from "../shared/errors.js";
import { formatPlan } from "./ui.js";

export const maskToken = (t) => (!t ? "-" : t.length <= 10 ? "********" : `${t.slice(0, 4)}${"*".repeat(8)}${t.slice(-4)}`);
export const validRepoName = (n) => /^[A-Za-z0-9._-]{1,100}$/.test(n) && n !== "." && n !== ".." && !n.endsWith(".git");

/** Akun aktif: env lengkap (sesi, tidak disimpan) > config. Env parsial = error jelas, tidak dicampur. */
export async function resolveAccount(deps) {
  const e = accountFromEnv(deps.env);
  if (e.status === "ok") return { account: e.account, source: "env" };
  if (e.status === "partial") throw new AppError("ENV_PARTIAL", `Environment variable tidak lengkap, kurang: ${e.missing.join(", ")}. Lengkapi ketiganya atau hapus semuanya.`, "", EXIT.USAGE);
  const c = await readConfig(deps.configDir);
  if (c.status === "ok") return { account: c.account, source: "config", legacy: c.legacy };
  if (c.status === "invalid") throw new AppError("CONFIG_INVALID", `Config tersimpan tidak valid (${c.reason}). Jalankan "gitship auth logout" lalu login ulang.`, "", EXIT.AUTH);
  throw new AppError("NOT_LOGGED_IN", 'Belum login. Set GITHUB_USERNAME/GITHUB_EMAIL/GITHUB_TOKEN atau jalankan "gitship auth login".', "", EXIT.AUTH);
}

export async function validateAccount(account, deps) {
  const client = createGitHubClient({ token: account.token, fetchImpl: deps.fetchImpl, signal: deps.signal });
  const user = await client.getUser(deps.signal);
  if (user.login.toLowerCase() !== account.username.toLowerCase())
    throw new AppError("USERNAME_TOKEN_MISMATCH", "Username tidak cocok dengan token GitHub.", `Token milik akun: ${user.login}, input: ${account.username}`, EXIT.AUTH);
  return { client, user };
}

export async function authCommand(sub, v, deps, out) {
  if (sub === "status") {
    const e = accountFromEnv(deps.env);
    const c = await readConfig(deps.configDir);
    const data = {
      env: e.status === "ok" ? { username: e.account.username, token: maskToken(e.account.token) } : e.status === "partial" ? { partial: e.missing } : null,
      config: c.status === "ok" ? { username: c.account.username, token: maskToken(c.account.token), legacy: c.legacy } : c.status === "none" ? null : { invalid: c.reason },
      aktif: e.status === "ok" ? "env" : c.status === "ok" ? "config" : "tidak ada"
    };
    return out(data, `Akun aktif: ${data.aktif}\nEnv   : ${JSON.stringify(data.env)}\nConfig: ${JSON.stringify(data.config)}`);
  }
  if (sub === "logout") { await clearConfig(deps.configDir); return out({ status: "logged-out" }, "Login tersimpan dihapus (offline, tanpa validasi)."); }
  if (sub === "login") {
    const e = accountFromEnv(deps.env);
    if (e.status !== "ok") throw new AppError("USAGE", "Login non-interaktif butuh GITHUB_USERNAME, GITHUB_EMAIL, GITHUB_TOKEN. Untuk prompt, jalankan 'gitship' tanpa argumen.", "", EXIT.USAGE);
    await validateAccount(e.account, deps);
    if (!v.remember) return out({ status: "valid", saved: false }, "Akun valid. Tidak disimpan (tambahkan --remember untuk menyimpan).");
    const file = await writeConfig(e.account, deps.configDir);
    return out({ status: "valid", saved: true, file }, `Akun valid dan disimpan di ${file} (mode 0600 — bukan enkripsi).`);
  }
  throw new AppError("USAGE", "Subperintah auth: status | login | logout", "", EXIT.USAGE);
}

export async function doctorCommand(v, deps, out) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const [maj, min] = process.versions.node.split(".").map(Number);
  add("node", maj > 22 || (maj === 22 && min >= 12), `v${process.versions.node} (butuh ^22.12)`);
  try { const { stdout } = await runGit(["--version"]); const m = /(\d+)\.(\d+)/.exec(stdout); add("git", !!m && (+m[1] > 2 || (+m[1] === 2 && +m[2] >= 31)), `${stdout} (butuh >= 2.31)`); }
  catch (e) { add("git", false, e.message); }
  try { const d = await fs.mkdtemp(path.join(os.tmpdir(), "gitship-doctor-")); await fs.rm(d, { recursive: true }); add("temp", true, os.tmpdir()); } catch (e) { add("temp", false, e.message); }
  const dir = deps.configDir ?? defaultConfigDir();
  const c = await readConfig(dir);
  add("config", c.status !== "invalid", `${dir} → ${c.status}${c.reason ? ` (${c.reason})` : ""}`);
  add("terminal", true, `tty=${!!deps.isTTY} NO_COLOR=${"NO_COLOR" in deps.env} cols=${process.stdout.columns ?? "-"}`);
  if (v.network) {
    try { const r = await deps.fetchImpl("https://api.github.com/rate_limit", { signal: AbortSignal.timeout(10000) }); add("network", r.ok, `api.github.com → HTTP ${r.status}`); }
    catch (e) { add("network", false, e.message); }
  }
  const ok = checks.every((x) => x.ok);
  out({ ok, checks }, checks.map((x) => `${x.ok ? "✓" : "✗"} ${x.name}: ${x.detail}`).join("\n"));
  return ok ? EXIT.OK : EXIT.FAILED;
}

export async function uploadCommand(v, deps, out) {
  const usage = (m) => new AppError("USAGE", m, "", EXIT.USAGE);
  if (!v.source) throw usage("--source wajib.");
  if (!!v.new === !!v.repo) throw usage("Pilih tepat satu: --new <nama> atau --repo owner/repo.");
  const mode = v.mode ?? (v.new ? "replace" : undefined);
  if (v.new && v.mode && v.mode !== "replace") throw usage("Repo baru hanya mode replace.");
  if (!mode) throw usage("Update repo wajib --mode replace|overlay.");
  if (!["replace", "overlay"].includes(mode)) throw usage("--mode harus replace atau overlay.");
  if (v.new) {
    if (!validRepoName(v.new)) throw usage("Nama repo tidak valid.");
    if (!["public", "private"].includes(v.visibility)) throw usage("Repo baru wajib --visibility public|private.");
  }
  let owner, repoName;
  if (v.repo) { const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(v.repo); if (!m) throw usage("--repo harus owner/repo."); [, owner, repoName] = m; }

  const src = await prepareSource(v.source);
  let released = false;
  const cleanup = async () => { if (!released) { released = true; await src.cleanup(); } };
  try {
    const needApi = !!v.repo || !v["dry-run"];
    let account = null, client = null;
    if (needApi) {
      ({ account } = await resolveAccount(deps));
      ({ client } = await validateAccount(account, deps));
    }
    let target, label;
    if (v.new) {
      label = `${account?.username ?? "(akun)"}/${v.new}@main`;
      target = { kind: "new", branch: "main", name: v.new, htmlUrl: undefined,
        createRepo: async () => { const r = await client.createRepository(v.new, v.visibility, deps.signal); return { cloneUrl: r.clone_url, htmlUrl: r.html_url }; } };
    } else {
      const repo = await client.getRepository(owner, repoName, deps.signal);
      if (repo.archived) throw new AppError("REPO_ARCHIVED", "Repo diarsipkan (read-only).", repo.html_url, EXIT.AUTH);
      if (repo.permissions && repo.permissions.push === false) throw new AppError("NO_PUSH_PERMISSION", "Akun tidak punya izin push ke repo ini (menurut metadata repo).", repo.html_url, EXIT.AUTH);
      const branch = v.branch ?? repo.default_branch;
      label = `${repo.full_name}@${branch}`;
      target = { kind: "existing", cloneUrl: repo.clone_url, htmlUrl: repo.html_url, branch, createBranch: !!v["create-branch"], defaultBranch: repo.default_branch };
    }
    if (v.new && v.branch && v.branch !== "main") throw usage("Repo baru memakai branch main.");

    if (!v["dry-run"]) {
      if (mode === "replace" && v.repo) { if (v["confirm-replace"] !== label) throw usage(`Replace memerlukan --confirm-replace ${label} (persis).`); }
      else if (!v.yes) throw usage("Operasi ini memerlukan --yes (atau gunakan --dry-run).");
    }
    const result = await runUpload({
      manifest: src.manifest, target, mode, message: v.message, dryRun: !!v["dry-run"],
      account: account ?? { username: "dry-run", email: "dry-run@example.invalid" }, token: account?.token, signal: deps.signal,
      allowLocalRemote: !!deps.allowLocalRemote, lockKey: account ? `${account.username}/${label}` : undefined, lockDir: deps.lockDir,
      confirm: async (plan) => { deps.progress?.(formatPlan(plan)); return true; },
      extraCleanups: [cleanup]
    });
    released = true;
    const p = result.plan;
    const data = { status: result.status, target: label, mode, branch: p.branch, baseSha: p.baseSha, commit: result.intendedSha ?? null, repoUrl: result.repoUrl ?? null, counts: p.counts, excluded: p.excluded.length, blocked: p.blocked.map((b) => b.rel), warnings: result.warnings ?? [] };
    if (result.status === "uncertain") throw Object.assign(new AppError("PUSH_UNCERTAIN", "Hasil push TIDAK PASTI dan tidak diulang otomatis. Periksa repo di GitHub sebelum mencoba lagi.", `${result.repoUrl ?? ""}\n${result.detail ?? ""}`, EXIT.NETWORK), { context: data });
    out(data, `${formatPlan(p)}\n\nStatus: ${result.status}${result.intendedSha ? `\nCommit: ${result.intendedSha}\nURL   : ${result.repoUrl}` : ""}`);
    return result.status === "cancelled" ? EXIT.CANCELLED : EXIT.OK;
  } finally { await cleanup(); }
}

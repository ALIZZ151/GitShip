import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runGit, assertRemoteAllowed } from "../git/client.js";
import { checkTrackedPaths } from "../project/policy.js";
import { AppError, EXIT } from "../shared/errors.js";
import { acquireLock } from "./lock.js";

export const DEFAULT_MESSAGES = { update: "Update project deployment", create: "Initial project deployment" };

async function runCleanups(list) {
  const errors = [];
  for (const fn of list.reverse()) { try { await fn(); } catch (e) { errors.push(e); } }
  return errors;
}

async function remoteBranchSha(git, branch) {
  const { stdout } = await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], true);
  return stdout.split("\n").filter(Boolean).map((l) => l.split("\t")[0])[0] || null;
}

async function copyManifest(manifest, repoDir) {
  for (const f of manifest.files) {
    const dest = path.join(repoDir, ...f.rel.split("/"));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(f.abs, dest); // mode (exec bit) ikut tersalin
  }
}

async function clearExceptGit(dir) {
  for (const e of await fs.readdir(dir)) if (e !== ".git") await fs.rm(path.join(dir, e), { recursive: true, force: true });
}

/**
 * Orkestrasi upload. Tidak ada UI di sini: `confirm(plan)` disuntik pemanggil.
 * target = { kind:"new", branch, name, createRepo():{cloneUrl,htmlUrl} } | { kind:"existing", cloneUrl, htmlUrl, branch, createBranch?, defaultBranch? }
 */
export async function runUpload({ manifest, target, mode = "replace", message, account, token, confirm, dryRun = false, signal, allowLocalRemote = false, lockKey, lockDir, extraCleanups = [] }) {
  if (!manifest?.files?.length) throw new AppError("EMPTY_SNAPSHOT", "Tidak ada file yang lolos kebijakan. Repo tidak dibuat.", "", EXIT.USAGE);
  if (mode !== "replace" && mode !== "overlay") throw new AppError("MODE_INVALID", "Mode harus replace atau overlay.", mode, EXIT.USAGE);
  if (target.kind === "new" && mode !== "replace") mode = "replace";
  const msg = (message ?? "").trim() || (target.kind === "new" ? DEFAULT_MESSAGES.create : DEFAULT_MESSAGES.update);

  const cleanups = [...extraCleanups];
  let release = null, mainError = null, result = null;
  const git = (args, auth = false) => runGit(args, { cwd: repoDir, token: auth ? token : undefined, signal });
  let repoDir;
  try {
    if (lockKey) { release = await acquireLock(lockKey, lockDir); cleanups.push(release); }
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gitship-op-"));
    cleanups.push(() => fs.rm(tempRoot, { recursive: true, force: true }));
    repoDir = path.join(tempRoot, "repo");
    await fs.mkdir(repoDir);

    await git(["init", "-q", "-b", target.branch]);
    let baseSha = null, remoteSha = null;

    if (target.kind === "existing") {
      assertRemoteAllowed(target.cloneUrl, { allowLocal: allowLocalRemote });
      await git(["remote", "add", "origin", target.cloneUrl]);
      const { stdout } = await git(["ls-remote", "--heads", "origin"], true);
      const heads = new Map(stdout.split("\n").filter(Boolean).map((l) => { const [s, r] = l.split("\t"); return [r.replace("refs/heads/", ""), s]; }));
      if (heads.has(target.branch)) {
        remoteSha = heads.get(target.branch);
        await git(["fetch", "-q", "--depth", "1", "origin", `refs/heads/${target.branch}`], true);
        await git(["checkout", "-q", "-B", target.branch, "FETCH_HEAD"]);
        baseSha = remoteSha;
      } else if (heads.size === 0) {
        // repo kosong: inisialisasi dari nol
      } else if (target.createBranch && target.defaultBranch && heads.has(target.defaultBranch)) {
        await git(["fetch", "-q", "--depth", "1", "origin", `refs/heads/${target.defaultBranch}`], true);
        await git(["checkout", "-q", "-B", target.branch, "FETCH_HEAD"]);
        baseSha = heads.get(target.defaultBranch);
      } else {
        throw new AppError("BRANCH_NOT_FOUND", `Branch "${target.branch}" tidak ada di remote. Pilih branch lain atau buat branch baru secara eksplisit.`, [...heads.keys()].join(", "), EXIT.USAGE);
      }
    }

    // stage: replace = hapus semua kecuali .git lalu salin snapshot; overlay = salin di atas target
    if (mode === "replace") await clearExceptGit(repoDir);
    await copyManifest(manifest, repoDir);
    await git(["add", "-A", "-f"]);

    const tracked = (await git(["ls-files", "-z"])).stdout.split("\0").filter(Boolean);
    const violations = checkTrackedPaths(tracked);
    if (violations.length) throw new AppError("POLICY_CONFLICT", "Tree hasil mengandung file terlarang (mis. rahasia yang sudah tracked di target). Tidak ada yang dihapus otomatis.", violations.map((v) => `${v.rel} — ${v.reason}`).join("\n"), EXIT.USAGE);

    const diff = (await git(["diff", "--cached", "--name-status", "-z", "--no-renames"])).stdout.split("\0").filter(Boolean);
    const changes = { added: [], modified: [], deleted: [] };
    for (let i = 0; i + 1 < diff.length; i += 2) ({ A: changes.added, M: changes.modified, D: changes.deleted, T: changes.modified })[diff[i][0]]?.push(diff[i + 1]);
    const treeHash = (await git(["write-tree"])).stdout;
    const plan = {
      target: target.htmlUrl ?? target.name, branch: target.branch, mode, baseSha, message: msg, treeHash,
      counts: { added: changes.added.length, modified: changes.modified.length, deleted: changes.deleted.length },
      changes, totalSize: manifest.totalSize, excluded: manifest.excluded, blocked: manifest.blocked, large: manifest.large,
      noop: target.kind === "existing" && diff.length === 0
    };

    if (plan.noop) return (result = { status: "noop", plan });
    if (dryRun) return (result = { status: "dry-run", plan });
    if (!(await confirm(plan))) return (result = { status: "cancelled", plan });

    // snapshot yang dipreview harus = yang dipush: sumber (ukuran/mtime file) dan workspace tidak boleh berubah
    for (const f of manifest.files) {
      const st = await fs.stat(f.abs).catch(() => null);
      if (!st || st.size !== f.size || st.mtimeMs !== f.mtimeMs) throw new AppError("STALE_PLAN", "Sumber berubah setelah preview. Jalankan ulang untuk preview baru.", f.rel, EXIT.GIT);
    }
    await git(["add", "-A", "-f"]);
    if ((await git(["write-tree"])).stdout !== treeHash) throw new AppError("STALE_PLAN", "Sumber berubah setelah preview. Jalankan ulang untuk preview baru.", "", EXIT.GIT);
    if (target.kind === "existing" && (await remoteBranchSha(git, target.branch)) !== remoteSha) throw new AppError("STALE_REMOTE", "Remote berubah setelah preview. Jalankan ulang untuk preview baru.", "", EXIT.GIT);

    let repoUrl = target.htmlUrl;
    if (target.kind === "new") {
      const created = await target.createRepo();
      repoUrl = created.htmlUrl;
      assertRemoteAllowed(created.cloneUrl, { allowLocal: allowLocalRemote });
      await git(["remote", "add", "origin", created.cloneUrl]);
    }

    await git(["config", "user.name", account.username]);
    await git(["config", "user.email", account.email]);
    await git(["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", msg]);
    const intendedSha = (await git(["rev-parse", "HEAD"])).stdout;

    let pushErr = null;
    try { await git(["push", "-q", "origin", `HEAD:refs/heads/${target.branch}`], true); } catch (e) { pushErr = e; }

    let remoteNow;
    try { remoteNow = await remoteBranchSha(git, target.branch); } catch { remoteNow = undefined; }
    const base = { plan, repoUrl, branch: target.branch, baseSha, intendedSha, mode };
    if (remoteNow === intendedSha) return (result = { status: "pushed", ...base });
    if (pushErr && remoteNow !== undefined) { pushErr.context = { repoUrl, stage: "push", created: target.kind === "new" }; throw pushErr; }
    return (result = { status: "uncertain", ...base, detail: pushErr ? pushErr.message : "Verifikasi remote tidak cocok dengan commit yang dimaksud." });
  } catch (e) {
    mainError = e;
    throw e;
  } finally {
    const errs = await runCleanups(cleanups);
    if (!mainError && result && errs.length) result.warnings = errs.map((e) => e.message);
  }
}

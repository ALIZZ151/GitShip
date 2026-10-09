import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const INSTALL_ROOT = fileURLToPath(new URL("../", import.meta.url));
const TRUSTED_HTTPS = /^https:\/\/github\.com\/ALIZZ151\/GitShip(?:\.git)?\/?$/i;
const TRUSTED_SSH = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)ALIZZ151\/GitShip(?:\.git)?\/?$/i;

// Never use a shell or forced Git operations. Network checks have a bounded timeout.
async function exec(cwd, program, args, timeout, env) {
  const { stdout } = await execFile(program, args, {
    cwd, timeout, maxBuffer: 256 * 1024, windowsHide: true,
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
  });
  return stdout.trim();
}

/** Update only a clean clone of the official GitShip repo, on its main branch. */
export async function selfUpdate({
  projectRoot = INSTALL_ROOT,
  env = process.env,
  checkOnly = false,
  respectDisable = false,
  allowLocalRemote = false, // test fixture only; never enabled by the public CLI
  install = null,
  networkTimeout = 9000
} = {}) {
  if (respectDisable && ["0", "false", "off"].includes(String(env.GITSHIP_AUTO_UPDATE ?? "").toLowerCase()))
    return { status: "disabled", message: "Auto-update dinonaktifkan (GITSHIP_AUTO_UPDATE=0)." };
  let root;
  try { root = await realpath(projectRoot); }
  catch { return { status: "unsupported", message: "Folder instalasi tidak ditemukan." }; }

  const git = (args, timeout = 5000) => exec(root, "git", args, timeout, env);
  let top;
  try { top = await git(["rev-parse", "--show-toplevel"]); }
  catch { return { status: "unsupported", message: "Auto-update tersedia untuk instalasi git clone + npm link." }; }
  if (await realpath(top) !== root)
    return { status: "unsupported", message: "GitShip harus berada di root clone GitShip." };

  const branch = await git(["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "");
  if (branch !== "main") return { status: "skipped", message: "Bukan branch main; perubahan lokal tidak disentuh." };
  const remote = await git(["remote", "get-url", "origin"]).catch(() => "");
  if (!TRUSTED_HTTPS.test(remote) && !TRUSTED_SSH.test(remote) && !(allowLocalRemote && remote.startsWith("file://")))
    return { status: "skipped", message: "Remote origin bukan ALIZZ151/GitShip yang resmi; update dibatalkan." };

  const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) return { status: "skipped", message: "Ada perubahan pada file Git terpantau; simpan/commit dulu sebelum update." };

  try { await git(["fetch", "--quiet", "--no-tags", "origin", "main"], networkTimeout); }
  catch { return { status: "offline", message: "Tidak bisa mengecek GitHub (offline, autentikasi, atau timeout)." }; }

  const current = await git(["rev-parse", "HEAD"]);
  const latest = await git(["rev-parse", "FETCH_HEAD"]);
  if (current === latest) return { status: "current", commit: current, message: "GitShip sudah versi terbaru di branch main." };
  try { await git(["merge-base", "--is-ancestor", current, latest]); }
  catch { return { status: "skipped", message: "Riwayat lokal berbeda dengan GitHub; tidak melakukan force/reset." }; }
  if (checkOnly) return { status: "available", from: current, to: latest, message: "Pembaruan GitShip tersedia." };

  // Git will reject untracked file conflicts, never overwrite them silently.
  try { await git(["merge", "--ff-only", latest]); }
  catch { return { status: "skipped", message: "Fast-forward gagal; cek perubahan lokal sebelum update manual." }; }

  try {
    if (install) await install(root);
    else await exec(root, process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund"], 120000, env);
  } catch {
    return { status: "install-failed", from: current, to: latest, message: "Kode sudah diperbarui tetapi npm install gagal. Jalankan 'npm install' dari folder GitShip." };
  }
  return { status: "updated", from: current, to: latest, message: "GitShip diperbarui! Membuka ulang dengan kode terbaru..." };
}

/** Only called after a successful update; prevent a restart/update loop. */
export function restartCLI(env = process.env) {
  const child = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...env, GITSHIP_JUST_UPDATED: "1" }, windowsHide: true
  });
  return child.status ?? 1;
}

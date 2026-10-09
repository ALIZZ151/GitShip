import { input, password, select, confirm } from "@inquirer/prompts";
import boxen from "boxen";
import chalk from "chalk";
import figlet from "figlet";
import gradient from "gradient-string";
import ora from "ora";
import { accountFromEnv, readConfig, writeConfig, clearConfig } from "../config/store.js";
import { createGitHubClient } from "../github/client.js";
import { prepareSource } from "../project/source.js";
import { runUpload } from "../operations/upload.js";
import { AppError, EXIT } from "../shared/errors.js";
import { redact } from "../shared/redact.js";
import { formatPlan } from "./ui.js";
import { readVersion } from "./main.js";
import { resolveAccount, validateAccount, validRepoName, maskToken } from "./commands.js";

const BACK = "__back";
const trim = (s) => s.trim();
const nonEmpty = (m) => (v) => (v.trim() ? true : m);

async function step(text, fn) {
  const sp = ora({ text, spinner: "dots" }).start();
  try { const r = await fn(); sp.succeed(text); return r; } catch (e) { sp.fail(text); throw e; }
}

async function banner(version) {
  if (process.stdout.isTTY) process.stdout.write("\x1Bc");
  console.log(gradient.pastel.multiline(figlet.textSync("ALIZZ", { font: "ANSI Shadow" })));
  console.log(boxen(`${chalk.bold("ALIZZ GitShip")} v${version}\nUpload project ke GitHub dari folder, ZIP, atau file.\n\nDeveloper: ${chalk.bold("ALIZZ")}`, { padding: 1, borderStyle: "round", borderColor: "cyan" }));
}

function showError(e, secrets) {
  const known = e instanceof AppError;
  console.error(boxen(`${chalk.red.bold("ERROR")}\n\n${redact(e.message, secrets)}${known ? `\n\nKode: ${e.code}` : ""}${e.detail ? `\n\n${redact(e.detail, secrets)}` : ""}`, { padding: 1, borderStyle: "round", borderColor: "red" }));
}

async function promptAccount() {
  const username = trim(await input({ message: "Username GitHub", validate: (v) => (/^[A-Za-z0-9-]+$/.test(v.trim()) ? true : "Hanya huruf, angka, dan strip.") }));
  const email = trim(await input({ message: "Email GitHub", validate: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? true : "Format email tidak valid.") }));
  const token = trim(await password({ message: "GitHub Personal Access Token (izin: Contents read/write, Administration untuk buat repo)", mask: "*", validate: nonEmpty("Token tidak boleh kosong.") }));
  return { username, email, token };
}

/** Login yang bisa dipulihkan: retry / login ulang / reset lokal / keluar. Tidak pernah menghapus token karena error jaringan. */
async function loginFlow(d) {
  let account = null, sourceName = null, pending = null;
  while (true) {
    try {
      if (!account) {
        const env = accountFromEnv(d.env);
        if (env.status === "ok") { account = env.account; sourceName = "env"; }
        else if (env.status === "partial") throw new AppError("ENV_PARTIAL", `Environment variable tidak lengkap, kurang: ${env.missing.join(", ")}.`, "Lengkapi ketiganya, atau hapus semuanya untuk memakai config/prompt.", EXIT.USAGE);
        else {
          const cfg = await readConfig(d.configDir);
          if (cfg.status === "ok") { account = cfg.account; sourceName = "config"; }
          else if (cfg.status === "invalid") throw new AppError("CONFIG_INVALID", `Config tersimpan tidak valid (${cfg.reason}).`, "", EXIT.AUTH);
          else { account = await promptAccount(); pending = account; sourceName = "prompt"; }
        }
      }
      const ctx = await step("Validasi akun GitHub", () => validateAccount(account, d));
      if (sourceName === "prompt" && pending) {
        if (await confirm({ message: "Simpan login di device ini? (file 0600, BUKAN terenkripsi)", default: false })) await writeConfig(pending, d.configDir);
      }
      console.log(`✓ Login sebagai ${ctx.user.login} (sumber: ${sourceName}, token ${maskToken(account.token)})`);
      return { account, client: ctx.client };
    } catch (e) {
      if (e?.name === "ExitPromptError") throw e;
      showError(e, [account?.token]);
      const act = await select({ message: "Login bermasalah, mau apa?", choices: [
        { name: "Coba lagi", value: "retry" }, { name: "Login ulang (input manual)", value: "relogin" },
        { name: "Reset login tersimpan (hapus config lokal)", value: "reset" }, { name: "Keluar", value: "exit" }] });
      if (act === "exit") return null;
      if (act === "relogin") { account = await promptAccount(); pending = account; sourceName = "prompt"; }
      if (act === "reset") { await clearConfig(d.configDir); account = null; pending = null; console.log("✓ Config lokal dihapus."); }
    }
  }
}

async function pickRepo(client, d) {
  let keyword = "";
  while (true) {
    const all = await step("Ambil daftar repo (semua halaman)", () => client.listRepositories({ signal: d.signal }));
    const k = keyword.toLowerCase();
    const repos = !k ? all : all.filter((r) => [r.full_name, r.description].some((x) => (x ?? "").toLowerCase().includes(k)));
    const tags = (r) => `${r.private ? "🔒" : "🌐"}${r.archived ? " [arsip/read-only]" : ""}${r.permissions?.push === false ? " [tanpa izin push]" : ""}`;
    const choice = await select({ message: `${repos.length} repo${keyword ? ` untuk "${keyword}"` : ""} — pilih`, pageSize: 15, choices: [
      ...repos.map((r) => ({ name: `${r.full_name} ${tags(r)}`, value: r.full_name, description: r.description || `Updated: ${r.updated_at ?? "-"}` })),
      { name: "Cari dengan keyword lain", value: "__search" }, { name: "Batal", value: BACK }] });
    if (choice === BACK) return null;
    if (choice === "__search") { keyword = trim(await input({ message: "Keyword", validate: nonEmpty("Keyword wajib diisi.") })); continue; }
    return repos.find((r) => r.full_name === choice);
  }
}

async function askSource() {
  while (true) {
    const raw = trim(await input({ message: 'Path FOLDER / file ZIP / file (ketik "batal" untuk kembali)', validate: nonEmpty("Path tidak boleh kosong.") }));
    if (raw.toLowerCase() === "batal") return null;
    try { return await step("Baca & saring project", () => prepareSource(raw)); }
    catch (e) { if (!(e instanceof AppError)) throw e; showError(e); }
  }
}

async function chooseRoot(src) {
  if (src.kind === "zip" && src.candidates.length > 1) console.log(`ZIP punya beberapa item di root (${src.candidates.join(", ")}); root dipertahankan apa adanya.`);
}

async function finish(result) {
  if (result.status === "cancelled") return console.log("✕ Dibatalkan. Tidak ada perubahan.");
  if (result.status === "noop") return console.log("✓ Tidak ada perubahan; commit/push dilewati.");
  if (result.status === "uncertain") return console.log(chalk.yellow(`! Hasil push TIDAK PASTI. Periksa ${result.repoUrl} sebelum mencoba lagi. ${result.detail ?? ""}`));
  console.log(boxen(`${chalk.green.bold("DONE")}\n\nRepo  : ${result.repoUrl}\nBranch: ${result.branch}\nCommit: ${result.intendedSha}`, { padding: 1, borderStyle: "round", borderColor: "green" }));
}

async function updateFlow(ctx, d) {
  const repo = await pickRepo(ctx.client, d);
  if (!repo) return;
  if (repo.archived) throw new AppError("REPO_ARCHIVED", "Repo diarsipkan (read-only).", repo.html_url, EXIT.AUTH);
  let branch = repo.default_branch;
  const branches = await step("Ambil daftar branch", () => ctx.client.listBranches(repo.owner.login, repo.name, d.signal));
  branch = await select({ message: "Branch target", choices: [...branches.sort((a, b) => (a === repo.default_branch ? -1 : b === repo.default_branch ? 1 : 0)).map((b) => ({ name: b === repo.default_branch ? `${b} (default)` : b, value: b })), { name: "Batal", value: BACK }] });
  if (branch === BACK) return;
  const mode = await select({ message: "Mode", choices: [
    { name: "replace — file target yang tidak ada di sumber DIHAPUS (perilaku lama)", value: "replace" },
    { name: "overlay — tambah/ubah saja, file target lain dipertahankan", value: "overlay" }, { name: "Batal", value: BACK }] });
  if (mode === BACK) return;
  const src = await askSource();
  if (!src) return;
  try {
    await chooseRoot(src);
    const message = trim(await input({ message: "Pesan commit (kosong = default)", default: "" }));
    const result = await runUpload({
      manifest: src.manifest, mode, message, account: ctx.account, token: ctx.account.token, signal: d.signal, allowLocalRemote: !!d.allowLocalRemote, lockKey: `${ctx.account.username}/${repo.full_name}@${branch}`,
      target: { kind: "existing", cloneUrl: repo.clone_url, htmlUrl: repo.html_url, branch, defaultBranch: repo.default_branch },
      confirm: async (plan) => {
        console.log(boxen(formatPlan(plan), { padding: 1, borderStyle: "double", borderColor: plan.counts.deleted ? "yellow" : "blue" }));
        if (mode === "replace") return trim(await input({ message: 'Ketik "YA UPDATE REPO" untuk lanjut' })) === "YA UPDATE REPO";
        return confirm({ message: "Lanjut commit & push?", default: false });
      }
    });
    await finish(result);
  } finally { await src.cleanup(); }
}

async function newFlow(ctx, d) {
  const name = trim(await input({ message: "Nama repo baru (kosongkan untuk batal)", validate: (v) => (!v.trim() || validRepoName(v.trim()) ? true : "Nama repo tidak valid.") }));
  if (!name) return;
  const src = await askSource();
  if (!src) return;
  try {
    await chooseRoot(src);
    const visibility = await select({ message: "Visibility repo baru", default: "public", choices: [{ name: "public", value: "public" }, { name: "private", value: "private" }, { name: "Batal", value: BACK }] });
    if (visibility === BACK) return;
    const message = trim(await input({ message: "Pesan commit (kosong = default)", default: "" }));
    console.log("Catatan: repo dibuat di akun pribadi (organization belum didukung).");
    const result = await runUpload({
      manifest: src.manifest, mode: "replace", message, account: ctx.account, token: ctx.account.token, signal: d.signal, allowLocalRemote: !!d.allowLocalRemote, lockKey: `${ctx.account.username}/${name}@main`,
      target: { kind: "new", branch: "main", name, createRepo: async () => { const r = await step("Buat repository", () => ctx.client.createRepository(name, visibility, d.signal)); return { cloneUrl: r.clone_url, htmlUrl: r.html_url }; } },
      confirm: async (plan) => {
        console.log(boxen(`${formatPlan(plan)}\nVisibility: ${visibility}`, { padding: 1, borderStyle: "round", borderColor: "blue" }));
        return confirm({ message: `Buat repo ${visibility} "${name}" lalu push?`, default: false });
      }
    });
    await finish(result);
  } finally { await src.cleanup(); }
}

export async function runMenu(d) {
  await banner(await readVersion());
  const ctx = await loginFlow(d);
  if (!ctx) return EXIT.OK;
  while (true) {
    const mode = await select({ message: "Mau ngapain hari ini?", choices: [
      { name: "Update repo lama — pilih repo dari list GitHub", value: "update" },
      { name: "Deploy repo baru — upload folder/ZIP/file", value: "new" },
      { name: "Reset login tersimpan", value: "reset" }, { name: "Keluar", value: "exit" }] });
    try {
      if (mode === "exit") { console.log("Selesai. Sampai jumpa."); return EXIT.OK; }
      if (mode === "update") await updateFlow(ctx, d);
      if (mode === "new") await newFlow(ctx, d);
      if (mode === "reset" && (await confirm({ message: "Hapus login tersimpan di device ini?", default: false }))) {
        await clearConfig(d.configDir); console.log("✓ Login tersimpan dihapus.");
        const again = await loginFlow(d); if (!again) return EXIT.OK; Object.assign(ctx, again);
      }
    } catch (e) {
      if (e?.name === "ExitPromptError") throw e;
      showError(e, [ctx.account.token]); // kesalahan operasi kembali ke menu, bukan keluar
    }
  }
}

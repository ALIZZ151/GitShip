#!/usr/bin/env node

import { input, password, select, confirm } from "@inquirer/prompts";
import boxen from "boxen";
import chalk from "chalk";
import figlet from "figlet";
import gradient from "gradient-string";
import ora from "ora";
import AdmZip from "adm-zip";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";

const APP_NAME = "ALIZZ GitShip";
const APP_VERSION = "2.2.0";
const DEVELOPER = "ALIZZ";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_NEW_REPO_BRANCH = "main";
const CONFIG_DIR = path.join(os.homedir(), ".alizz-gitship");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const NEW_REPO_PRIVATE = false;

const theme = {
  brand: chalk.hex("#00E5FF"),
  purple: chalk.hex("#A855F7"),
  green: chalk.hex("#22C55E"),
  yellow: chalk.hex("#FACC15"),
  red: chalk.hex("#EF4444"),
  gray: chalk.hex("#94A3B8"),
  muted: chalk.hex("#64748B"),
  white: chalk.hex("#F8FAFC")
};

class AppError extends Error {
  constructor(code, message, detail = "") {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
  }
}

function clearScreen() {
  if (process.stdout.isTTY) process.stdout.write("\x1Bc");
}

function printBanner() {
  clearScreen();

  const title = figlet.textSync("ALIZZ", {
    font: "ANSI Shadow",
    horizontalLayout: "default",
    verticalLayout: "default"
  });

  console.log(gradient.pastel.multiline(title));

  console.log(
    boxen(
      `${theme.white.bold(APP_NAME)} ${theme.muted(`v${APP_VERSION}`)}\n` +
        `${theme.gray("Upload project ke GitHub dari folder atau file ZIP.")}\n\n` +
        `${theme.green("✓")} Login sekali, akun/token disimpan lokal di device\n` +
        `${theme.green("✓")} Update repo lama: pilih repo dari list, tanpa paste link\n` +
        `${theme.green("✓")} Deploy repo baru: create repo baru lalu upload project\n` +
        `${theme.green("✓")} Setelah selesai, balik ke menu utama\n\n` +
        `${theme.purple("Developer:")} ${theme.white.bold(DEVELOPER)}`,
      {
        padding: 1,
        margin: { top: 0, bottom: 1 },
        borderStyle: "round",
        borderColor: "cyan"
      }
    )
  );
}

function printSection(title) {
  console.log("\n" + theme.brand.bold(`◆ ${title}`));
  console.log(theme.muted("─".repeat(Math.min(title.length + 4, 42))));
}

function printMiniInfo(lines) {
  console.log(
    boxen(lines.join("\n"), {
      padding: 1,
      borderStyle: "round",
      borderColor: "blue"
    })
  );
}

function normalizeInputPath(rawPath) {
  return path.resolve(rawPath.trim().replace(/^[']|[']$/g, "").replace(/^[\"]|[\"]$/g, ""));
}

function validateEmail(email) {
  const value = email.trim();
  if (!value) return "Email tidak boleh kosong.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Format email tidak valid.";
  return true;
}

function validateUsername(username) {
  const value = username.trim();
  if (!value) return "Username GitHub tidak boleh kosong.";
  if (!/^[a-zA-Z0-9-]+$/.test(value)) return "Username GitHub hanya boleh berisi huruf, angka, dan strip.";
  return true;
}

function validateRepoName(name) {
  const value = name.trim();
  if (!value) return "Nama repo tidak boleh kosong.";
  if (value.length > 100) return "Nama repo terlalu panjang.";
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) return "Nama repo hanya boleh berisi huruf, angka, titik, underscore, dan strip.";
  if (value === "." || value === "..") return "Nama repo tidak valid.";
  if (value.endsWith(".git")) return "Masukkan nama repo tanpa akhiran .git.";
  return true;
}

async function pathExists(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

async function ensureProjectPath(projectPath) {
  const stat = await pathExists(projectPath);
  if (!stat) throw new AppError("PROJECT_NOT_FOUND", "Folder/file project tidak ditemukan.", projectPath);
  if (!stat.isDirectory() && !stat.isFile()) throw new AppError("PROJECT_NOT_SUPPORTED", "Path project harus berupa folder atau file.", projectPath);
  return stat;
}

function isZipFile(filePath) {
  return path.extname(filePath).toLowerCase() === ".zip";
}

async function extractZipSafely(zipPath, outputDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (!entries.length) throw new AppError("ZIP_EMPTY", "File ZIP kosong.", zipPath);

  await fs.mkdir(outputDir, { recursive: true });
  const safeRoot = `${path.resolve(outputDir)}${path.sep}`;

  for (const entry of entries) {
    const entryName = entry.entryName.replace(/\\/g, "/");
    if (!entryName || entryName.includes("\0")) continue;

    const targetPath = path.resolve(outputDir, entryName);
    if (!targetPath.startsWith(safeRoot)) {
      throw new AppError("ZIP_UNSAFE_PATH", "File ZIP punya path yang tidak aman, proses dibatalkan.", entry.entryName);
    }

    if (entry.isDirectory) {
      await fs.mkdir(targetPath, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entry.getData());
  }
}

function isJunkRootName(name) {
  return name === "__MACOSX" || name.startsWith(".");
}

async function detectProjectRoot(extractedDir) {
  const entries = await fs.readdir(extractedDir, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => !isJunkRootName(entry.name));
  if (visibleEntries.length === 1 && visibleEntries[0].isDirectory()) return path.join(extractedDir, visibleEntries[0].name);
  return extractedDir;
}

async function prepareProjectSource(rawProjectPath) {
  const projectPath = normalizeInputPath(rawProjectPath);
  const stat = await ensureProjectPath(projectPath);

  if (!stat.isFile()) {
    return { sourcePath: projectPath, originalPath: projectPath, kind: "folder", cleanup: async () => {} };
  }

  if (!isZipFile(projectPath)) {
    return { sourcePath: projectPath, originalPath: projectPath, kind: "file", cleanup: async () => {} };
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alizz-gitship-zip-"));
  const extractedDir = path.join(tempRoot, "extracted");

  try {
    await withSpinner("Extract file ZIP project", async () => extractZipSafely(projectPath, extractedDir));
    const sourcePath = await detectProjectRoot(extractedDir);
    return {
      sourcePath,
      originalPath: projectPath,
      kind: "zip",
      cleanup: async () => fs.rm(tempRoot, { recursive: true, force: true })
    };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function printProjectPathHelp() {
  printMiniInfo([
    `${theme.white.bold("Cara isi path project:")}`,
    `${theme.green("✓")} Bisa folder project yang sudah diextract`,
    `${theme.green("✓")} Bisa file .zip, nanti tools extract otomatis`,
    ``,
    `${theme.gray("Contoh Termux folder:")}`,
    `${theme.brand("/sdcard/Download/ALIZZ-STORE v4/ALIZZ-STORE--main")}`,
    `${theme.gray("Contoh Termux ZIP:")}`,
    `${theme.brand("/sdcard/Download/ALIZZ-STORE-v4.zip")}`
  ]);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (error) => {
      if (error.code === "ENOENT" && command === "git") {
        reject(new AppError("GIT_NOT_INSTALLED", "Git belum terinstall atau belum masuk PATH.", "Install Git dulu. Di Termux: pkg install git -y"));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      reject(new AppError("COMMAND_FAILED", `Command gagal: ${command} ${args.join(" ")}`, stderr.trim() || stdout.trim()));
    });
  });
}

function getGitAuthArgs(token) {
  const basicToken = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicToken}`];
}

async function runGit(args, options = {}) {
  const finalArgs = options.token ? [...getGitAuthArgs(options.token), ...args] : args;
  try {
    return await runCommand("git", finalArgs, { cwd: options.cwd });
  } catch (error) {
    throw mapGitError(error);
  }
}

function mapGitError(error) {
  const detail = `${error.detail || ""}\n${error.message || ""}`;

  if (/Authentication failed|could not read Username|403|denied|Invalid username or password/i.test(detail)) {
    return new AppError("INVALID_TOKEN", "Token GitHub tidak valid atau permission token kurang.", detail);
  }

  if (/repository .* not found|Repository not found|not found/i.test(detail)) {
    return new AppError("REPO_NOT_FOUND", "Repository tidak ditemukan atau token tidak punya akses.", detail);
  }

  if (/Could not resolve host|Failed to connect|timed out|Connection refused|network|unable to access/i.test(detail)) {
    return new AppError("NETWORK_ERROR", "Koneksi internet bermasalah atau GitHub tidak bisa diakses.", detail);
  }

  return error;
}

async function withSpinner(text, action) {
  const spinner = ora({ text, spinner: "dots" }).start();
  try {
    const result = await action();
    spinner.succeed(theme.green(text));
    return result;
  } catch (error) {
    spinner.fail(theme.red(text));
    throw error;
  }
}

async function ensureGitInstalled() {
  await withSpinner("Cek Git di device", async () => runCommand("git", ["--version"]));
}

async function githubApi(token, endpoint, options = {}) {
  let response;
  try {
    response = await fetch(`${GITHUB_API}${endpoint}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    throw new AppError("NETWORK_ERROR", "Koneksi internet bermasalah atau GitHub API tidak bisa diakses.", error.message);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  const message = data?.message || response.statusText || "GitHub API error";

  if (!response.ok) {
    if (response.status === 401) throw new AppError("INVALID_TOKEN", "Token GitHub tidak valid.", message);
    if (response.status === 403) throw new AppError("INVALID_TOKEN", "Token GitHub tidak punya permission yang cukup atau terkena limit.", message);
    if (response.status === 404) throw new AppError("REPO_NOT_FOUND", "Repository tidak ditemukan atau token tidak punya akses.", message);
    if (response.status === 422) throw new AppError("REPO_NAME_USED", "Nama repository sudah digunakan atau input tidak valid.", message);
    throw new AppError("GITHUB_API_ERROR", `GitHub API error: ${response.status}`, message);
  }

  return data;
}

async function readLocalConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    const config = JSON.parse(raw);
    if (!config.username || !config.email || !config.token) return null;
    return config;
  } catch {
    return null;
  }
}

async function saveLocalConfig(account) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(
    CONFIG_FILE,
    JSON.stringify(
      {
        username: account.username,
        email: account.email,
        token: account.token,
        savedAt: new Date().toISOString()
      },
      null,
      2
    ),
    { mode: 0o600 }
  );

  try {
    await fs.chmod(CONFIG_FILE, 0o600);
  } catch {}
}

async function clearLocalConfig() {
  await fs.rm(CONFIG_FILE, { force: true });
}

function maskToken(token) {
  if (!token) return "-";
  if (token.length <= 10) return "********";
  return `${token.slice(0, 4)}${"*".repeat(8)}${token.slice(-4)}`;
}

async function getAccount() {
  printSection("Akun GitHub");

  const envUsername = process.env.GITHUB_USERNAME?.trim();
  const envEmail = process.env.GITHUB_EMAIL?.trim();
  const envToken = process.env.GITHUB_TOKEN?.trim();

  if (envUsername && envEmail && envToken) {
    printMiniInfo([
      `${theme.green("✓")} Login pakai environment variable`,
      `${theme.gray("Username:")} ${theme.white.bold(envUsername)}`,
      `${theme.gray("Email   :")} ${theme.white.bold(envEmail)}`,
      `${theme.gray("Token   :")} ${theme.white.bold(maskToken(envToken))}`
    ]);
    return { username: envUsername, email: envEmail, token: envToken };
  }

  const savedAccount = await readLocalConfig();
  if (savedAccount) {
    printMiniInfo([
      `${theme.green("✓")} Login otomatis dari config lokal`,
      `${theme.gray("Username:")} ${theme.white.bold(savedAccount.username)}`,
      `${theme.gray("Email   :")} ${theme.white.bold(savedAccount.email)}`,
      `${theme.gray("Token   :")} ${theme.white.bold(maskToken(savedAccount.token))}`,
      ``,
      `${theme.yellow("!")} Token tidak ditanam di repo GitHub. Token hanya tersimpan di device ini.`
    ]);
    return savedAccount;
  }

  console.log(theme.gray("Login pertama kali. Data akun akan disimpan lokal supaya besok tidak input ulang."));

  const username = await input({ message: "Username GitHub", validate: validateUsername });
  const email = await input({ message: "Email GitHub", validate: validateEmail });
  const token = await password({
    message: "GitHub Personal Access Token",
    mask: "*",
    validate(value) {
      return value.trim() ? true : "Token tidak boleh kosong.";
    }
  });

  return { username: username.trim(), email: email.trim(), token: token.trim() };
}

async function validateToken(token) {
  return githubApi(token, "/user");
}

async function validateAccount(account) {
  const githubUser = await withSpinner("Validasi akun GitHub", async () => validateToken(account.token));

  if (githubUser.login.toLowerCase() !== account.username.toLowerCase()) {
    throw new AppError(
      "USERNAME_TOKEN_MISMATCH",
      "Username tidak cocok dengan token GitHub.",
      `Token ini terhubung ke akun: ${githubUser.login}, tapi username yang dimasukkan: ${account.username}`
    );
  }

  await saveLocalConfig(account);

  printMiniInfo([
    `${theme.green("✓")} Akun GitHub valid`,
    `${theme.gray("Username:")} ${theme.white.bold(githubUser.login)}`,
    `${theme.gray("Email   :")} ${theme.white.bold(account.email)}`,
    `${theme.gray("Config  :")} ${theme.white.bold(CONFIG_FILE)}`
  ]);

  return githubUser;
}

async function getRepository(token, owner, repo) {
  return githubApi(token, `/repos/${owner}/${repo}`);
}

async function createRepository(token, repoName) {
  return githubApi(token, "/user/repos", {
    method: "POST",
    body: { name: repoName, private: NEW_REPO_PRIVATE, auto_init: false }
  });
}

async function listRepositories(token, keyword = "") {
  const repos = [];
  const search = keyword.trim().toLowerCase();

  for (let page = 1; page <= 5; page++) {
    const batch = await githubApi(
      token,
      `/user/repos?per_page=100&page=${page}&sort=updated&direction=desc&affiliation=owner,collaborator,organization_member`
    );

    if (!Array.isArray(batch) || !batch.length) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }

  if (!search) return repos;

  return repos.filter((repo) => {
    const fullName = repo.full_name?.toLowerCase() || "";
    const name = repo.name?.toLowerCase() || "";
    const desc = repo.description?.toLowerCase() || "";
    return fullName.includes(search) || name.includes(search) || desc.includes(search);
  });
}

async function chooseRepository(account) {
  printSection("Pilih Repository Target");

  let keyword = "";

  while (true) {
    const repos = await withSpinner(
      keyword ? `Ambil list repo GitHub dengan keyword: ${keyword}` : "Ambil list repo GitHub terbaru",
      async () => listRepositories(account.token, keyword)
    );

    if (!repos.length) {
      console.log(theme.yellow("Tidak ada repo yang cocok."));
      keyword = await input({ message: "Masukkan keyword repo lain", validate: (value) => (value.trim() ? true : "Keyword wajib diisi.") });
      continue;
    }

    const shownRepos = repos.slice(0, 30);
    const choice = await select({
      message: keyword ? `Pilih repo hasil pencarian "${keyword}"` : "Pilih repo yang mau diupdate",
      choices: [
        ...shownRepos.map((repo) => ({
          name: `${repo.full_name}${repo.private ? " 🔒" : " 🌐"}`,
          value: repo.full_name,
          description: repo.description || `Updated: ${repo.updated_at || "-"}`
        })),
        { name: "Cari repo pakai keyword lain", value: "__search", description: "Gunakan ini kalau repo belum muncul di list." },
        { name: "Batal", value: "__cancel", description: "Kembali ke menu utama." }
      ]
    });

    if (choice === "__cancel") return null;

    if (choice === "__search") {
      keyword = await input({ message: "Keyword nama repo", validate: (value) => (value.trim() ? true : "Keyword wajib diisi.") });
      continue;
    }

    const selected = repos.find((repo) => repo.full_name === choice);
    if (!selected) throw new AppError("REPO_NOT_FOUND", "Repository pilihan tidak ditemukan di list lokal.", choice);
    return selected;
  }
}

async function cleanDirectoryExceptGit(repoDir) {
  const entries = await fs.readdir(repoDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    await fs.rm(path.join(repoDir, entry.name), { recursive: true, force: true });
  }
}

async function copyProjectIntoRepo(projectPath, repoDir) {
  const stat = await ensureProjectPath(projectPath);

  if (stat.isFile()) {
    await fs.copyFile(projectPath, path.join(repoDir, path.basename(projectPath)));
    return;
  }

  const items = await fs.readdir(projectPath);
  for (const item of items) {
    if (item === ".git") continue;
    const source = path.join(projectPath, item);
    const target = path.join(repoDir, item);
    await fs.cp(source, target, {
      recursive: true,
      filter(sourcePath) {
        return path.basename(sourcePath) !== ".git";
      }
    });
  }
}

async function setupGitIdentity(repoDir, account) {
  await runGit(["config", "user.name", account.username], { cwd: repoDir });
  await runGit(["config", "user.email", account.email], { cwd: repoDir });
}

async function commitAndPush(repoDir, token, branch, message) {
  await runGit(["add", "-A"], { cwd: repoDir });
  await runGit(["commit", "--allow-empty", "-m", message], { cwd: repoDir });
  await runGit(["push", "origin", `HEAD:${branch}`], { cwd: repoDir, token });
}

async function updateExistingRepository(account) {
  const token = account.token;

  printSection("Update Repo Lama");

  const repository = await chooseRepository(account);
  if (!repository) return;

  printProjectPathHelp();

  const projectInput = await input({
    message: "Masukkan path FOLDER atau file ZIP project baru",
    validate(value) {
      return value.trim() ? true : "Path project tidak boleh kosong.";
    }
  });

  const projectSource = await prepareProjectSource(projectInput);
  const projectPath = projectSource.sourcePath;
  const defaultBranch = repository.default_branch || DEFAULT_NEW_REPO_BRANCH;

  console.log(
    boxen(
      `${theme.yellow.bold("WARNING — AKSI DESTRUKTIF DI REPO TARGET")}\n\n` +
        `${theme.white("Repo target :")} ${repository.html_url}\n` +
        `${theme.white("Branch      :")} ${defaultBranch}\n` +
        `${theme.white("Input project:")} ${projectSource.originalPath}\n` +
        `${theme.white("Tipe input   :")} ${projectSource.kind}\n` +
        `${theme.white("Yang diupload:")} ${projectPath}\n\n` +
        `${theme.red("Semua file lama di repository target akan dihapus.")}\n` +
        `${theme.green("File lokal kamu tidak akan dihapus.")}\n\n` +
        `Lanjut hanya kalau kamu yakin repo target sudah benar.`,
      { padding: 1, borderStyle: "double", borderColor: "yellow" }
    )
  );

  const confirmation = await input({
    message: 'Ketik "YA UPDATE REPO" untuk gas update',
    validate(value) {
      return value.trim() ? true : "Konfirmasi wajib diisi.";
    }
  });

  if (confirmation.trim() !== "YA UPDATE REPO") {
    console.log(theme.red("\n✕ Proses dibatalkan. Tidak ada file yang dihapus."));
    await projectSource.cleanup();
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alizz-deploy-update-"));
  const repoDir = path.join(tempRoot, "repo");

  try {
    await withSpinner("Clone repository target", async () => {
      await runGit(["clone", "--depth", "1", "--branch", defaultBranch, repository.clone_url, repoDir], { token });
    });

    await withSpinner("Bersihkan isi lama di clone repo", async () => cleanDirectoryExceptGit(repoDir));
    await withSpinner("Copy project baru", async () => copyProjectIntoRepo(projectPath, repoDir));
    await withSpinner("Set identitas commit", async () => setupGitIdentity(repoDir, account));
    await withSpinner("Commit dan push ke GitHub", async () => commitAndPush(repoDir, token, defaultBranch, "Update project deployment"));

    console.log(
      boxen(
        `${theme.green.bold("DONE — Repo lama berhasil diupdate!")}\n\n` +
          `${theme.white("Repo  :")} ${repository.html_url}\n` +
          `${theme.white("Branch:")} ${defaultBranch}\n\n` +
          `${theme.gray("Tools tidak keluar otomatis. Kamu akan balik ke menu utama.")}`,
        { padding: 1, borderStyle: "round", borderColor: "green" }
      )
    );
  } finally {
    await projectSource.cleanup();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function deployNewRepository(account) {
  const token = account.token;

  printSection("Deploy Repo Baru");

  const repoName = await input({ message: "Nama repo GitHub baru / nama website", validate: validateRepoName });

  printProjectPathHelp();

  const projectInput = await input({
    message: "Masukkan path FOLDER atau file ZIP project yang mau diupload",
    validate(value) {
      return value.trim() ? true : "Path project tidak boleh kosong.";
    }
  });

  const projectSource = await prepareProjectSource(projectInput);
  const projectPath = projectSource.sourcePath;

  printMiniInfo([
    `${theme.green("✓")} Project siap diupload`,
    `${theme.gray("Input   :")} ${projectSource.originalPath}`,
    `${theme.gray("Tipe    :")} ${projectSource.kind}`,
    `${theme.gray("Upload  :")} ${projectPath}`
  ]);

  const repository = await withSpinner("Buat repository GitHub baru", async () => createRepository(token, repoName.trim()));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alizz-deploy-new-"));
  const repoDir = path.join(tempRoot, "repo");

  try {
    await fs.mkdir(repoDir, { recursive: true });

    await withSpinner("Setup Git lokal sementara", async () => {
      await runGit(["init"], { cwd: repoDir });
      await runGit(["checkout", "-B", DEFAULT_NEW_REPO_BRANCH], { cwd: repoDir });
      await runGit(["remote", "add", "origin", repository.clone_url], { cwd: repoDir });
    });

    await withSpinner("Copy project ke repo baru", async () => copyProjectIntoRepo(projectPath, repoDir));
    await withSpinner("Set identitas commit", async () => setupGitIdentity(repoDir, account));
    await withSpinner("Commit dan push ke GitHub", async () => commitAndPush(repoDir, token, DEFAULT_NEW_REPO_BRANCH, "Initial project deployment"));

    console.log(
      boxen(
        `${theme.green.bold("DONE — Repo baru berhasil dibuat!")}\n\n` +
          `${theme.white("Repo baru:")} ${repository.html_url}\n` +
          `${theme.white("Branch   :")} ${DEFAULT_NEW_REPO_BRANCH}\n\n` +
          `${theme.gray("Tools tidak keluar otomatis. Kamu akan balik ke menu utama.")}`,
        { padding: 1, borderStyle: "round", borderColor: "green" }
      )
    );
  } finally {
    await projectSource.cleanup();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function printFriendlyError(error) {
  console.log("");

  if (error?.name === "ExitPromptError" || error?.message?.includes("User force closed")) {
    console.error(theme.yellow("Proses dihentikan."));
    return;
  }

  if (error instanceof AppError) {
    console.error(
      boxen(
        `${theme.red.bold("ERROR")}\n\n` +
          `${theme.white(error.message)}\n\n` +
          `${theme.gray("Kode:")} ${error.code}` +
          (error.detail ? `\n\n${theme.gray("Detail:")}\n${error.detail}` : ""),
        { padding: 1, borderStyle: "round", borderColor: "red" }
      )
    );
    return;
  }

  console.error(boxen(`${theme.red.bold("ERROR")}\n\nTerjadi error tidak dikenal.\n${String(error)}`, { padding: 1, borderStyle: "round", borderColor: "red" }));
}

async function chooseMode() {
  printSection("Pilih Mode");

  return select({
    message: "Mau ngapain hari ini?",
    choices: [
      {
        name: "Update repo lama — pilih repo dari list GitHub",
        value: "update",
        description: "Tidak perlu paste link repo. Tinggal pilih repo, lalu input folder/ZIP."
      },
      {
        name: "Deploy repo baru — upload folder atau ZIP project",
        value: "new",
        description: "Tools membuat repo baru, extract ZIP kalau perlu, lalu upload project."
      },
      {
        name: "Reset login tersimpan",
        value: "reset-login",
        description: "Hapus config lokal supaya bisa login dengan token lain."
      },
      {
        name: "Keluar",
        value: "exit",
        description: "Tutup GitShip."
      }
    ]
  });
}

async function main() {
  try {
    printBanner();
    await ensureGitInstalled();

    let account = await getAccount();
    await validateAccount(account);

    while (true) {
      const mode = await chooseMode();

      if (mode === "update") {
        await updateExistingRepository(account);
        continue;
      }

      if (mode === "new") {
        await deployNewRepository(account);
        continue;
      }

      if (mode === "reset-login") {
        const ok = await confirm({ message: "Yakin hapus login tersimpan di device ini?", default: false });
        if (ok) {
          await clearLocalConfig();
          console.log(theme.green("✓ Login tersimpan berhasil dihapus."));
          account = await getAccount();
          await validateAccount(account);
        }
        continue;
      }

      if (mode === "exit") {
        console.log(theme.green("Selesai. Sampai jumpa lagi bos."));
        return;
      }
    }
  } catch (error) {
    printFriendlyError(error);
    process.exitCode = 1;
  }
}

main();
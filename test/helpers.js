import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
export const sh = (args, cwd) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
export const tmp = (p = "t") => fs.mkdtemp(path.join(os.tmpdir(), `gitship-test-${p}-`));

export async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

export async function hashDir(root) {
  const h = crypto.createHash("sha256");
  const walk = async (d) => {
    for (const e of (await fs.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      h.update(path.relative(root, p));
      if (e.isDirectory()) await walk(p); else if (e.isFile()) h.update(await fs.readFile(p));
    }
  };
  await walk(root);
  return h.digest("hex");
}

/** Remote bare lokal; seed opsional {branch: {file: content}} */
export async function makeRemote(seed) {
  const bare = path.join(await tmp("remote"), "r.git");
  sh(["init", "--bare", "-q", "-b", "main", bare]);
  if (seed) {
    const w = await tmp("seed");
    sh(["init", "-q", "-b", seed.branch || "main", w]);
    await writeTree(w, seed.files);
    sh(["add", "-A", "-f"], w); sh(["commit", "-q", "-m", "seed"], w);
    sh(["push", "-q", pathToFileURL(bare).href, `HEAD:refs/heads/${seed.branch || "main"}`], w);
  }
  return { bare, url: pathToFileURL(bare).href, sha: (b = "main") => { try { return sh(["rev-parse", `refs/heads/${b}`], bare); } catch { return null; } }, count: (b = "main") => Number(sh(["rev-list", "--count", `refs/heads/${b}`], bare)), files: (b = "main") => sh(["ls-tree", "-r", "--name-only", `refs/heads/${b}`], bare).split("\n").filter(Boolean) };
}

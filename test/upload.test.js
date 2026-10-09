import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildManifest } from "../src/project/policy.js";
import { runUpload } from "../src/operations/upload.js";
import { tmp, writeTree, hashDir, makeRemote, sh } from "./helpers.js";

const account = { username: "alizz", email: "a@x.io" };
const yes = async () => true;
const base = { account, allowLocalRemote: true, confirm: yes };
const leftovers = async () => (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("gitship-op-"));

test("policy: nested .gitignore + negation, dotfile penting, .env diblokir, template aman, spasi/Unicode, sumber tidak berubah", async () => {
  const src = await writeTree(await tmp("src"), {
    ".gitignore": "*.tmp\n!keep.tmp\n",
    "a.tmp": "x", "keep.tmp": "y", "sub/.gitignore": "secret-out.txt\n", "sub/secret-out.txt": "x", "sub/ok.txt": "ok",
    ".github/workflows/ci.yml": "on: push", "dist/app.js": "1", "package-lock.json": "{}",
    ".env": "TOKEN=abc", ".env.production": "X=1", ".env.example": "TOKEN=isi_sendiri",
    "bocor.env.example": "x", "cfg/.env.sample": "K=ghp_" + "a".repeat(36),
    "node_modules/x/i.js": "1", "key.pem": "x", "id_rsa": "x",
    "folder spasi/файл ü.txt": "u", "app.log": "l"
  });
  const before = await hashDir(src);
  const m = await buildManifest(src);
  const rels = m.files.map((f) => f.rel);
  for (const want of [".gitignore", "keep.tmp", "sub/ok.txt", ".github/workflows/ci.yml", "dist/app.js", "package-lock.json", ".env.example", "folder spasi/файл ü.txt", "bocor.env.example"]) assert.ok(rels.includes(want), `harus ada: ${want}`);
  for (const no of ["a.tmp", "sub/secret-out.txt", ".env", ".env.production", "node_modules/x/i.js", "key.pem", "id_rsa", "cfg/.env.sample", "app.log"]) assert.ok(!rels.includes(no), `tidak boleh: ${no}`);
  assert.ok(m.blocked.some((b) => b.rel === "cfg/.env.sample"));
  assert.equal(await hashDir(src), before);
});

test("policy: symlink ditolak, folder kosong menghasilkan 0 file, file tunggal", async () => {
  const src = await writeTree(await tmp("sl"), { "a.txt": "a" });
  await fs.symlink("/etc/passwd", path.join(src, "link"));
  await assert.rejects(buildManifest(src), { code: "SYMLINK_UNSUPPORTED" });
  assert.equal((await buildManifest(await tmp("empty"))).files.length, 0);
  const single = await writeTree(await tmp("one"), { "satu file.txt": "x" });
  assert.deepEqual((await buildManifest(path.join(single, "satu file.txt"))).files.map((f) => f.rel), ["satu file.txt"]);
});

test("repo baru: private/public mengikuti pilihan, create hanya setelah konfirmasi, tree sesuai", async () => {
  const src = await writeTree(await tmp("n"), { "index.html": "<h1>hi</h1>", ".gitignore": "x\n", ".env": "S=1" });
  const remote = await makeRemote();
  let created = 0;
  const target = { kind: "new", branch: "main", name: "demo", createRepo: async () => (created++, { cloneUrl: remote.url, htmlUrl: "https://github.com/alizz/demo" }) };
  const manifest = await buildManifest(src);
  const dry = await runUpload({ ...base, manifest, target, dryRun: true });
  assert.equal(dry.status, "dry-run"); assert.equal(created, 0); assert.equal(remote.sha(), null);
  const cancel = await runUpload({ ...base, manifest, target, confirm: async () => false });
  assert.equal(cancel.status, "cancelled"); assert.equal(created, 0);
  const r = await runUpload({ ...base, manifest, target });
  assert.equal(r.status, "pushed"); assert.equal(created, 1);
  assert.deepEqual(remote.files().sort(), [".gitignore", "index.html"]);
  assert.equal(remote.sha(), r.intendedSha);
  assert.equal(sh(["log", "-1", "--format=%s", "refs/heads/main"], remote.bare), "Initial project deployment");
  assert.equal(await leftovers().then((l) => l.length), 0);
});

test("snapshot kosong setelah filter: repo tidak dibuat", async () => {
  const src = await writeTree(await tmp("e"), { ".env": "S=1" });
  let created = 0;
  await assert.rejects(runUpload({ ...base, manifest: await buildManifest(src), target: { kind: "new", branch: "main", createRepo: async () => created++ } }), { code: "EMPTY_SNAPSHOT" });
  assert.equal(created, 0);
});

test("existing replace: hapus target-only, parent diteruskan, tanpa force; overlay mempertahankan", async () => {
  const seed = { files: { "README.md": "r", "LICENSE": "l", "keep.txt": "k", ".github/w.yml": "w" } };
  const src = await writeTree(await tmp("s"), { "keep.txt": "baru", "new.txt": "n" });
  const manifest = await buildManifest(src);

  const rep = await makeRemote(seed);
  const seedSha = rep.sha();
  const plans = [];
  const r = await runUpload({ ...base, manifest, mode: "replace", message: "custom msg", confirm: async (p) => (plans.push(p), true), target: { kind: "existing", cloneUrl: rep.url, htmlUrl: "u", branch: "main" } });
  assert.equal(r.status, "pushed");
  assert.deepEqual(rep.files().sort(), ["keep.txt", "new.txt"]);
  assert.deepEqual(plans[0].changes.deleted.sort(), [".github/w.yml", "LICENSE", "README.md"]);
  assert.equal(plans[0].baseSha, seedSha);
  assert.equal(sh(["rev-parse", "refs/heads/main~1"], rep.bare), seedSha);
  assert.equal(sh(["log", "-1", "--format=%s", "refs/heads/main"], rep.bare), "custom msg");

  const ov = await makeRemote(seed);
  const r2 = await runUpload({ ...base, manifest, mode: "overlay", target: { kind: "existing", cloneUrl: ov.url, htmlUrl: "u", branch: "main" } });
  assert.equal(r2.plan.counts.deleted, 0);
  assert.deepEqual(ov.files().sort(), [".github/w.yml", "LICENSE", "README.md", "keep.txt", "new.txt"]);
  assert.equal(sh(["log", "-1", "--format=%s", "refs/heads/main"], ov.bare), "Update project deployment");
});

test("no-op: tidak ada commit/push; remote kosong diinisialisasi; branch non-default; branch hilang ditolak", async () => {
  const src = await writeTree(await tmp("s"), { "a.txt": "a" });
  const manifest = await buildManifest(src);
  const same = await makeRemote({ files: { "a.txt": "a" } });
  const n = await runUpload({ ...base, manifest, target: { kind: "existing", cloneUrl: same.url, htmlUrl: "u", branch: "main" } });
  assert.equal(n.status, "noop"); assert.equal(same.count(), 1);

  const empty = await makeRemote();
  const e = await runUpload({ ...base, manifest, target: { kind: "existing", cloneUrl: empty.url, htmlUrl: "u", branch: "main" } });
  assert.equal(e.status, "pushed"); assert.deepEqual(empty.files(), ["a.txt"]);

  const multi = await makeRemote({ branch: "dev", files: { "old.txt": "o" } });
  await assert.rejects(runUpload({ ...base, manifest, target: { kind: "existing", cloneUrl: multi.url, htmlUrl: "u", branch: "tidak-ada" } }), { code: "BRANCH_NOT_FOUND" });
  const d = await runUpload({ ...base, manifest, target: { kind: "existing", cloneUrl: multi.url, htmlUrl: "u", branch: "dev" } });
  assert.equal(d.status, "pushed"); assert.deepEqual(multi.files("dev"), ["a.txt"]);
});

test("remote bergerak setelah preview: gagal aman (STALE_REMOTE), tidak ada push", async () => {
  const src = await writeTree(await tmp("s"), { "a.txt": "a" });
  const rem = await makeRemote({ files: { "x.txt": "x" } });
  let moved;
  await assert.rejects(runUpload({ ...base, manifest: await buildManifest(src), target: { kind: "existing", cloneUrl: rem.url, htmlUrl: "u", branch: "main" },
    confirm: async () => { const w = await tmp("mv"); sh(["clone", "-q", rem.url, w]); await fs.writeFile(path.join(w, "y.txt"), "y"); sh(["add", "-A"], w); sh(["commit", "-q", "-m", "other"], w); sh(["push", "-q", "origin", "HEAD:main"], w); moved = rem.sha(); return true; } }), { code: "STALE_REMOTE" });
  assert.equal(rem.sha(), moved);
});

test("sumber berubah setelah preview: STALE_PLAN; file tracked terlarang di target (overlay) diblokir", async () => {
  const src = await writeTree(await tmp("s"), { "a.txt": "a" });
  const rem = await makeRemote({ files: { "x.txt": "x" } });
  const before = rem.sha();
  const manifest = await buildManifest(src);
  await assert.rejects(runUpload({ ...base, manifest, target: { kind: "existing", cloneUrl: rem.url, htmlUrl: "u", branch: "main" }, confirm: async () => { await fs.writeFile(manifest.files[0].abs, "ubah"); return true; } }), { code: "STALE_PLAN" });
  assert.equal(rem.sha(), before);

  const bad = await makeRemote({ files: { ".env": "SECRET=1", "x.txt": "x" } });
  await assert.rejects(runUpload({ ...base, manifest, mode: "overlay", target: { kind: "existing", cloneUrl: bad.url, htmlUrl: "u", branch: "main" } }), { code: "POLICY_CONFLICT" });
  assert.deepEqual(bad.files().sort(), [".env", "x.txt"]);
});

test("cleanup & kegagalan push: temp dir bersih, repo tidak dihapus, error menyertakan konteks", async () => {
  const src = await writeTree(await tmp("s"), { "a.txt": "a" });
  const manifest = await buildManifest(src);
  const bare = await makeRemote();
  await fs.rm(bare.bare, { recursive: true });
  const before = (await leftovers()).length;
  const r = await runUpload({ ...base, manifest, target: { kind: "new", branch: "main", createRepo: async () => ({ cloneUrl: bare.url, htmlUrl: "https://github.com/alizz/demo" }) } });
  assert.equal(r.status, "uncertain"); // push gagal + remote tak bisa diverifikasi: dilaporkan, tidak diulang buta
  assert.equal(r.repoUrl, "https://github.com/alizz/demo");
  assert.equal((await leftovers()).length, before);
  await assert.rejects(runUpload({ ...base, manifest, target: { kind: "new", branch: "main", createRepo: async () => { throw new Error("create gagal"); } } }), /create gagal/);
  assert.equal((await leftovers()).length, before);
});

test("lock: operasi bersamaan pada repo/branch sama ditolak", async () => {
  const { acquireLock } = await import("../src/operations/lock.js");
  const dir = await tmp("lock");
  const rel = await acquireLock("alizz/demo@main", dir);
  await assert.rejects(acquireLock("alizz/demo@main", dir), { code: "LOCKED" });
  await rel();
  await (await acquireLock("alizz/demo@main", dir))();
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { run } from "../src/cli/main.js";
import { tmp, writeTree, makeRemote, hashDir } from "./helpers.js";

const TOKEN = "ghp_" + "Z9y8X7w6V5".repeat(4);
const ENVOK = { GITHUB_USERNAME: "alizz", GITHUB_EMAIL: "a@x.io", GITHUB_TOKEN: TOKEN };
const sink = () => { let s = ""; return { write: (x) => (s += x), get text() { return s; } }; };

async function cli(args, over = {}) {
  const stdout = sink(), stderr = sink();
  const calls = [];
  const fetchImpl = over.fetchImpl ?? (async (u, o) => { calls.push(`${o?.method ?? "GET"} ${u}`); throw new Error("jaringan tidak boleh dipakai"); });
  const code = await run(args, { env: over.env ?? {}, stdout, stderr, fetchImpl, isTTY: false, configDir: over.configDir ?? await tmp("cfg"), lockDir: await tmp("lk"), allowLocalRemote: true, progress: () => {}, ...over.deps });
  return { code, out: stdout.text, err: stderr.text, calls };
}
const api = (remoteUrl, extra = {}) => async (u, o = {}) => {
  const url = String(u), m = o.method ?? "GET";
  const j = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
  if (url.endsWith("/user") && m === "GET") return j({ login: "alizz" });
  if (url.endsWith("/repos/alizz/demo")) return j({ full_name: "alizz/demo", clone_url: remoteUrl, html_url: "https://github.com/alizz/demo", default_branch: "main", archived: false, permissions: { push: true }, ...extra });
  if (url.endsWith("/user/repos") && m === "POST") { api.created = JSON.parse(o.body); return j({ clone_url: remoteUrl, html_url: "https://github.com/alizz/demo" }, 201); }
  return j({ message: "Not Found" }, 404);
};

test("help/version/doctor tanpa login & tanpa jaringan; tanpa argumen non-TTY gagal cepat", async () => {
  for (const a of [["--help"], ["--version"]]) { const r = await cli(a); assert.equal(r.code, 0); assert.equal(r.calls.length, 0); assert.match(r.out, /\S/); }
  const d = await cli(["doctor", "--json"]);
  assert.equal(d.code, 0); const j = JSON.parse(d.out); assert.ok(j.checks.some((c) => c.name === "git" && c.ok)); assert.equal(d.calls.length, 0);
  assert.equal((await cli([])).code, 2);
  assert.equal((await cli(["upload", "--bogus"])).code, 2);
});

test("upload: validasi usage (visibility, mode, --yes tidak cukup untuk replace)", async () => {
  const src = await writeTree(await tmp("s"), { "a.txt": "a" });
  assert.equal((await cli(["upload", "--source", src, "--new", "demo", "--yes"], { env: ENVOK })).code, 2);
  assert.equal((await cli(["upload", "--source", src, "--repo", "alizz/demo", "--yes"], { env: ENVOK, fetchImpl: api("file:///x") })).code, 2);
  const rem = await makeRemote({ files: { "old.txt": "o" } });
  const r = await cli(["upload", "--source", src, "--repo", "alizz/demo", "--mode", "replace", "--yes"], { env: ENVOK, fetchImpl: api(rem.url) });
  assert.equal(r.code, 2); assert.match(r.err, /--confirm-replace alizz\/demo@main/);
  assert.deepEqual(rem.files(), ["old.txt"]);
});

test("new repo dry-run offline: JSON murni (tanpa ANSI/banner), tidak memanggil API, sumber utuh", async () => {
  const src = await writeTree(await tmp("s"), { "index.html": "x", ".env": "S=1", "node_modules/a/b.js": "1" });
  const before = await hashDir(src);
  const r = await cli(["upload", "--source", src, "--new", "demo", "--visibility", "private", "--dry-run", "--json"]);
  assert.equal(r.code, 0); assert.equal(r.calls.length, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.status, "dry-run"); assert.deepEqual(j.blocked, [".env"]); assert.equal(j.counts.added, 1);
  assert.ok(!/\u001b\[/.test(r.out));
  assert.equal(await hashDir(src), before);
});

test("repo baru: visibility private dikirim ke API; create hanya setelah --yes", async () => {
  const src = await writeTree(await tmp("s"), { "a.txt": "a" });
  const rem = await makeRemote();
  delete api.created;
  const r = await cli(["upload", "--source", src, "--new", "demo", "--visibility", "private", "--yes", "--json"], { env: ENVOK, fetchImpl: api(rem.url) });
  assert.equal(r.code, 0, r.err + r.out); assert.equal(api.created.private, true);
  assert.equal(JSON.parse(r.out).status, "pushed"); assert.deepEqual(rem.files(), ["a.txt"]);
  assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN));
});

test("update existing: dry-run tidak push; replace butuh confirm persis; overlay; archived; no-op exit 0", async () => {
  const src = await writeTree(await tmp("s"), { "a.txt": "baru" });
  const rem = await makeRemote({ files: { "old.txt": "o", "LICENSE": "l" } });
  const before = rem.sha();
  const base = ["upload", "--source", src, "--repo", "alizz/demo", "--json"];
  const dry = await cli([...base, "--mode", "replace", "--dry-run"], { env: ENVOK, fetchImpl: api(rem.url) });
  assert.equal(dry.code, 0); assert.deepEqual(JSON.parse(dry.out).counts, { added: 1, modified: 0, deleted: 2 }); assert.equal(rem.sha(), before);
  const wrong = await cli([...base, "--mode", "replace", "--confirm-replace", "alizz/demo@dev"], { env: ENVOK, fetchImpl: api(rem.url) });
  assert.equal(wrong.code, 2); assert.equal(rem.sha(), before);
  const ok = await cli([...base, "--mode", "replace", "--confirm-replace", "alizz/demo@main"], { env: ENVOK, fetchImpl: api(rem.url) });
  assert.equal(ok.code, 0, ok.err); assert.deepEqual(rem.files(), ["a.txt"]); assert.equal(rem.count(), 2);
  const noop = await cli([...base, "--mode", "overlay", "--yes"], { env: ENVOK, fetchImpl: api(rem.url) });
  assert.equal(noop.code, 0); assert.equal(JSON.parse(noop.out).status, "noop"); assert.equal(rem.count(), 2);
  const arch = await cli([...base, "--mode", "overlay", "--yes"], { env: ENVOK, fetchImpl: api(rem.url, { archived: true }) });
  assert.equal(arch.code, 3);
});

test("error API: rate limit exit 4; token invalid exit 3; env parsial exit 2; token tidak bocor di output error", async () => {
  const src = await writeTree(await tmp("s"), { "a.txt": "a" });
  const args = ["upload", "--source", src, "--new", "demo", "--visibility", "public", "--yes", "--json"];
  const rl = async () => new Response(JSON.stringify({ message: `API rate limit exceeded for ${TOKEN}` }), { status: 403, headers: { "x-ratelimit-remaining": "0" } });
  const r1 = await cli(args, { env: ENVOK, fetchImpl: rl }); assert.equal(r1.code, 4); assert.ok(!r1.out.includes(TOKEN));
  const r2 = await cli(args, { env: ENVOK, fetchImpl: async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }) }); assert.equal(r2.code, 3);
  const r3 = await cli(args, { env: { GITHUB_USERNAME: "alizz" } }); assert.equal(r3.code, 2); assert.match(JSON.parse(r3.out).message, /GITHUB_EMAIL/);
});

test("auth: env tidak otomatis tersimpan; --remember menyimpan; status menyamarkan; logout jalan pada config rusak/offline", async () => {
  const cfg = await tmp("cfg");
  const l1 = await cli(["auth", "login", "--json"], { env: ENVOK, configDir: cfg, fetchImpl: api("x") });
  assert.equal(l1.code, 0); assert.equal(JSON.parse(l1.out).saved, false); assert.deepEqual(await fs.readdir(cfg), []);
  await cli(["auth", "login", "--remember"], { env: ENVOK, configDir: cfg, fetchImpl: api("x") });
  const st = await cli(["auth", "status", "--json"], { configDir: cfg });
  assert.ok(!st.out.includes(TOKEN)); assert.equal(JSON.parse(st.out).aktif, "config");
  await fs.writeFile(path.join(cfg, "config.json"), "{rusak");
  assert.equal((await cli(["upload", "--source", ".", "--new", "d", "--visibility", "public", "--yes"], { configDir: cfg })).code, 3);
  const lo = await cli(["auth", "logout"], { configDir: cfg });
  assert.equal(lo.code, 0); assert.deepEqual(await fs.readdir(cfg), []);
});

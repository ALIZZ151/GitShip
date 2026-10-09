import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { redact } from "../src/shared/redact.js";
import { runGit, authEnv, assertRemoteAllowed } from "../src/git/client.js";
import { accountFromEnv, readConfig, writeConfig, clearConfig } from "../src/config/store.js";
import { createGitHubClient } from "../src/github/client.js";
import { tmp } from "./helpers.js";

const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const B64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

test("redact: token, Bearer, Basic base64, URL berkredensial", () => {
  const s = `x ${TOKEN} Bearer abcdefgh12345 AUTHORIZATION: basic ${B64} https://user:pw@github.com/a/b`;
  const out = redact(s, [TOKEN]);
  for (const bad of [TOKEN, B64, "abcdefgh12345", "user:pw"]) assert.ok(!out.includes(bad), bad);
});

test("runGit: error tidak membocorkan token/base64 dan argv aman", async () => {
  await assert.rejects(runGit(["bogus-subcmd", TOKEN], { token: TOKEN }), (e) => {
    const all = `${e.message}${e.detail}`;
    return !all.includes(TOKEN) && !all.includes(B64);
  });
  const env = authEnv(TOKEN);
  assert.ok(env.GIT_CONFIG_VALUE_0.includes(B64)); // hanya di env child, bukan argv
});

test("remote hanya github.com HTTPS (file:// hanya mode tes)", () => {
  assertRemoteAllowed("https://github.com/a/b.git");
  assert.throws(() => assertRemoteAllowed("https://evil.com/a/b"));
  assert.throws(() => assertRemoteAllowed("file:///x"));
  assertRemoteAllowed("file:///x", { allowLocal: true });
});

test("config: env lengkap/parsial, v1 legacy, rusak tidak mengunci logout, atomic 0600", async () => {
  assert.equal(accountFromEnv({}).status, "none");
  assert.deepEqual(accountFromEnv({ GITHUB_USERNAME: "u" }).missing, ["GITHUB_EMAIL", "GITHUB_TOKEN"]);
  assert.equal(accountFromEnv({ GITHUB_USERNAME: "u", GITHUB_EMAIL: "e@x.io", GITHUB_TOKEN: "t" }).status, "ok");
  const dir = await tmp("cfg");
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ username: "u", email: "e@x.io", token: "tok", savedAt: "x" }));
  const r = await readConfig(dir);
  assert.equal(r.status, "ok"); assert.equal(r.legacy, true);
  await writeConfig(r.account, dir);
  const st = await fs.stat(path.join(dir, "config.json"));
  if (process.platform !== "win32") assert.equal(st.mode & 0o777, 0o600);
  assert.equal((await readConfig(dir)).legacy, false);
  assert.deepEqual((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")), []);
  await fs.writeFile(path.join(dir, "config.json"), "{rusak");
  assert.equal((await readConfig(dir)).status, "invalid");
  await clearConfig(dir);
  assert.equal((await readConfig(dir)).status, "none");
});

const res = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

test("github: pagination melewati halaman ke-5 dan item ke-30", async () => {
  let calls = 0;
  const f = async (url) => {
    calls++;
    const page = Number(new URL(url).searchParams.get("page") || 1);
    const items = Array.from({ length: 2 }, (_, i) => ({ full_name: `o/r${page}-${i}` }));
    return res(200, items, page < 7 ? { link: `<https://api.github.com/user/repos?per_page=100&page=${page + 1}>; rel="next"` } : {});
  };
  const repos = await createGitHubClient({ token: "t", fetchImpl: f }).listRepositories();
  assert.equal(repos.length, 14); assert.equal(calls, 7);
});

test("github: 403 rate limit != forbidden != 401; 422 detail; 451; POST tidak diulang", async () => {
  const mk = (r) => createGitHubClient({ token: "t", fetchImpl: async () => r(), sleep: async () => {} });
  await assert.rejects(mk(() => res(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" })).request("POST", "/x"), { code: "RATE_LIMITED" });
  await assert.rejects(mk(() => res(403, { message: "Resource not accessible" })).request("GET", "/x"), { code: "FORBIDDEN" });
  await assert.rejects(mk(() => res(401, { message: "Bad credentials" })).request("GET", "/x"), { code: "INVALID_TOKEN" });
  await assert.rejects(mk(() => res(451, { message: "dmca" })).request("GET", "/x"), { code: "UNAVAILABLE_LEGAL" });
  await assert.rejects(mk(() => res(422, { message: "Validation Failed", errors: [{ message: "name already exists on this account" }] })).request("POST", "/x"), (e) => e.code === "VALIDATION_FAILED" && /already exists/.test(e.detail));
  let n = 0;
  await assert.rejects(createGitHubClient({ token: "t", fetchImpl: async () => (n++, res(500, {})), sleep: async () => {} }).request("POST", "/x"), { code: "SERVER_ERROR" });
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(createGitHubClient({ token: "t", fetchImpl: async () => (n++, res(500, {})), sleep: async () => {} }).request("GET", "/x"), { code: "SERVER_ERROR" });
  assert.equal(n, 3);
});

test("github: timeout, JSON rusak, visibility wajib, private dikirim sesuai pilihan", async () => {
  const slow = (url, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
  await assert.rejects(createGitHubClient({ token: "t", fetchImpl: slow, timeoutMs: 20 }).request("GET", "/x"), { code: "API_TIMEOUT" });
  await assert.rejects(createGitHubClient({ token: "t", fetchImpl: async () => new Response("<html>", { status: 200 }) }).request("GET", "/x"), { code: "MALFORMED_RESPONSE" });
  const bodies = [];
  const c = createGitHubClient({ token: "t", fetchImpl: async (u, o) => (bodies.push(JSON.parse(o.body)), res(201, { clone_url: "https://github.com/o/r.git", html_url: "https://github.com/o/r" })) });
  await assert.rejects(c.createRepository("r"), { code: "VISIBILITY_REQUIRED" });
  await c.createRepository("r", "private"); await c.createRepository("r", "public");
  assert.deepEqual(bodies.map((b) => b.private), [true, false]);
});

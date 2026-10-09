import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { selfUpdate } from "../src/self-update.js";
import { tmp, sh, makeRemote, ENV } from "./helpers.js";

async function fixture() {
  const remote = await makeRemote({ files: { "hello.txt": "versi-1", "package.json": "{}" } });
  const local = path.join(await tmp("updater"), "GitShip");
  sh(["clone", "-q", remote.url, local]);
  const writer = path.join(await tmp("writer"), "project");
  sh(["clone", "-q", remote.url, writer]);
  return { remote, local, writer };
}

function pushChange(writer, content) {
  // Git's test helper invokes file:// remotes, no real GitHub credentials.
  return fs.writeFile(path.join(writer, "hello.txt"), content).then(() => {
    sh(["add", "."], writer);
    sh(["commit", "-q", "-m", "change-" + content], writer);
    sh(["push", "-q", "origin", "main"], writer);
  });
}

test("self-update: check-only tidak mengubah checkout; fast-forward menginstal dependency; repeat no-op", async () => {
  const { local, writer } = await fixture();
  await pushChange(writer, "versi-2");
  let installs = 0;
  const opts = { projectRoot: local, allowLocalRemote: true, env: ENV, install: async () => { installs++; } };
  assert.equal((await selfUpdate({ ...opts, checkOnly: true })).status, "available");
  assert.equal((await fs.readFile(path.join(local, "hello.txt"), "utf8")), "versi-1");
  assert.equal(installs, 0);
  assert.equal((await selfUpdate(opts)).status, "updated");
  assert.equal(installs, 1);
  assert.equal((await fs.readFile(path.join(local, "hello.txt"), "utf8")), "versi-2");
  assert.equal((await selfUpdate(opts)).status, "current");
  assert.equal(installs, 1);
});

test("self-update: perubahan lokal tidak boleh ditimpa", async () => {
  const { local, writer } = await fixture();
  await pushChange(writer, "versi-2");
  await fs.writeFile(path.join(local, "hello.txt"), "ubah-lokal");
  const x = await selfUpdate({ projectRoot: local, allowLocalRemote: true, env: ENV, install: async () => { throw new Error("must not install"); } });
  assert.equal(x.status, "skipped");
  assert.equal((await fs.readFile(path.join(local, "hello.txt"), "utf8")), "ubah-lokal");
});

test("self-update: hanya remote resmi dan branch main; auto-update bisa dimatikan", async () => {
  const { local } = await fixture();
  assert.equal((await selfUpdate({ projectRoot: local, env: ENV })).status, "skipped");
  assert.equal((await selfUpdate({ projectRoot: local, env: { ...ENV, GITSHIP_AUTO_UPDATE: "0" }, respectDisable: true })).status, "disabled");
  sh(["checkout", "-q", "-b", "dev"], local);
  assert.equal((await selfUpdate({ projectRoot: local, env: ENV, allowLocalRemote: true })).status, "skipped");
  assert.equal((await selfUpdate({ projectRoot: await tmp("notrepo"), env: ENV })).status, "unsupported");
});

test("self-update: tidak mengabaikan error npm setelah merge", async () => {
  const { local, writer } = await fixture();
  await pushChange(writer, "versi-2");
  const x = await selfUpdate({ projectRoot: local, allowLocalRemote: true, env: ENV, install: async () => { throw new Error("npm gagal"); } });
  assert.equal(x.status, "install-failed");
  assert.equal((await fs.readFile(path.join(local, "hello.txt"), "utf8")), "versi-2");
});

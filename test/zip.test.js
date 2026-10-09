import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extractZip, prepareZipSource, DEFAULT_ZIP_LIMITS } from "../src/project/archive.js";
import { tmp } from "./helpers.js";

const PY = `
import sys, json, zipfile
spec = json.load(sys.stdin)
with zipfile.ZipFile(spec["out"], "w", zipfile.ZIP_DEFLATED) as z:
    for e in spec["entries"]:
        zi = zipfile.ZipInfo(e["name"])
        zi.compress_type = zipfile.ZIP_DEFLATED
        if e.get("symlink"):
            zi.create_system = 3; zi.external_attr = 0o120777 << 16
        data = ("\\0" * e["zeros"]).encode("latin1") if "zeros" in e else e.get("text", "x").encode()
        z.writestr(zi, data)
`;
async function mkzip(entries) {
  const out = path.join(await tmp("zip"), "t.zip");
  execFileSync("python3", ["-W", "ignore", "-c", PY], { input: JSON.stringify({ out, entries }) });
  return out;
}
const tree = async (d) => (await fs.readdir(d, { recursive: true })).sort();
const code = (c) => ({ code: c });
const fresh = async () => path.join(await tmp("out"), "x");

test("zip valid: satu root dibuka; spasi/Unicode/dotfile aman", async () => {
  const z = await mkzip([{ name: "proj/", text: "" }, { name: "proj/.gitignore", text: "a" }, { name: "proj/folder spasi/ü.txt", text: "u" }]);
  const s = await prepareZipSource(z);
  try { assert.equal(path.basename(s.sourcePath), "proj"); assert.ok((await tree(s.sourcePath)).includes(".gitignore")); assert.ok((await tree(s.sourcePath)).includes("folder spasi/ü.txt")); }
  finally { await s.cleanup(); }
});

test("zip: .gitignore sibling di root tidak hilang; metadata Mac diabaikan; multi-root dipertahankan", async () => {
  const s1 = await prepareZipSource(await mkzip([{ name: ".gitignore", text: "a" }, { name: "proj/a.txt" }]));
  try { assert.equal(s1.sourcePath.endsWith("/x"), true); assert.ok((await tree(s1.sourcePath)).includes(".gitignore")); } finally { await s1.cleanup(); }
  const s2 = await prepareZipSource(await mkzip([{ name: "__MACOSX/proj/._a" }, { name: ".DS_Store" }, { name: "proj/a.txt" }]));
  try { assert.equal(path.basename(s2.sourcePath), "proj"); } finally { await s2.cleanup(); }
  const s3 = await prepareZipSource(await mkzip([{ name: "a/x.txt" }, { name: "b/y.txt" }]));
  try { assert.deepEqual(s3.candidates.sort(), ["a/", "b/"]); } finally { await s3.cleanup(); }
});

test("zip: kosong, rusak, bukan ZIP", async () => {
  await assert.rejects(extractZip(await mkzip([]), await fresh()), code("ZIP_EMPTY"));
  const z = await mkzip([{ name: "a.txt", text: "hello" }]);
  const buf = await fs.readFile(z);
  await fs.writeFile(z, buf.subarray(0, buf.length - 30));
  await assert.rejects(extractZip(z, await fresh()), code("ZIP_CORRUPT"));
  const junk = path.join(await tmp("j"), "j.zip"); await fs.writeFile(junk, "bukan zip sama sekali");
  await assert.rejects(extractZip(junk, await fresh()), code("ZIP_CORRUPT"));
});

test("zip: traversal/absolut/backslash/drive/null ditolak SEBELUM menulis apa pun", async () => {
  for (const bad of ["../evil.txt", "a/../../evil.txt", "a\\..\\..\\evil.txt", "/abs.txt", "C:/x.txt"]) {
    const out = await fresh();
    await assert.rejects(extractZip(await mkzip([{ name: "baik.txt" }, { name: bad }]), out), code("ZIP_UNSAFE_PATH"), bad);
    await assert.rejects(fs.stat(out), { code: "ENOENT" }, `tidak ada penulisan parsial: ${bad}`);
    await assert.rejects(fs.stat(path.join(path.dirname(out), "evil.txt")), { code: "ENOENT" });
  }
});

test("zip: null byte pada nama (dipatch di byte mentah) ditolak", async () => {
  const z = await mkzip([{ name: "okXtxt" }]);
  const b = await fs.readFile(z);
  let i = 0; while ((i = b.indexOf("okXtxt", i)) >= 0) { b[i + 2] = 0; i += 6; }
  await fs.writeFile(z, b);
  await assert.rejects(extractZip(z, await fresh()), code("ZIP_UNSAFE_PATH"));
});

test("zip: duplikat, bentrok huruf besar/kecil, file vs direktori, symlink metadata", async () => {
  await assert.rejects(extractZip(await mkzip([{ name: "a.txt" }, { name: "a.txt" }]), await fresh()), code("ZIP_DUPLICATE"));
  await assert.rejects(extractZip(await mkzip([{ name: "a.txt" }, { name: "A.txt" }]), await fresh()), code("ZIP_DUPLICATE"));
  await assert.rejects(extractZip(await mkzip([{ name: "a" }, { name: "a/b.txt" }]), await fresh()), code("ZIP_DUPLICATE"));
  await assert.rejects(extractZip(await mkzip([{ name: "link", text: "/etc/passwd", symlink: true }]), await fresh()), code("ZIP_SYMLINK"));
});

test("zip: batas tepat di/di atas (entry, jumlah entry, total, kedalaman)", async () => {
  const L = { ...DEFAULT_ZIP_LIMITS, maxRatio: 1e9 };
  const exact = await mkzip([{ name: "f.bin", zeros: 1000 }]);
  await extractZip(exact, await fresh(), { ...L, maxEntryBytes: 1000 });
  await assert.rejects(extractZip(exact, await fresh(), { ...L, maxEntryBytes: 999 }), code("ZIP_LIMIT"));
  const three = await mkzip([{ name: "a" }, { name: "b" }, { name: "c" }]);
  await extractZip(three, await fresh(), { maxEntries: 3 });
  await assert.rejects(extractZip(three, await fresh(), { maxEntries: 2 }), code("ZIP_LIMIT"));
  const two = await mkzip([{ name: "a", zeros: 600 }, { name: "b", zeros: 600 }]);
  await extractZip(two, await fresh(), { ...L, maxTotalBytes: 1200 });
  await assert.rejects(extractZip(two, await fresh(), { ...L, maxTotalBytes: 1199 }), code("ZIP_LIMIT"));
  const deep = await mkzip([{ name: "a/b/c/d.txt" }]);
  await extractZip(deep, await fresh(), { maxDepth: 4 });
  await assert.rejects(extractZip(deep, await fresh(), { maxDepth: 3 }), code("ZIP_TOO_DEEP"));
  await assert.rejects(extractZip(exact, await fresh(), { maxArchiveBytes: 10 }), code("ZIP_LIMIT"));
});

test("zip: rasio kompresi tinggi ditolak; header berbohong tetap dihentikan oleh batas dekompresi AKTUAL", async () => {
  const bomb = await mkzip([{ name: "z.bin", zeros: 5 * 1024 * 1024 }]);
  await assert.rejects(extractZip(bomb, await fresh()), code("ZIP_RATIO"));
  // palsukan ukuran asli kecil di local+central header
  const buf = await fs.readFile(bomb);
  const lie = Buffer.from(buf);
  lie.writeUInt32LE(500, 22); // local header usize
  const cd = lie.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lie.writeUInt32LE(500, cd + 24);
  const lied = path.join(await tmp("lie"), "l.zip"); await fs.writeFile(lied, lie);
  const out = await fresh();
  await assert.rejects(extractZip(lied, out, { maxRatio: 1e9, maxEntryBytes: 1000, maxTotalBytes: 1000 }), code("ZIP_LIMIT"));
  assert.deepEqual(await fs.readdir(out).catch(() => []), []);
});

test("zip: CRC dimanipulasi terdeteksi; cleanup temp saat gagal", async () => {
  const z = await mkzip([{ name: "a.txt", text: "isi penting" }]);
  const b = await fs.readFile(z);
  const cd = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  b.writeUInt32LE(0xdeadbeef, cd + 16);
  await fs.writeFile(z, b);
  const before = (await fs.readdir((await import("node:os")).tmpdir())).filter((n) => n.startsWith("gitship-zip-")).length;
  await assert.rejects(prepareZipSource(z), code("ZIP_CORRUPT"));
  const after = (await fs.readdir((await import("node:os")).tmpdir())).filter((n) => n.startsWith("gitship-zip-")).length;
  assert.equal(after, before);
});

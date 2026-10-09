import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { AppError, EXIT } from "../shared/errors.js";

const STALE_MS = 60 * 60 * 1000;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Lock lokal per akun/repo/branch (mkdir atomik). Lock stale (proses mati / >1 jam) diambil alih. */
export async function acquireLock(key, baseDir = path.join(os.tmpdir(), "gitship-locks")) {
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  const dir = path.join(baseDir, crypto.createHash("sha256").update(key).digest("hex").slice(0, 24));
  for (let i = 0; i < 2; i++) {
    try {
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "pid"), String(process.pid));
      return async () => { await fs.rm(dir, { recursive: true, force: true }); };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(await fs.readFile(path.join(dir, "pid"), "utf8").catch(() => "0"));
      const st = await fs.stat(dir).catch(() => null);
      const stale = !st || Date.now() - st.mtimeMs > STALE_MS || (pid > 0 && !alive(pid));
      if (!stale) throw new AppError("LOCKED", "Ada operasi GitShip lain pada repo/branch yang sama.", `Jika yakin tidak ada, hapus: ${dir}`, EXIT.GIT);
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  throw new AppError("LOCKED", "Gagal mengambil lock.", dir, EXIT.GIT);
}

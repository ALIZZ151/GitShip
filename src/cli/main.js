import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import { AppError, EXIT } from "../shared/errors.js";
import { redact } from "../shared/redact.js";
import { USAGE } from "./ui.js";
import { authCommand, doctorCommand, uploadCommand } from "./commands.js";

const OPTIONS = {
  help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }, json: { type: "boolean" },
  source: { type: "string" }, new: { type: "string" }, repo: { type: "string" }, branch: { type: "string" },
  mode: { type: "string" }, visibility: { type: "string" }, message: { type: "string", short: "m" },
  "dry-run": { type: "boolean" }, yes: { type: "boolean" }, "confirm-replace": { type: "string" },
  "create-branch": { type: "boolean" }, remember: { type: "boolean" }, network: { type: "boolean" }
};

export async function readVersion() {
  return JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8")).version;
}

/** Titik masuk testable: tidak login/jaringan untuk --help/--version. Kembalikan exit code. */
export async function run(argv, deps = {}) {
  const d = { env: process.env, stdout: process.stdout, stderr: process.stderr, fetchImpl: globalThis.fetch, isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY, ...deps };
  d.progress ??= (t) => d.stderr.write(`${t}\n`);
  let v, positionals, json = argv.includes("--json");
  const secret = () => [d.env.GITHUB_TOKEN];
  const out = (data, text) => d.stdout.write(json ? `${JSON.stringify(data)}\n` : `${text}\n`);
  try {
    try { ({ values: v, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })); }
    catch (e) { throw new AppError("USAGE", e.message, "", EXIT.USAGE); }
    json = !!v.json;
    if (v.help) { d.stdout.write(USAGE); return EXIT.OK; }
    if (v.version) { d.stdout.write(`${await readVersion()}\n`); return EXIT.OK; }
    const [cmd, sub] = positionals;
    if (!cmd) {
      if (!d.isTTY) throw new AppError("USAGE", "Tanpa argumen butuh terminal interaktif. Lihat --help.", "", EXIT.USAGE);
      const { runMenu } = await import("./menu.js");
      return await runMenu(d);
    }
    if (cmd === "doctor") return await doctorCommand(v, d, out);
    if (cmd === "auth") { await authCommand(sub, v, d, out); return EXIT.OK; }
    if (cmd === "upload") return await uploadCommand(v, d, out);
    throw new AppError("USAGE", `Perintah tidak dikenal: ${cmd}`, "", EXIT.USAGE);
  } catch (e) {
    if (e?.name === "ExitPromptError") { d.stderr.write("Dibatalkan.\n"); return EXIT.CANCELLED; }
    const known = e instanceof AppError;
    const safe = { status: "error", code: known ? e.code : "UNEXPECTED", message: redact(e.message, secret()), detail: redact(e.detail ?? "", secret()), ...(e.context ? { context: e.context } : {}) };
    if (json) d.stdout.write(`${JSON.stringify(safe)}\n`);
    else d.stderr.write(`ERROR [${safe.code}] ${safe.message}${safe.detail ? `\n${safe.detail}` : ""}\n`);
    return known ? e.exitCode : EXIT.FAILED;
  }
}

import { AppError, EXIT } from "../shared/errors.js";
import { redact } from "../shared/redact.js";

export const API_VERSIONS = { current: "2022-11-28", next: "2026-03-10" };
const MAX_RETRY = 2;

/** Satu adapter HTTP: timeout, versi API, pagination, mapping error, redaksi. fetchImpl bisa di-mock. */
export function createGitHubClient({ token, fetchImpl = globalThis.fetch, baseUrl = "https://api.github.com", apiVersion = API_VERSIONS.current, timeoutMs = 30000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function once(method, url, body, signal) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      return await fetchImpl(url, {
        method,
        signal: ctl.signal,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": apiVersion, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      if (signal?.aborted) throw new AppError("CANCELLED", "Dibatalkan.", "", EXIT.CANCELLED);
      if (ctl.signal.aborted) throw new AppError("API_TIMEOUT", "GitHub API melebihi batas waktu.", `${method} ${url}`, EXIT.NETWORK);
      throw new AppError("NETWORK_ERROR", "Koneksi ke GitHub API bermasalah.", redact(e.message, [token]), EXIT.NETWORK);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function parse(res) {
    const text = await res.text().catch(() => "");
    try { return text ? JSON.parse(text) : null; } catch { return { __malformed: true }; }
  }

  function rateLimited(res, data) {
    if (res.status === 429) return true;
    if (res.status !== 403) return false;
    if (res.headers.get("retry-after")) return true;
    if (res.headers.get("x-ratelimit-remaining") === "0") return true;
    return /rate limit/i.test(data?.message || "");
  }

  function mapError(res, data) {
    const msg = redact(data?.message || res.statusText || "GitHub API error", [token]);
    const s = res.status;
    if (s === 401) return new AppError("INVALID_TOKEN", "Token GitHub tidak valid atau kedaluwarsa.", msg, EXIT.AUTH);
    if (rateLimited(res, data)) return new AppError("RATE_LIMITED", "Terkena rate limit GitHub. Tunggu lalu coba lagi (token Anda tidak salah).", msg, EXIT.NETWORK);
    if (s === 403) return new AppError("FORBIDDEN", "Token tidak punya izin untuk operasi ini.", msg, EXIT.AUTH);
    if (s === 404) return new AppError("NOT_FOUND", "Tidak ditemukan, atau token tidak punya akses ke resource ini.", msg, EXIT.AUTH);
    if (s === 422) {
      const det = (data?.errors || []).map((e) => (typeof e === "string" ? e : e.message || `${e.field}: ${e.code}`)).join("; ");
      return new AppError("VALIDATION_FAILED", "GitHub menolak input (422).", [msg, det].filter(Boolean).join(" — "), EXIT.USAGE);
    }
    if (s === 451) return new AppError("UNAVAILABLE_LEGAL", "Resource tidak tersedia karena alasan hukum (451).", msg, EXIT.AUTH);
    if (s >= 500) return new AppError("SERVER_ERROR", `GitHub error server (${s}).`, msg, EXIT.NETWORK);
    return new AppError("API_ERROR", `GitHub API error ${s}.`, msg, EXIT.NETWORK);
  }

  /** Retry hanya untuk GET aman; POST tidak pernah diulang. */
  async function request(method, path, { body, signal } = {}) {
    const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await once(method, url, body, signal);
      const data = await parse(res);
      if (res.ok) {
        if (data?.__malformed) throw new AppError("MALFORMED_RESPONSE", "Respons GitHub tidak valid (bukan JSON).", `${method} ${path}`, EXIT.NETWORK);
        return { data, headers: res.headers };
      }
      const retriable = method === "GET" && attempt < MAX_RETRY && (res.status >= 500 || rateLimited(res, data));
      if (retriable) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 1000 * (attempt + 1));
        continue;
      }
      throw mapError(res, data);
    }
  }

  const nextLink = (h) => /<([^>]+)>;\s*rel="next"/.exec(h.get("link") || "")?.[1] || null;

  return {
    request,
    async getUser(signal) {
      const { data } = await request("GET", "/user", { signal });
      if (typeof data?.login !== "string") throw new AppError("MALFORMED_RESPONSE", "Respons /user tidak memuat login.", "", EXIT.NETWORK);
      return data;
    },
    /** Ikuti pagination server sampai habis. maxItems opsional dan eksplisit dari pemanggil (tanpa cutoff tersembunyi). */
    async listRepositories({ maxItems = Infinity, onPage, signal } = {}) {
      const out = [];
      let url = "/user/repos?per_page=100&sort=updated&direction=desc&affiliation=owner,collaborator,organization_member";
      while (url && out.length < maxItems) {
        const { data, headers } = await request("GET", url, { signal });
        if (!Array.isArray(data)) throw new AppError("MALFORMED_RESPONSE", "Daftar repo bukan array.", "", EXIT.NETWORK);
        out.push(...data);
        onPage?.(out.length);
        url = nextLink(headers);
      }
      return out.slice(0, maxItems);
    },
    async listBranches(owner, repo, signal) {
      const out = [];
      let url = `/repos/${owner}/${repo}/branches?per_page=100`;
      while (url) {
        const { data, headers } = await request("GET", url, { signal });
        out.push(...data.map((b) => b.name));
        url = nextLink(headers);
      }
      return out;
    },
    async getRepository(owner, repo, signal) {
      return (await request("GET", `/repos/${owner}/${repo}`, { signal })).data;
    },
    /** visibility wajib eksplisit: "public" | "private". */
    async createRepository(name, visibility, signal) {
      if (visibility !== "public" && visibility !== "private") throw new AppError("VISIBILITY_REQUIRED", "Visibility harus 'public' atau 'private'.", "", EXIT.USAGE);
      const { data } = await request("POST", "/user/repos", { body: { name, private: visibility === "private", auto_init: false }, signal });
      if (typeof data?.clone_url !== "string" || typeof data?.html_url !== "string") throw new AppError("MALFORMED_RESPONSE", "Respons create repo tidak lengkap.", "", EXIT.NETWORK);
      return data;
    }
  };
}

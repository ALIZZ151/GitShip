const PATTERNS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(basic\s+)[A-Za-z0-9+/=]{8,}/gi,
  /(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi
];

/** Hapus token mentah, Bearer, Basic Base64, dan URL berkredensial dari teks. */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  const all = new Set();
  for (const s of secrets) {
    if (!s || String(s).length < 4) continue;
    all.add(String(s));
    all.add(Buffer.from(`x-access-token:${s}`).toString("base64"));
    all.add(Buffer.from(`${s}`).toString("base64"));
  }
  for (const s of [...all].sort((a, b) => b.length - a.length)) out = out.split(s).join("[REDACTED]");
  out = out.replace(PATTERNS[0], "[REDACTED]").replace(PATTERNS[1], "[REDACTED]");
  out = out.replace(PATTERNS[2], "$1[REDACTED]").replace(PATTERNS[3], "$1[REDACTED]").replace(PATTERNS[4], "$1[REDACTED]@");
  return out;
}

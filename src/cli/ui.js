const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

/** Teks preview tanpa warna (aman untuk non-TTY/NO_COLOR). */
export function formatPlan(plan, { sample = 8 } = {}) {
  const c = plan.counts, L = [];
  L.push(`Target : ${plan.target}`, `Branch : ${plan.branch}`, `Mode   : ${plan.mode}${plan.mode === "replace" ? " (file target yang tidak ada di sumber DIHAPUS)" : " (file target lain dipertahankan)"}`);
  L.push(`Base   : ${plan.baseSha ?? "(repo/branch kosong)"}`, `Pesan  : ${plan.message}`);
  L.push(`Ukuran : ${fmtSize(plan.totalSize)}`, `Perubahan: +${c.added} ubah ${c.modified} hapus ${c.deleted}`);
  for (const [label, arr] of [["Tambah", plan.changes.added], ["Ubah", plan.changes.modified], ["HAPUS", plan.changes.deleted]])
    if (arr.length) L.push(`${label}: ${arr.slice(0, sample).join(", ")}${arr.length > sample ? ` … (+${arr.length - sample})` : ""}`);
  if (plan.excluded.length) L.push(`Dikecualikan (${plan.excluded.length}): ${plan.excluded.slice(0, 5).map((e) => `${e.rel} [${e.reason}]`).join(", ")}${plan.excluded.length > 5 ? " …" : ""}`);
  if (plan.blocked.length) L.push(`DIBLOKIR (${plan.blocked.length}): ${plan.blocked.slice(0, 5).map((e) => `${e.rel} [${e.reason}]`).join(", ")}`);
  for (const l of plan.large) L.push(`${l.fatal ? "TERLALU BESAR" : "Besar"}: ${l.rel} (${fmtSize(l.size)}) — batas GitHub 100 MiB; Git LFS tidak disetel otomatis`);
  return L.join("\n");
}

export const USAGE = `ALIZZ GitShip — upload folder/ZIP/file ke GitHub

Pakai:
  gitship                         menu interaktif
  gitship --help | --version
  gitship doctor [--network] [--json]
  gitship self-update [--check] [--json]   update clone GitShip resmi
  gitship auth status | login | logout
  gitship upload --source <path> (--new <nama> --visibility public|private | --repo owner/repo)
                 [--branch b] [--mode replace|overlay] [--message teks] [--create-branch]
                 [--dry-run] [--yes] [--confirm-replace owner/repo@branch] [--json]

Catatan:
  gitship interaktif akan memperbarui instalasi git clone yang clean secara otomatis.
  Set GITSHIP_AUTO_UPDATE=0 untuk menonaktifkan update.
  repo baru nonaktif-interaktif wajib --visibility dan --yes (kecuali --dry-run).
  update repo wajib --mode; replace wajib --confirm-replace owner/repo@branch (persis).
  --yes TIDAK mengizinkan penghapusan. Tidak ada --force.
Exit code: 0 sukses/no-op, 1 gagal, 2 usage/validasi, 3 auth/izin, 4 jaringan/API, 5 konflik Git/rules, 130 dibatalkan.
`;

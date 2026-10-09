# ALIZZ GitShip

CLI untuk mengunggah project (folder, ZIP, atau satu file) ke repo GitHub, dengan preview sebelum push.
Lisensi MIT · Developer: ALIZZ · executable: `gitship`.

## Instalasi
Butuh Node.js `^22.12.0` dan Git `>= 2.31`.
```
npm install            # dari folder proyek ini
node bin/gitship.js doctor
npm link               # opsional, agar perintah `gitship` tersedia
```
Status uji: lihat `docs/STATUS.md` (Node 24, Windows, macOS, Termux, dan GitHub asli belum diuji).

## Pemakaian
`gitship` tanpa argumen membuka menu interaktif (Indonesia). Perintah lain:
```
gitship --help | --version
gitship doctor [--network] [--json]
gitship auth status | login [--remember] | logout
gitship upload --source <path> --new nama --visibility private --yes
gitship upload --source <path> --repo owner/repo --mode overlay --yes
gitship upload --source <path> --repo owner/repo --mode replace --confirm-replace owner/repo@main
gitship upload ... --dry-run --json
```
- **Sumber**: folder, `.zip`, atau satu file. Folder asal hanya dibaca.
- **replace**: isi target diganti snapshot sumber (file target yang tidak ada di sumber DIHAPUS, termasuk README/LICENSE). Interaktif: ketik `YA UPDATE REPO`.
- **overlay**: hanya tambah/ubah; file target lain dipertahankan.
- **Visibility** repo baru wajib dipilih (public/private). Repo baru hanya untuk akun pribadi (organization belum didukung).
- **No-op**: jika tidak ada perubahan, tidak ada commit/push.
- Tidak ada force push dan tidak ada rewrite history. Jika remote bergerak setelah preview, operasi gagal aman.
- `--dry-run` tidak membuat repo dan tidak push. Untuk repo baru ia sepenuhnya offline; untuk repo lama ia membaca API/clone.
- `--json` mengeluarkan satu objek JSON di stdout; progres manusia ke stderr.
- Exit code: 0 sukses/no-op, 1 gagal, 2 usage/validasi, 3 auth/izin, 4 jaringan/API, 5 konflik Git/rules, 130 dibatalkan.

## Auth dan izin
- Environment: `GITHUB_USERNAME`, `GITHUB_EMAIL`, `GITHUB_TOKEN` (ketiganya). `.env` TIDAK dimuat otomatis. Token environment tidak disimpan. Jika hanya sebagian yang diisi, GitShip berhenti dengan penjelasan (tidak mencampur akun).
- Login interaktif menawarkan simpan. Config di `~/.alizz-gitship/config.json` (mode `0600`, direktori `0700`, tulis atomic). `0600` adalah izin file, **bukan enkripsi**.
- Token tidak pernah ada di argv Git, URL remote, `.git/config`, atau output. Git menerimanya lewat environment child process.
- Izin token (perkiraan, belum diuji ke GitHub asli): fine-grained dengan *Contents: Read and write* pada repo target; membuat repo butuh *Administration: Read and write* (atau classic `repo`). Metadata izin repo tidak menjamin push berhasil (rule branch bisa menolak).

## Kebijakan file
Diblokir selalu: `.git`, direktori config GitShip, `.env` dan variannya (kecuali `.env.example/.sample/.template` tanpa secret), private key/sertifikat, credential store, file berisi pola token. Diabaikan default: `node_modules`, cache, log, `.DS_Store`. Dihormati: `.gitignore` (nested/negation, lewat Git) dan `.gitshipignore` di root. Tetap diunggah: `dist`, lockfile, `.github`, `.gitignore`, dotfile proyek lain. Pemindaian pola bukan jaminan mendeteksi semua rahasia. Symlink ditolak. File > 100 MiB ditolak (Git LFS tidak disetel otomatis).

## ZIP
Parser sendiri berbasis `node:zlib` dengan batas dekompresi aktual. Batas awal (asumsi, bukan batas GitHub): arsip 256 MiB, total 512 MiB, entry 100 MiB, 10.000 entry, kedalaman 64, rasio 1000:1, waktu 120 dtk. Ditolak: path traversal/absolut/drive/backslash, null byte, duplikat, symlink, terenkripsi, ZIP64. Satu folder root dibuka otomatis hanya jika sibling-nya metadata (`__MACOSX`, `.DS_Store`); selain itu root dipertahankan.

## Pemulihan error
Kesalahan upload kembali ke menu. Repo yang sudah dibuat tetapi gagal push TIDAK dihapus otomatis; URL dan tahap gagal dilaporkan. Hasil push yang tidak pasti dilaporkan `uncertain` dan tidak diulang buta; periksa repo lalu jalankan ulang. Lock lokal mencegah dua operasi pada repo/branch yang sama; lock basi diambil alih otomatis.

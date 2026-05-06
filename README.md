# ALIZZ GitShip 🚀

**ALIZZ GitShip** adalah CLI buat upload project ke GitHub dengan cara yang simple: tinggal masukin akun GitHub, pilih mode, masukin folder atau file `.zip`, lalu tools yang urus clone/copy/commit/push.

Developer: **ALIZZ**

Tagline:

```txt
Ship your project to GitHub, clean and fast.
```

> Tools ini cuma punya 2 mode utama: update repo lama atau bikin repo baru. Tidak ada fitur delete repo, hosting otomatis, database, dashboard, atau fitur random lain.

---

## Fitur Utama

### 1. Update Repo Lama

Buat kamu yang sudah punya repo GitHub, tapi mau ganti semua isinya dengan project baru.

Alurnya:

```txt
Masukkan URL repo lama
↓
Masukkan folder project atau file ZIP
↓
Tools kasih warning dulu
↓
Ketik konfirmasi
↓
Repo lama dibersihkan
↓
Project baru diupload
↓
Commit + push
```

### 2. Deploy Repo Baru

Buat kamu yang mau bikin repo GitHub baru dari project lokal.

Alurnya:

```txt
Masukkan nama repo baru
↓
Masukkan folder project atau file ZIP
↓
Tools bikin repo baru di GitHub
↓
Project diupload
↓
Commit + push
↓
Link repo keluar
```

---

## Input Project Bisa Apa Aja?

GitShip sekarang bisa baca:

```txt
Folder project
File .zip project
File biasa
```

Rekomendasi paling aman:

```txt
Folder project yang isinya langsung index.html / package.json / src / api / dll
```

Kalau kamu masukin file `.zip`, tools akan extract otomatis. Kalau ZIP dari GitHub biasanya punya folder dalam seperti `project-main`, tools akan auto pakai folder dalam itu.

Contoh path Termux:

```txt
/sdcard/Download/ALIZZ-STORE-v4.zip
/sdcard/Download/ALIZZ-STORE v4/ALIZZ-STORE--main
```

Kalau path ada spasi, tetap bisa. Contoh:

```txt
/sdcard/Download/ALIZZ STORE V4.zip
```

---

## Requirement

Install dulu:

- Node.js minimal versi 20
- npm
- Git
- Koneksi internet
- GitHub Personal Access Token

Cek versi:

```bash
node -v
npm -v
git --version
```

---

## Install di Termux Android

Update package:

```bash
pkg update && pkg upgrade -y
```

Install bahan:

```bash
pkg install nodejs git unzip -y
```

Kasih akses storage:

```bash
termux-setup-storage
```

Kalau mirror Termux error:

```bash
termux-change-repo
```

Pilih:

```txt
Mirror group
```

Lalu pilih mirror aman seperti:

```txt
packages.termux.dev
```

atau:

```txt
Grimler
```

Setelah itu:

```bash
rm -rf $PREFIX/var/lib/apt/lists/*
pkg update
```

---

## Install ALIZZ GitShip

Kalau ZIP tools ada di folder Download Android:

```bash
cd /sdcard/Download
unzip alizz-gitship.zip -d $HOME
cd ~/alizz-gitship
npm install
npm run check
npm start
```

Kalau pakai command global:

```bash
npm install
npm link
gitship
```

---

## Cara Ambil GitHub Token

Buka browser:

```txt
https://github.com/settings/tokens/new
```

Isi:

```txt
Note       : alizz-gitship
Expiration : 30 days / 60 days / 90 days
```

Centang scope:

```txt
repo
workflow
```

Keterangan:

- `repo` buat create repo, update repo, clone, push.
- `workflow` dibutuhkan kalau project ada folder `.github/workflows`.

Klik:

```txt
Generate token
```

Copy token yang muncul, biasanya seperti:

```txt
ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Jangan share token ke siapa pun.

---

## Cara Login di Tools

Saat `npm start`, GitShip akan minta:

```txt
Username GitHub
Email GitHub
GitHub Personal Access Token
```

Token akan disembunyikan.

Kamu juga bisa pakai environment variable.

### Termux / Linux / macOS

```bash
export GITHUB_USERNAME="username-kamu"
export GITHUB_EMAIL="email-kamu@example.com"
export GITHUB_TOKEN="token-kamu"

npm start
```

### Windows PowerShell

```powershell
$env:GITHUB_USERNAME="username-kamu"
$env:GITHUB_EMAIL="email-kamu@example.com"
$env:GITHUB_TOKEN="token-kamu"

npm start
```

---

## Cara Update Repo Lama

Jalankan:

```bash
npm start
```

Pilih:

```txt
Update repo lama — upload folder atau ZIP project
```

Masukkan URL repo:

```txt
https://github.com/USERNAME/NAMA-REPO.git
```

Masukkan path project:

```txt
/sdcard/Download/ALIZZ-STORE-v4.zip
```

atau folder:

```txt
/sdcard/Download/ALIZZ-STORE v4/ALIZZ-STORE--main
```

Nanti keluar warning. Kalau sudah yakin repo target benar, ketik:

```txt
YA UPDATE REPO
```

Output sukses:

```txt
DONE — Repo lama berhasil diupdate!
Repo: https://github.com/USERNAME/NAMA-REPO
```

---

## Cara Deploy Repo Baru

Jalankan:

```bash
npm start
```

Pilih:

```txt
Deploy repo baru — upload folder atau ZIP project
```

Masukkan nama repo baru:

```txt
alizz-store-v4
```

Masukkan path project:

```txt
/sdcard/Download/ALIZZ-STORE-v4.zip
```

Output sukses:

```txt
DONE — Repo baru berhasil dibuat!
Repo baru: https://github.com/USERNAME/alizz-store-v4
```

---

## Tips Biar Gak Bingung Upload File

Kalau project kamu masih ZIP, tidak perlu extract manual. Langsung masukkan path ZIP:

```txt
/sdcard/Download/nama-project.zip
```

Kalau project kamu sudah folder, masukkan folder yang isinya langsung file project.

Contoh benar:

```txt
/sdcard/Download/ALIZZ-STORE-v4/ALIZZ-STORE--main
```

Contoh kurang tepat:

```txt
/sdcard/Download/ALIZZ-STORE-v4
```

Kalau folder itu cuma berisi satu folder lagi, GitShip versi baru akan bantu kalau inputnya ZIP. Tapi kalau inputnya folder manual, pastikan pilih folder yang isinya langsung project.

Cek isi folder di Termux:

```bash
ls "/sdcard/Download/NAMA-FOLDER"
```

Kalau muncul `package.json`, `index.html`, `src`, `api`, `lib`, berarti itu biasanya folder yang benar.

---

## Error Umum

### Git belum terinstall

```bash
pkg install git -y
```

### Node belum terinstall

```bash
pkg install nodejs -y
```

### Project tidak ditemukan

Cek path:

```bash
ls /sdcard/Download
```

### Token invalid

Buat token baru, lalu jalankan ulang.

### Nama repo sudah dipakai

Pakai nama repo lain, contoh:

```txt
alizz-store-v4
alizz-store-v5
```

---

## Keamanan

GitShip tidak menyimpan token ke file. Token hanya dibaca dari:

```txt
Environment variable
Input aman/masked
```

Jangan pernah upload token ke GitHub, README, HTML, JS frontend, atau chat publik.

---

## License

MIT License.

Made with focus by **ALIZZ**.

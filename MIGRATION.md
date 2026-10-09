# Migrasi dari 2.2.0

1. **Config lama** (`~/.alizz-gitship/config.json` tanpa `schemaVersion`) tetap terbaca. Ia ditulis ulang ke format v2 hanya saat Anda login lagi dengan opsi simpan.
2. **Environment**: ketiga variabel harus lengkap. Token env tidak disimpan; pakai `gitship auth login --remember` jika ingin menyimpan.
3. **Repo baru** kini menanyakan visibility; **update** menanyakan mode (replace = perilaku lama).
4. **Skrip non-interaktif**: gunakan `gitship upload ...` (lihat README); replace butuh `--confirm-replace owner/repo@branch`.
5. **Rollback**: `npm install -g alizz-gitship@2.2.0` (atau pasang tarball lama). Config v2 tetap berisi `username`, `email`, `token`, sehingga masih terbaca versi 2.2.0 (field tambahan diabaikan). Hapus login: `gitship auth logout` atau hapus `~/.alizz-gitship/config.json`.
6. Versi 2.2.0 mencetak encoding Basic kredensial pada pesan error Git dan membuat repo selalu public; hindari menjalankannya terhadap akun penting.

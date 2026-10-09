# Changelog

## 3.0.0-rc.1
Perubahan perilaku disengaja:
- Token environment tidak lagi tersimpan otomatis (login interaktif menawarkan simpan).
- Visibility repo baru dipilih eksplisit (sebelumnya selalu public).
- File sensitif (.env, key, credential) tidak lagi ikut; `.gitignore` dihormati; `node_modules`/log/cache diabaikan.
- Update tanpa perubahan = no-op (tidak ada commit kosong).
- Runtime minimal Node `^22.12.0` (sebelumnya `>=20`), Git `>= 2.31`.
- Preview ditampilkan sebelum konfirmasi (target, branch, mode, base SHA, tambah/ubah/hapus).
Perbaikan: kredensial keluar dari argv Git; 403 rate limit dibedakan dari token invalid; pagination tanpa batas 500/30; cleanup di semua jalur; error upload kembali ke menu; ZIP root dengan `.gitignore` tidak lagi kehilangan file.
Baru: mode overlay, branch selector, `--dry-run`, `--json`, `doctor`, `auth`, `upload` non-interaktif, pesan commit kustom.
Internal: modular; parser ZIP sendiri menggantikan `adm-zip`.

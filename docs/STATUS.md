# Status implementasi (rc.1)

| Gate/Area | Status | Bukti |
| --- | --- | --- |
| P0: kredensial, policy file, visibility, preview, cleanup, login recovery | Selesai | `test/*.test.js` (33 tes) |
| Modular + kompatibilitas config/env | Selesai | `test/unit.test.js`, `test/cli.test.js` |
| ZIP dengan parser nyata + batas aktual | Selesai | `test/zip.test.js` (ZIP asli dari Python) |
| Overlay, branch selector, pagination, dry-run, doctor, no-op, JSON | Selesai | `test/upload.test.js`, `test/cli.test.js` |
| Menu interaktif | Diuji hanya dengan paket UI palsu (alur, bukan tampilan) | smoke script manual |
| Lockfile, upgrade dependensi, audit advisori | BELUM (sandbox tanpa jaringan) | — |
| Migrasi API 2026-03-10 | BELUM (adapter siap; versi bisa disetel) | — |
| Node 24, Windows, macOS, Termux, GitHub asli | BELUM diuji | — |
| Batas ZIP di perangkat mobile | Asumsi, belum diukur | — |
Backlog: organization, PR flow, keychain, `.gitshipignore` bertingkat, ZIP64, CI matriks.

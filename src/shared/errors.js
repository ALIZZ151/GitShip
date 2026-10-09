// Kategori exit code: 0 sukses/no-op, 2 usage/validasi, 3 auth/izin, 4 jaringan/API, 5 konflik Git/rules, 130 dibatalkan
export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, AUTH: 3, NETWORK: 4, GIT: 5, CANCELLED: 130 };

export class AppError extends Error {
  constructor(code, message, detail = "", exitCode = EXIT.FAILED) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

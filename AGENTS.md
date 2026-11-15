# AGENTS.md

## Struktur
- Seluruh aplikasi di `nexamanga/`: backend serverless Vercel + tema Blogger `nexamanga.xml`.
- Node ≥20, CommonJS, tanpa framework HTTP, tanpa lint/typecheck/CI/lockfile.
- Semua endpoint lewat satu catch-all `nexamanga/api/[...path].js` (routing manual setelah `/api/`).
- Domain di `nexamanga/lib/`: `catalog.js` (validasi manga/chapter/komentar/users), `auth.js` (token HMAC-SHA256), `telegram.js` (storage & media).

## Perintah
- Dari `nexamanga/`: `npm test` (`node --test`) — satu-satunya script.
- Tidak ada lint/format/typecheck untuk dijalankan.
- Test unit + API (mock `global.fetch`); baseline harus hijau sebelum dan sesudah perubahan.

## Jebakan yang tidak terlihat dari nama file
- **Tidak ada login password.** Admin = OAuth Google/Discord; pengguna pertama otomatis `role: 'admin'`. README, `.env.example`, dan kode sudah OAuth-only — jangan tambahkan lagi `ADMIN_PASSWORD` / `POST /api/admin/login`.
- Database = **satu dokumen JSON** di channel Telegram, dibaca dari pesan yang di-pin dengan caption persis `NexaManga database snapshot`. Jangan lepas pin; init otomatis saat OAuth pertama (atau `POST /api/admin/storage/init`).
- Penulisan katalog = read → mutate → write (tanpa transaksi). Satu sesi admin saja.
- `CatalogNotInitializedError` → HTTP 409 (bukan 500 generik). `StorageAlreadyInitializedError` juga 409.
- Batas: snapshot 18 MiB; upload gambar 3 MiB (JPEG/PNG/WebP base64); body ~4.5 MiB; `vercel.json` maxDuration 60s.
- Env wajib: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_STORAGE_CHAT_ID`, `TOKEN_SECRET` (≥32), `PUBLIC_API_URL` (HTTPS tanpa trailing slash), `ALLOWED_ORIGINS` (origin Blogger, dipakai CORS + `return_to` OAuth), `GOOGLE_CLIENT_ID/SECRET`, `DISCORD_CLIENT_ID/SECRET`.
- `config()` di `lib/telegram.js` otomatis membuka kutip pada nilai env.
- `GET /api/catalog` selalu menghapus field `users`; hanya komentar `approved` untuk non-admin.
- OAuth callback mengirim token lewat `?auth_token=` lalu tema menyimpan di `sessionStorage` (`kv_session_token`).
- Tanpa `CONFIG.API_BASE_URL` di XML, tema jalan mode localStorage lokal.

## Konvensi
- Pesan error & JSON respons berbahasa Indonesia (`{ error }`, `{ ok: true }`).
- Test = `node:test` + mock `global.fetch` (Telegram tidak disentuh sungguhan).

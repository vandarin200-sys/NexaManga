# NexaManga

Blogger theme (XML) + Vercel backend (Node.js + Neon Postgres + Telegram media storage).

## Struktur

- `nexamanga.xml` — template Blogger (SPA frontend).
- `nexamanga/` — backend Vercel:
  - `api/[...path].js` — serverless API.
  - `lib/` — auth, catalog, db, telegram, env.
  - `test/` — node --test.

## Setup Backend (Vercel)

1. Buat project Vercel, import folder `nexamanga/`.
2. Buat database Neon Postgres, copy connection string.
3. Buat bot Telegram via @BotFather, buat channel/grup penyimpanan gambar, tambahkan bot sebagai admin.
4. Set environment variables di Vercel (lihat `.env.example`):
   - `DATABASE_URL`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_STORAGE_CHAT_ID`
   - `TOKEN_SECRET` (acak min 32 karakter)
   - `PUBLIC_API_URL` (URL Vercel, tanpa slash)
   - `ALLOWED_ORIGINS` (origin Blogger)
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (opsional OAuth)
   - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` (opsional OAuth)
5. Deploy. Skema tabel dibuat otomatis pada request pertama.

## Setup Frontend (Blogger)

1. Upload `nexamanga.xml` ke Blogger (Tema → Edit HTML → paste → Simpan).
2. Di XML, set `CONFIG.API_BASE_URL` ke URL Vercel (harus sama dengan `PUBLIC_API_URL`).
3. Pastikan `CONFIG.SITE_NAME`, dll. sesuai.

## Inisialisasi Data

1. Login admin di situs (akun pertama yang login via OAuth otomatis menjadi admin).
2. Buka Admin → Pengaturan → (opsional) inisialisasi storage jika diminta.
3. Tambah manga/chapter, atau gunakan tab MangaDex untuk scrape.

## Fitur Utama

- SPA: beranda, archive, detail manga, reader (webtoon/paged), komentar + balasan, reaksi chapter, bookmark.
- Admin: dashboard, analitik traffic, manajemen manga/chapter, moderasi komentar, pengguna, pengaturan, leaderboard judul, scrape MangaDex.
- Mode tema: Sepia (cerah) / Gelap.
- Kompresi gambar (WebP/JPEG) sebelum upload ke Telegram (atur di Pengaturan).

## Menjalankan Test

```bash
cd nexamanga
npm test
```

## Catatan

- Gambar disimpan di Telegram, katalog di Neon Postgres.
- Analytics traffic dicatat via `/api/track` (pageview + unique visitor per hari).
- MangaDex scrape memakai proxy backend untuk menghindari CORS/403.

## Lisensi

Private project.
EOF
# NexaManga backend (Vercel + Neon, gambar di Telegram)

Backend serverless untuk tema Blogger `nexamanga.xml`. Katalog, chapter, komentar, data akun, role, reaksi, progres XP/level/streak, dan pengaturan disimpan di PostgreSQL Neon; Vercel menjalankan API dan menyimpan secrets sebagai environment variables. Gambar chapter dan thumbnail tetap disimpan di Telegram dan ditayangkan lewat endpoint proxy Vercel.

## Isi penyimpanan

- Katalog, chapter, komentar, akun, kredensial, koneksi tracker, reaksi, laporan, progres XP/level/streak, dan pengaturan: tabel relasional PostgreSQL Neon (`nexamanga_manga`, `nexamanga_chapters`, `nexamanga_comments`, `nexamanga_accounts`, `nexamanga_user_progress`, dan lainnya). Skema dibuat otomatis pada request pertama.
- Penulisan memakai transaksi dan kolom `revision` pada `nexamanga_catalog_state`, sehingga perubahan paralel tidak saling menimpa diam-diam; request yang kalah bersaing mendapat respons `409` dan bisa mencoba lagi.
- Data lama pada `nexamanga_snapshot` dipindahkan otomatis atau lewat endpoint migrasi admin. Tabel lama sengaja dibiarkan sebagai cadangan sampai kamu yakin migrasi berhasil.
- Gambar chapter dan gambar komentar: dokumen pada channel database Telegram (hanya file gambar, bukan katalog).
- Token bot, connection string Neon, OAuth client secret, dan signing secret: hanya di environment Vercel.
- Bookmark, riwayat, dan preferensi tema: masih di `localStorage` browser.
- Progres pembaca: XP dicatat sekali per aksi unik (`welcome`, komentar yang disetujui, pembukaan manga per hari, reaksi). Level naik setiap 220 XP; streak dihitung dari tanggal aktivitas terakhir. `GET /api/leaderboard` dan `GET /api/user/:username/xp` menyajikan data ini dari database. Profil publik memakai `public_slug` delapan karakter yang diturunkan secara deterministik dari id akun di database, dipakai pada `/profile/<slug>`. Peringkat komik memakai event `nexamanga_manga_view_events` yang nyata per pengunjung per hari; periode `all` memakai total view katalog yang tersimpan.

Jangan menyimpan atau mengunggah materi yang tidak kamu miliki izinnya.

## Persiapan Neon

1. Buat project gratis di [Neon](https://console.neon.tech).
2. Buka **Connection Details** dan salin connection string (opsi pooler cocok untuk serverless), misalnya `postgresql://user:password@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require`.
3. Isi sebagai environment variable `DATABASE_URL` di Vercel maupun lokal.

Skema tidak perlu dibuat manual. Request pertama membuat tabel relasional berikut beserta index dan view `nexamanga_users`:

```text
nexamanga_catalog_state                      status inisialisasi, revision, jejak migrasi
nexamanga_manga / nexamanga_manga_genres     katalog dan genre
nexamanga_chapters / nexamanga_chapter_pages chapter dan halaman gambar
nexamanga_comments / nexamanga_comment_upvotes komentar dan suka
nexamanga_reports                            laporan
nexamanga_accounts / nexamanga_account_credentials / nexamanga_account_connections
                                              akun, slug profil publik, kata sandi, verifikasi email, koneksi tracker
nexamanga_chapter_reactions / nexamanga_manga_reactions
                                              reaksi pembaca
nexamanga_user_progress / nexamanga_xp_events progres XP, level, streak, dan riwayat aksi
nexamanga_manga_view_events                 event baca komik per pengunjung per hari
nexamanga_settings                           pengaturan situs
nexamanga_analytics_days / nexamanga_analytics_visitors
                                             statistik kunjungan
nexamanga_users                              view akun untuk query SQL biasa
```

Daftar akun dapat ditanyakan seperti tabel biasa:

```sql
SELECT id, name, xp, level, streak_days FROM nexamanga_users ORDER BY xp DESC;
```

Jika database masih memakai `nexamanga_snapshot`, backend memindahkan isinya saat katalog dibaca atau saat endpoint migrasi admin dipanggil. Tabel lama tidak dihapus otomatis. Hanya PostgreSQL/Neon yang didukung; `DATABASE_URL` MySQL atau `DB_DRIVER=mysql` ditolak dengan pesan yang jelas.

## Persiapan Telegram (hanya untuk gambar)


1. Buat bot melalui [@BotFather](https://t.me/BotFather), lalu simpan token bot.
2. Buat satu channel privat atau grup privat untuk penyimpanan gambar. Tambahkan bot sebagai admin dengan izin mengirim pesan. Pin pesan tidak lagi diperlukan.
3. Catat ID chat. Untuk channel/grup privat, ID biasanya diawali `-100`. Jangan membagikan URL API Telegram yang berisi token.

## Deploy ke Vercel

Deploy folder proyek ini sebagai aplikasi Vercel dengan runtime Node.js 20 atau lebih baru. Isi environment variables berikut di **Project Settings → Environment Variables**:

| Variable | Nilai |
|---|---|
| `DATABASE_URL` | Connection string dari Neon (Postgres) |
| `TELEGRAM_BOT_TOKEN` | Token bot dari BotFather |
| `TELEGRAM_STORAGE_CHAT_ID` | ID satu channel/grup tempat gambar disimpan |
| `TOKEN_SECRET` | Secret acak minimal 32 karakter |
| `PUBLIC_API_URL` | URL HTTPS deployment, misalnya `https://nexamanga-nexamanga.vercel.app` |
| `ALLOWED_ORIGINS` | Origin Blogger yang tepat, misalnya `https://nama-blog.blogspot.com` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client credentials Google |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | OAuth application credentials Discord |
| `EMAIL_VERIFY_WEBHOOK_URL` | Endpoint HTTPS pengirim kode verifikasi email (6 digit) |
| `EMAIL_WEBHOOK_TOKEN` | Bearer token opsional untuk webhook verifikasi email |
| `ANILIST_CLIENT_ID` / `ANILIST_CLIENT_SECRET` | OAuth credentials AniList untuk koneksi profil |
| `MAL_CLIENT_ID` / `MAL_CLIENT_SECRET` | OAuth credentials MyAnimeList untuk koneksi profil |

Template [`.env.example`](./nexamanga/.env.example) menunjukkan formatnya. Untuk pengaturan lokal, salin menjadi `.env` dan ganti nilai contoh. Di Vercel, masukkan nilainya langsung tanpa tanda kutip. Jangan pernah commit `.env` atau membagikan secrets.

`TOKEN_SECRET` dapat dibuat dengan `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Jangan gunakan `*` pada `ALLOWED_ORIGINS` untuk situs publik.

### Konfigurasi OAuth

Daftarkan URL callback berikut sebagai **Authorized redirect URI** di Google Cloud OAuth Client dan Discord Developer Portal:

```text
https://nexamanga-nexamanga.vercel.app/api/auth/google/callback
https://nexamanga-nexamanga.vercel.app/api/auth/discord/callback
```

Ganti domain dengan nilai `PUBLIC_API_URL`. `CONFIG.API_BASE_URL` di `nexamanga.xml` **harus sama persis** dengan `PUBLIC_API_URL` (origin HTTPS tanpa trailing slash). Origin blog (`https://x10think.blogspot.com` dsb.) harus terdaftar di `ALLOWED_ORIGINS`.

Akun pertama yang berhasil mendaftar melalui Google atau Discord mendapat role `admin`; akun berikutnya mendapat role `member`. Tabel relasional diinisialisasi otomatis saat pendaftaran pertama jika tidak ada data lama. Jika `nexamanga_snapshot` masih berisi data, jalankan migrasi admin terlebih dahulu dan jangan hapus tabel lama sebelum migrasi berhasil. Role tidak dapat dipilih dari browser.

Setelah deploy dengan semua variabel di atas, periksa API:

```powershell
$api = "https://nexamanga-nexamanga.vercel.app"
Invoke-RestMethod -Method Get -Uri "$api/api/health"
```

## Hubungkan Blogger

Ubah `CONFIG.API_BASE_URL` di `nexamanga.xml` agar sama dengan `PUBLIC_API_URL` di `.env` / Vercel, tanpa garis miring di akhir:

```js
API_BASE_URL: 'https://nexamanga-nexamanga.vercel.app'
```

Lalu unggah XML itu melalui **Blogger → Tema → Edit HTML**. Endpoint `/api/health` dapat dipakai untuk memeriksa apakah deployment merespons.

## Role akun

- Akun pertama yang berhasil menyelesaikan OAuth menjadi `admin`.
- Pendaftaran akun berikutnya menjadi `member`.
- Role ditetapkan backend dan disimpan di database Neon; nilai role dari browser tidak dipercaya.
- Pada setiap request penting, backend membaca akun langsung dari Neon: perubahan role (promosikan/turunkan) dan penghapusan akun berlaku **langsung**, tanpa menunggu token habis. Identitas komentar juga selalu dipaksa dari sesi server.
- Hanya `admin` yang dapat mengakses endpoint pengelolaan manga, chapter, komentar, dan media.

## Endpoint

- `GET /api/auth/google/start`, `GET /api/auth/discord/start` — mulai login OAuth. Parameter `return_to` harus ada pada `ALLOWED_ORIGINS`.
- `GET /api/auth/{google|discord}/callback` — callback OAuth.
- `GET /api/auth/me` — mengembalikan profil, role, status verifikasi email, kata sandi, dan ringkasan koneksi tracker; token mentah tidak pernah dikirim ke klien.
- `POST /api/account/credentials`, `/api/account/email/resend`, `/api/account/email/verify`, `/api/account/password`, `/api/account/delete` — pengaturan akun.
- `POST /api/account/connections/link-token`, `/api/account/connections/unlink`, `/api/account/connections/sync` — koneksi AniList/MyAnimeList.
- `GET /api/auth/{anilist|mal}/link/start`, `GET /api/auth/{anilist|mal}/link/callback` — OAuth penautan tracker.
- `POST /api/admin/storage/init` — inisialisasi tabel relasional sekali, memerlukan sesi admin; biasanya tidak diperlukan karena pendaftaran pertama menginisialisasi otomatis. Kirim `{"force":true}` hanya jika kamu sengaja menimpa data lama.
- `POST /api/admin/storage/migrate` — pindahkan isi `nexamanga_snapshot` ke tabel relasional, memerlukan sesi admin; aman diulang.
- `GET /api/catalog` — katalog publik; hanya komentar disetujui (dan komentar pending milik pengirimnya) yang dikirim ke pengunjung. Sesi admin menerima semua komentar untuk moderasi. Reaksi dikirim sebagai jumlah suara dan status suara pengirim, bukan daftar identitas pemilih.
- `POST /api/chapter/reaction`, `POST /api/manga/reaction` — reaksi (`fire`, `shock`, `cry`, `laugh`, `angry`); toggle. Identitas pemilih ditentukan backend dari sesi atau sidik jari anonim; `voterId` dari klien diabaikan.
- `POST /api/comment` — kirim komentar berstatus `pending` sampai disetujui admin. `chapterId` opsional; isi untuk komentar di halaman chapter. Balasan mewarisi chapter induk. Komentar tanpa sesi ditampilkan sebagai `Pengunjung`.
- `POST /api/comment/upvote` — suka komentar; identitas pemilih juga ditentukan backend.
- `POST /api/manga/view` — catat event baca komik (maksimal satu per manga per pengunjung per hari), menaikkan total view katalog, dan memberi XP `manga_view` hanya untuk event baru.
- `GET /api/leaderboard?range=day|week|month|all&type=users|comics|both&limit=50` — peringkat pembaca dari XP dan peringkat komik dari event baca; `type=anime` diterima sebagai alias lama `comics`. Respons memakai kunci `users` dan `comics`.
- `GET /api/user/:username/xp` — level, XP, tier, dan streak satu pembaca dari database.
- `GET /api/profile/:slug` — profil publik tanpa login: nama, avatar, slug, XP/level/tier/streak, dan komentar publik terbaru. Slug adalah `public_slug` delapan karakter yang diturunkan dari id akun.
- `POST /api/admin/save-manga`, `/api/admin/save-chapter`
- `POST /api/admin/delete-manga`, `/api/admin/delete-chapter`
- `POST /api/admin/delete-comment`, `/api/admin/comment-status`, `/api/admin/pin-comment` — hapus, moderasi status, atau sematkan komentar (admin).
- `POST /api/admin/upload-dual` — unggah gambar ke Telegram; batas 3 MiB per berkas karena batas request Vercel dan encoding base64.
- `GET /api/media/{file_id}` — proxy gambar dari Telegram.
- `POST /api/track` — catat pageview/visitor (publik).
- `GET /api/analytics?from=&to=` — analitik traffic (admin).
- `GET /api/mangadex/manga`, `/chapters`, `/athome`, `/image` — proxy MangaDex (admin).

Seluruh endpoint admin memerlukan `Authorization: Bearer <token>` dengan role `admin`; sesi berlaku 7 hari dan diperbarui otomatis saat halaman dibuka kembali mendekati akhir masa berlaku. Endpoint tulis publik dibatasi 15 komentar atau 120 reaksi/pageview per menit per pengunjung (`429` jika terlalu sering); pembatasan ini best-effort karena instance serverless tidak berbagi memori. Perubahan katalog di Neon memakai transaksi dan `revision`: jika dua request menulis bersamaan, yang kalah mendapat `409` dan bisa mengulang. Instance serverless masih menangani satu request per invocation, jadi sesi admin tunggal tetap disarankan saat pengubahan massal.

## Pemeriksaan lokal

```powershell
cd nexamanga
npm test
```

Smoke adapter database terhadap database uji PostgreSQL/Neon yang kosong (tidak memakai `DATABASE_URL` produksi); mencakup katalog dan pencatatan XP idempoten:

```powershell
$env:SMOKE_DATABASE_URL = "postgresql://user:password@host/dbname?sslmode=require"
node scripts\smoke-db.js
```

## Struktur proyek

- `nexamanga.xml` — template Blogger (SPA frontend).
- `nexamanga/public/index.html` — SPA statis untuk deployment Vercel (satu-satunya salinan frontend).
- `nexamanga/` — backend Vercel (api, lib, test, scripts).

## Fitur frontend

- SPA: beranda, archive, detail manga, reader (webtoon/paged), komentar + balasan, reaksi chapter, bookmark.
- Admin: dashboard, analitik traffic, manajemen manga/chapter, moderasi komentar, pengguna, pengaturan, leaderboard, scrape MangaDex.
- Tema: Sepia (cerah) / Gelap. Kompresi gambar (WebP/JPEG) sebelum upload ke Telegram.

## Lisensi

Private project.

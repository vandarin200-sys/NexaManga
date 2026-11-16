# NexaManga backend (Vercel + Neon, gambar di Telegram)

Backend serverless untuk tema Blogger `nexamanga.xml`. Katalog, chapter, komentar, data akun, role, reaksi, dan pengaturan disimpan di PostgreSQL Neon; Vercel menjalankan API dan menyimpan secrets sebagai environment variables. Gambar chapter dan thumbnail tetap disimpan di Telegram dan ditayangkan lewat endpoint proxy Vercel.

## Isi penyimpanan

- Katalog, chapter, komentar, dan daftar akun: satu baris dokumen JSONB pada tabel `nexamanga_snapshot` di database Neon. Tabel dibuat otomatis pada request pertama.
- Penulisan memakai optimistic concurrency control (kolom `version`), sehingga perubahan paralel tidak saling menimpa diam-diam; request yang kalah bersaing mendapat respons `409` dan bisa mencoba lagi.
- Gambar chapter dan gambar komentar: dokumen pada channel database Telegram (hanya file gambar, bukan katalog).
- Token bot, connection string Neon, OAuth client secret, dan signing secret: hanya di environment Vercel.
- Bookmark, riwayat, dan preferensi tema: masih di `localStorage` browser.

Jangan menyimpan atau mengunggah materi yang tidak kamu miliki izinnya.

## Persiapan Neon

1. Buat project gratis di [Neon](https://console.neon.tech).
2. Buka **Connection Details** dan salin connection string (opsi pooler cocok untuk serverless), misalnya `postgresql://user:password@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require`.
3. Isi sebagai environment variable `DATABASE_URL` di Vercel maupun lokal.

Skema tabel tidak perlu dibuat manual. Request pertama membuat tabel:

```sql
CREATE TABLE IF NOT EXISTS nexamanga_snapshot (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Selain itu, aplikasi membuat view opsional `nexamanga_users` (gagal membuat view tidak mematikan API) sehingga daftar akun bisa ditanyakan seperti tabel biasa:

```sql
SELECT * FROM nexamanga_users ORDER BY created_at;
```

View ini hanya membaca dokumen JSONB — tidak ada tabel akun terpisah; data tetap satu sumber di `nexamanga_snapshot`.

### Migrasi dari Telegram (opsional, untuk instalasi lama)

Jika sebelumnya katalog disimpan sebagai snapshot di chat Telegram, salin sekali ke Neon:

```powershell
npm run db:migrate
```

Perintah ini membaca pesan snapshot yang dipin di chat Telegram lalu menyalinnya ke tabel `nexamanga_snapshot`. Perintah gagal dengan aman jika tabel Neon sudah berisi data. Pesan Telegram tidak dihapus oleh skrip; hapus manual setelah Neon terverifikasi. Jika tidak ada migrasi yang perlu dilakukan, abaikan langkah ini.

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

Selain pengaturan penyimpanan, tambahkan variabel aplikasi dan OAuth berikut:

| Variable | Nilai |
|---|---|
| `TOKEN_SECRET` | Secret acak minimal 32 karakter |
| `PUBLIC_API_URL` | URL HTTPS deployment, misalnya `https://nexamanga-nexamanga.vercel.app` |
| `ALLOWED_ORIGINS` | Origin Blogger yang tepat, misalnya `https://nama-blog.blogspot.com`; pisahkan beberapa origin dengan koma |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client credentials Google |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | OAuth application credentials Discord |

Template [`.env.example`](./.env.example) menunjukkan formatnya. Untuk pengaturan lokal, salin menjadi `.env` dan ganti nilai contoh. Di Vercel, masukkan nilainya langsung tanpa tanda kutip. Jangan pernah commit `.env` atau membagikan secrets. Jika token bot pernah terungkap, cabut di BotFather dan buat token baru. Jika connection string Neon bocor, rotasi password/reset dari dashboard Neon.

`TOKEN_SECRET` dapat dibuat dengan `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Jangan gunakan `*` pada `ALLOWED_ORIGINS` untuk situs publik.

### Konfigurasi OAuth

Daftarkan URL callback berikut sebagai **Authorized redirect URI** di Google Cloud OAuth Client dan Discord Developer Portal:

```text
https://nexamanga-nexamanga.vercel.app/api/auth/google/callback
https://nexamanga-nexamanga.vercel.app/api/auth/discord/callback
```

Ganti domain dengan nilai `PUBLIC_API_URL`. `CONFIG.API_BASE_URL` di `nexamanga.xml` **harus sama persis** dengan `PUBLIC_API_URL` (origin HTTPS tanpa trailing slash). Origin blog (`https://x10think.blogspot.com` dsb.) harus terdaftar di `ALLOWED_ORIGINS`.

Akun pertama yang berhasil mendaftar melalui Google atau Discord mendapat role `admin`; akun berikutnya mendapat role `member`. Pendaftaran pertama membuat baris snapshot katalog Neon jika belum ada, sehingga tidak perlu langkah inisialisasi terpisah. Role tidak dapat dipilih dari browser. Jangan hapus isi baris `nexamanga_snapshot` di Neon.

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
- Pada setiap request penting, backend membaca akun langsung dari Neon: perubahan role (promosikan/turunkan) dan penghapusan akun berlaku **langsung**, tanpa menunggu token 8 jam habis. Identitas komentar juga selalu dipaksa dari sesi server.
- Hanya `admin` yang dapat mengakses endpoint pengelolaan manga, chapter, komentar, dan media.

## Endpoint

- `GET /api/auth/google/start`, `GET /api/auth/discord/start` — mulai login OAuth. Parameter `return_to` harus ada pada `ALLOWED_ORIGINS`.
- `GET /api/auth/{google|discord}/callback` — callback OAuth.
- `GET /api/auth/me` — mengembalikan profil dan role sesi aktif.
- `POST /api/admin/storage/init` — inisialisasi sekali, memerlukan sesi admin; biasanya tidak diperlukan karena pendaftaran pertama menginisialisasi otomatis.
- `GET /api/catalog` — katalog publik; hanya komentar disetujui yang dikirim ke pengunjung. Sesi admin juga menerima komentar untuk moderasi.
- `POST /api/chapter/reaction` — reaksi chapter (`fire`, `shock`, `cry`, `laugh`, `angry`); toggle per `voterId`.
- `POST /api/comment` — kirim komentar. `chapterId` opsional; isi untuk komentar di halaman chapter. Balasan mewarisi chapter induk.
- `POST /api/comment` — kirim komentar untuk moderasi.
- `POST /api/admin/save-manga`, `/api/admin/save-chapter`
- `POST /api/admin/delete-manga`, `/api/admin/delete-chapter`
- `POST /api/admin/delete-comment`, `/api/admin/comment-status`, `/api/admin/pin-comment` — hapus, moderasi status, atau sematkan komentar (admin).
- `POST /api/admin/upload-dual` — unggah gambar ke Telegram; batas 3 MiB per berkas karena batas request Vercel dan encoding base64.
- `GET /api/media/{file_id}` — proxy gambar dari Telegram.

Seluruh endpoint admin memerlukan `Authorization: Bearer <token>` dengan role `admin`; sesi berlaku 8 jam. Backend tidak menyediakan login password. Perubahan katalog di Neon memakai optimistic concurrency control: jika dua request menulis bersamaan, yang kalah mendapat `409` dan bisa mengulang. Instance serverless masih menangani satu request per invocation, jadi sesi admin tunggal tetap disarankan saat pengubahan massal.

## Pemeriksaan lokal

```powershell
npm test
```

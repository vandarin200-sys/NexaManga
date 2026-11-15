# NexaManga backend (Vercel + Telegram)

Backend serverless untuk tema Blogger `nexamanga.xml`. Katalog, chapter, komentar, data akun, role, dan gambar disimpan di Telegram; Vercel menjalankan API dan menyimpan secrets sebagai environment variables.

## Isi penyimpanan

- Katalog, chapter, komentar, dan daftar akun: satu dokumen JSON pada pesan channel database Telegram.
- Gambar chapter: dokumen terpisah pada channel database Telegram.
- Token bot, OAuth client secret, dan signing secret: hanya di environment Vercel.
- Bookmark, riwayat, dan preferensi tema: masih di `localStorage` browser.

Jangan menyimpan atau mengunggah materi yang tidak kamu miliki izinnya.

## Persiapan Telegram

1. Buat bot melalui [@BotFather](https://t.me/BotFather), lalu simpan token bot.
2. Buat satu channel privat atau grup privat untuk penyimpanan. Tambahkan bot sebagai admin dengan izin mengirim dan menyematkan (pin) pesan.
3. Catat ID chat. Untuk channel/grup privat, ID biasanya diawali `-100`. Jangan membagikan URL API Telegram yang berisi token.

## Deploy ke Vercel

Deploy folder proyek ini sebagai aplikasi Vercel dengan runtime Node.js 20 atau lebih baru. Isi variabel Telegram di **Project Settings → Environment Variables**:

| Variable | Nilai |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token bot dari BotFather |
| `TELEGRAM_STORAGE_CHAT_ID` | ID satu channel/grup tempat katalog dan gambar disimpan |

Selain pengaturan Telegram, tambahkan variabel aplikasi dan OAuth berikut:

| Variable | Nilai |
|---|---|
| `TOKEN_SECRET` | Secret acak minimal 32 karakter |
| `PUBLIC_API_URL` | URL HTTPS deployment, misalnya `https://nexamanga-nexamanga.vercel.app` |
| `ALLOWED_ORIGINS` | Origin Blogger yang tepat, misalnya `https://nama-blog.blogspot.com`; pisahkan beberapa origin dengan koma |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client credentials Google |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | OAuth application credentials Discord |

Template [`.env.example`](./.env.example) menunjukkan formatnya. Untuk pengaturan lokal, salin menjadi `.env` dan ganti nilai contoh. Di Vercel, masukkan nilainya langsung tanpa tanda kutip. Jangan pernah commit `.env` atau membagikan secrets. Jika token bot pernah terungkap, cabut di BotFather dan buat token baru.

`TOKEN_SECRET` dapat dibuat dengan `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Jangan gunakan `*` pada `ALLOWED_ORIGINS` untuk situs publik.

### Konfigurasi OAuth

Daftarkan URL callback berikut sebagai **Authorized redirect URI** di Google Cloud OAuth Client dan Discord Developer Portal:

```text
https://nexamanga-nexamanga.vercel.app/api/auth/google/callback
https://nexamanga-nexamanga.vercel.app/api/auth/discord/callback
```

Ganti domain dengan nilai `PUBLIC_API_URL`. `CONFIG.API_BASE_URL` di `nexamanga.xml` **harus sama persis** dengan `PUBLIC_API_URL` (origin HTTPS tanpa trailing slash). Origin blog (`https://x10think.blogspot.com` dsb.) harus terdaftar di `ALLOWED_ORIGINS`.

Akun pertama yang berhasil mendaftar melalui Google atau Discord mendapat role `admin`; akun berikutnya mendapat role `member`. Pendaftaran pertama membuat snapshot katalog Telegram jika belum ada, sehingga tidak perlu langkah inisialisasi terpisah. Role tidak dapat dipilih dari browser. Jangan hapus daftar `users` dari snapshot Telegram.

Jika sudah memiliki database dari versi lama, pindahkan dan pin snapshot lama sebelum pendaftaran OAuth pertama. Pendaftaran tidak mengimpor data contoh XML secara otomatis.

Setelah deploy dengan semua variabel di atas, periksa API:

```powershell
$api = "https://nexamanga-nexamanga.vercel.app"
Invoke-RestMethod -Method Get -Uri "$api/api/health"
```

Dokumen snapshot dipin oleh backend pada pendaftaran pertama. Pesan yang dipin menjadi pointer database; tidak perlu chat scratch atau ID pesan tambahan. Jangan melepas pin dokumen snapshot, karena backend membacanya dari pesan yang disematkan.

## Hubungkan Blogger

Ubah `CONFIG.API_BASE_URL` di `nexamanga.xml` agar sama dengan `PUBLIC_API_URL` di `.env` / Vercel, tanpa garis miring di akhir:

```js
API_BASE_URL: 'https://nexamanga-nexamanga.vercel.app'
```

Lalu unggah XML itu melalui **Blogger → Tema → Edit HTML**. Endpoint `/api/health` dapat dipakai untuk memeriksa apakah deployment merespons.

## Role akun

- Akun pertama yang berhasil menyelesaikan OAuth menjadi `admin`.
- Pendaftaran akun berikutnya menjadi `member`.
- Role ditetapkan backend dan disimpan di snapshot Telegram; nilai role dari browser tidak dipercaya.
- Hanya `admin` yang dapat mengakses endpoint pengelolaan manga, chapter, komentar, dan media.

## Endpoint

- `GET /api/auth/google/start`, `GET /api/auth/discord/start` — mulai login OAuth. Parameter `return_to` harus ada pada `ALLOWED_ORIGINS`.
- `GET /api/auth/{google|discord}/callback` — callback OAuth.
- `GET /api/auth/me` — mengembalikan profil dan role sesi aktif.
- `POST /api/admin/storage/init` — inisialisasi sekali, memerlukan sesi admin; biasanya tidak diperlukan karena pendaftaran pertama menginisialisasi otomatis.
- `GET /api/catalog` — katalog publik; hanya komentar disetujui yang dikirim ke pengunjung. Sesi admin juga menerima komentar untuk moderasi.
- `POST /api/comment` — kirim komentar untuk moderasi.
- `POST /api/admin/save-manga`, `/api/admin/save-chapter`
- `POST /api/admin/delete-manga`, `/api/admin/delete-chapter`
- `POST /api/admin/delete-comment`, `/api/admin/comment-status`
- `POST /api/admin/upload-dual` — unggah gambar ke Telegram; batas 3 MiB per berkas karena batas request Vercel dan encoding base64.
- `GET /api/media/{file_id}` — proxy gambar dari Telegram.

Seluruh endpoint admin memerlukan `Authorization: Bearer <token>` dengan role `admin`; sesi berlaku 8 jam. Backend tidak menyediakan login password. Gunakan satu sesi admin saat mengubah data karena snapshot Telegram tidak menyediakan transaksi untuk perubahan paralel.

## Pemeriksaan lokal

```powershell
npm test
```

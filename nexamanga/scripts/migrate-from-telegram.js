'use strict';

// Migrasi satu kali: salin snapshot katalog yang dipin di chat Telegram ke database Neon.
// Memerlukan TELEGRAM_BOT_TOKEN, TELEGRAM_STORAGE_CHAT_ID, dan DATABASE_URL.
// Jalankan: npm run db:migrate

try {
  process.loadEnvFile('.env');
} catch {
  // .env opsional; variabel bisa datang dari environment shell atau Vercel.
}

const { validateCatalog } = require('../lib/catalog');
const { initializeCatalog, CatalogNotInitializedError } = require('../lib/db');
const { config } = require('../lib/env');

const CATALOG_CAPTION = 'NexaManga database snapshot';
const MAX_SNAPSHOT_BYTES = 18 * 1024 * 1024;

async function telegramCall(method, body) {
  const token = config('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result && result.description ? result.description : response.status}`);
  }
  return result.result;
}

async function readPinnedTelegramCatalog() {
  const chatId = config('TELEGRAM_STORAGE_CHAT_ID');
  const chat = await telegramCall('getChat', { chat_id: chatId });
  const message = chat && chat.pinned_message;
  if (!message || !message.document || !message.document.file_id || message.caption !== CATALOG_CAPTION) {
    throw new CatalogNotInitializedError();
  }
  if (message.document.file_size > MAX_SNAPSHOT_BYTES) {
    throw new Error('Snapshot katalog Telegram melebihi batas 18 MiB.');
  }
  const file = await telegramCall('getFile', { file_id: message.document.file_id });
  if (!file.file_path) throw new Error('Telegram tidak mengembalikan lokasi file.');
  const token = config('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return validateCatalog(JSON.parse(bytes.toString('utf8')));
}

(async () => {
  console.log('Membaca snapshot katalog dari pesan yang dipin di chat Telegram...');
  const catalog = await readPinnedTelegramCatalog();
  console.log(`Snapshot ditemukan: ${catalog.manga.length} manga, ${catalog.chapters.length} chapter, ${catalog.comments.length} komentar, ${catalog.users.length} pengguna.`);
  await initializeCatalog(catalog);
  console.log('Snapshot berhasil disalin ke tabel nexamanga_snapshot di Neon. Pesan Telegram dibiarkan apa adanya; jangan dihapus sampai Neon terverifikasi.');
})().catch((error) => {
  if (error instanceof CatalogNotInitializedError) {
    console.error('Tidak ada snapshot dipin di chat Telegram. Tidak ada yang dimigrasikan.');
  } else if (error && error.name === 'StorageAlreadyInitializedError') {
    console.error('Tabel nexamanga_snapshot di Neon sudah berisi data. Migrasi dibatalkan agar data tidak tertimpa.');
  } else {
    console.error('Migrasi gagal:', error && error.message ? error.message : error);
  }
  process.exitCode = 1;
});

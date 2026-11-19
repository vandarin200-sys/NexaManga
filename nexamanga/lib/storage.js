'use strict';

const { saveMedia } = require('./telegram');

function detectStorageProvider() {
  if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET) {
    return 'r2';
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_STORAGE_CHAT_ID) {
    return 'telegram';
  }
  return null;
}

async function uploadImage(fileName, mimeType, bytes, provider, baseUrl) {
  const selected = String(provider || detectStorageProvider() || '').toLowerCase();
  if (!selected) {
    throw new Error('Tidak ada penyimpanan gambar yang dikonfigurasi. Isi R2 atau Telegram di .env.');
  }
  if (selected === 'r2') {
    const r2 = require('./r2');
    const result = await r2.uploadToR2(fileName, mimeType, bytes);
    return {
      fileId: result.id,
      url: result.url,
      provider: 'r2',
      status: 'R2 tersimpan'
    };
  }
  const fileId = await saveMedia(fileName, mimeType, bytes);
  const cleanBase = String(baseUrl || process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
  return {
    fileId,
    url: `${cleanBase}/api/media/${encodeURIComponent(fileId)}`,
    provider: 'telegram',
    status: 'Telegram tersimpan'
  };
}

module.exports = {
  detectStorageProvider,
  uploadImage
};

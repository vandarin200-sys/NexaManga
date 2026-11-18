'use strict';

const { config } = require('./env');

const MAX_MEDIA_BYTES = 3 * 1024 * 1024;

class TelegramError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TelegramError';
  }
}

function botToken() {
  return config('TELEGRAM_BOT_TOKEN');
}

async function telegramCall(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || !result.ok) {
    throw new TelegramError(`Telegram ${method} failed: ${result && result.description ? result.description : response.status}`);
  }
  return result.result;
}

async function telegramMultipart(method, fields, fileField, filename, contentType, bytes) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  form.append(fileField, new Blob([bytes], { type: contentType }), filename);
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: 'POST',
    body: form
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || !result.ok) {
    throw new TelegramError(`Telegram ${method} failed: ${result && result.description ? result.description : response.status}`);
  }
  return result.result;
}

function storageChatId() {
  return config('TELEGRAM_STORAGE_CHAT_ID');
}

async function telegramFileInfo(fileId) {
  if (typeof fileId !== 'string' || !/^[A-Za-z0-9_=-]{10,512}$/.test(fileId)) {
    throw new Error('Telegram file ID tidak valid.');
  }
  const result = await telegramCall('getFile', { file_id: fileId });
  if (!result.file_path) throw new TelegramError('Telegram tidak mengembalikan lokasi file.');
  return result;
}

async function downloadTelegramFile(filePath, maxBytes) {
  if (typeof filePath !== 'string' || !filePath || /[\\\\]/.test(filePath) || filePath.includes('..')) {
    throw new TelegramError('Lokasi file Telegram tidak valid.');
  }
  const response = await fetch(`https://api.telegram.org/file/bot${botToken()}/${filePath}`);
  if (!response.ok) throw new TelegramError(`Telegram file download failed: ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw new Error('Ukuran file Telegram melebihi batas yang didukung.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('Ukuran file Telegram melebihi batas yang didukung.');
  return bytes;
}

async function saveMedia(fileName, mimeType, bytes) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw new Error('Format gambar harus JPEG, PNG, atau WebP.');
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
    throw new Error('Ukuran gambar harus lebih dari 0 dan maksimal 3 MiB.');
  }
  const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' })[mimeType];
  const safeName = String(fileName || 'image')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 100) || 'image';
  const filename = safeName.replace(/\.[^.]*$/, '') + extension;
  const message = await telegramMultipart('sendDocument', {
    chat_id: storageChatId()
  }, 'document', filename, mimeType, bytes);
  const document = message.document || (Array.isArray(message.photo) ? message.photo[message.photo.length - 1] : null) || message.sticker;
  if (!document || !document.file_id) {
    throw new TelegramError('Telegram tidak mengembalikan ID file gambar.');
  }
  return document.file_id;
}

async function getMedia(fileId) {
  const info = await telegramFileInfo(fileId);
  if (info.file_size > MAX_MEDIA_BYTES) {
    throw new Error('Ukuran gambar Telegram melebihi batas 3 MiB.');
  }
  return {
    bytes: await downloadTelegramFile(info.file_path, MAX_MEDIA_BYTES),
    filePath: info.file_path
  };
}

module.exports = {
  MAX_MEDIA_BYTES,
  TelegramError,
  getMedia,
  saveMedia
};

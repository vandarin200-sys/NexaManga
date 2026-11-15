'use strict';

const { EMPTY_CATALOG, validateCatalog } = require('./catalog');

const MAX_SNAPSHOT_BYTES = 18 * 1024 * 1024;
const MAX_MEDIA_BYTES = 3 * 1024 * 1024;
const CATALOG_CAPTION = 'NexaManga database snapshot';

class TelegramError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TelegramError';
  }
}

class StorageAlreadyInitializedError extends Error {
  constructor() {
    super('Database NexaManga sudah diinisialisasi pada pesan yang dipin.');
    this.name = 'StorageAlreadyInitializedError';
  }
}

class CatalogNotInitializedError extends Error {
  constructor() {
    super('Database NexaManga belum diinisialisasi. Jalankan /api/admin/storage/init dan pin pesan snapshot.');
    this.name = 'CatalogNotInitializedError';
  }
}

function config(name) {
  const rawValue = process.env[name];
  const value = typeof rawValue === 'string' && rawValue.length >= 2 &&
    ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'")))
    ? rawValue.slice(1, -1)
    : rawValue;
  if (!value) throw new Error(`Environment variable ${name} is required.`);
  return value;
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

async function getPinnedCatalogMessage() {
  const chat = await telegramCall('getChat', { chat_id: storageChatId() });
  const message = chat.pinned_message;
  if (!message || !message.document || !message.document.file_id || message.caption !== CATALOG_CAPTION) {
    return null;
  }
  return message;
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
  const response = await fetch(`https://api.telegram.org/file/bot${botToken()}/${filePath}`);
  if (!response.ok) throw new TelegramError(`Telegram file download failed: ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw new Error('Ukuran file Telegram melebihi batas yang didukung.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('Ukuran file Telegram melebihi batas yang didukung.');
  return bytes;
}

async function readCatalog() {
  const message = await getPinnedCatalogMessage();
  if (!message) {
    throw new CatalogNotInitializedError();
  }
  if (message.document.file_size > MAX_SNAPSHOT_BYTES) {
    throw new Error('Snapshot katalog Telegram melebihi batas 18 MiB.');
  }
  const file = await telegramFileInfo(message.document.file_id);
  const bytes = await downloadTelegramFile(file.file_path, MAX_SNAPSHOT_BYTES);
  let catalog;
  try {
    catalog = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Dokumen katalog Telegram bukan JSON yang valid.');
  }
  return validateCatalog(catalog);
}

async function ensureCatalogInitialized() {
  try {
    await readCatalog();
  } catch (error) {
    if (!(error instanceof CatalogNotInitializedError)) throw error;
    try {
      await initializeCatalog(EMPTY_CATALOG);
    } catch (initializeError) {
      if (!(initializeError instanceof StorageAlreadyInitializedError)) throw initializeError;
    }
  }
}

async function writeCatalog(catalog) {
  validateCatalog(catalog);
  const bytes = Buffer.from(JSON.stringify(catalog), 'utf8');
  if (bytes.length > MAX_SNAPSHOT_BYTES) {
    throw new Error('Katalog melebihi batas 18 MiB yang didukung Telegram.');
  }
  const message = await getPinnedCatalogMessage();
  if (!message) {
    throw new Error('Dokumen katalog tidak ditemukan pada pesan yang dipin di chat Telegram.');
  }
  return telegramMultipart('editMessageMedia', {
    chat_id: storageChatId(),
    message_id: String(message.message_id),
    media: {
      type: 'document',
      media: 'attach://snapshot',
      caption: CATALOG_CAPTION
    }
  }, 'snapshot', 'nexamanga-catalog.json', 'application/json', bytes);
}

async function initializeCatalog(catalog) {
  if (await getPinnedCatalogMessage()) {
    throw new StorageAlreadyInitializedError();
  }
  validateCatalog(catalog);
  const bytes = Buffer.from(JSON.stringify(catalog), 'utf8');
  if (bytes.length > MAX_SNAPSHOT_BYTES) {
    throw new Error('Katalog melebihi batas 18 MiB yang didukung Telegram.');
  }
  const message = await telegramMultipart('sendDocument', {
    chat_id: storageChatId(),
    caption: CATALOG_CAPTION
  }, 'document', 'nexamanga-catalog.json', 'application/json', bytes);
  await telegramCall('pinChatMessage', {
    chat_id: storageChatId(),
    message_id: message.message_id,
    disable_notification: true
  });
  return message.message_id;
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
  const document = message.document;
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
  CatalogNotInitializedError,
  MAX_MEDIA_BYTES,
  MAX_SNAPSHOT_BYTES,
  StorageAlreadyInitializedError,
  TelegramError,
  getMedia,
  ensureCatalogInitialized,
  initializeCatalog,
  readCatalog,
  saveMedia,
  writeCatalog
};

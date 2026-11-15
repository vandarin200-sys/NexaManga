'use strict';

const crypto = require('node:crypto');

const EMPTY_CATALOG = Object.freeze({ manga: [], chapters: [], comments: [], users: [] });

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('Penyimpanan katalog Telegram berisi format yang tidak valid.');
  }
  for (const key of ['manga', 'chapters', 'comments']) {
    if (!Array.isArray(catalog[key])) {
      throw new Error(`Penyimpanan katalog Telegram tidak memiliki daftar ${key} yang valid.`);
    }
  }
  if (catalog.users === undefined) catalog.users = [];
  if (!Array.isArray(catalog.users)) {
    throw new Error('Penyimpanan katalog Telegram tidak memiliki daftar users yang valid.');
  }
  return catalog;
}

function registerOAuthUser(catalog, identity) {
  if (!identity || !['discord', 'google'].includes(identity.provider) ||
      typeof identity.providerId !== 'string' || !identity.providerId ||
      typeof identity.name !== 'string' || !identity.name.trim()) {
    throw new ValidationError('Identitas OAuth tidak valid.');
  }
  const existing = catalog.users.find((user) =>
    user.provider === identity.provider && user.providerId === identity.providerId
  );
  if (existing) return existing;

  const hasAdmin = catalog.users.some((existingUser) => existingUser.role === 'admin');
  const user = {
    id: `usr-${crypto.randomUUID()}`,
    provider: identity.provider,
    providerId: identity.providerId,
    name: identity.name.trim().slice(0, 100),
    email: typeof identity.email === 'string' ? identity.email.slice(0, 254) : null,
    avatar: typeof identity.avatar === 'string' ? identity.avatar.slice(0, 2048) : null,
    role: (!hasAdmin || catalog.users.length === 0) ? 'admin' : 'member',
    createdAt: new Date().toISOString()
  };
  catalog.users.push(user);
  return user;
}

function claimAdminRole(catalog, userId) {
  if (typeof userId !== 'string' || !userId) {
    throw new ValidationError('ID pengguna tidak valid.');
  }
  const user = catalog.users.find((item) => item.id === userId);
  if (!user) throw new ValidationError('Pengguna tidak ditemukan.');
  const hasAdmin = catalog.users.some((item) => item.role === 'admin');
  const firstUser = catalog.users.reduce((oldest, item) => {
    if (!oldest) return item;
    const a = typeof oldest.createdAt === 'string' ? oldest.createdAt : '';
    const b = typeof item.createdAt === 'string' ? item.createdAt : '';
    return b && (!a || b < a) ? item : oldest;
  }, null);
  const isFirstUser = !!firstUser && firstUser.id === user.id;
  if (hasAdmin && !isFirstUser) {
    return { promoted: false, user };
  }
  user.role = 'admin';
  return { promoted: true, user };
}

function requireText(value, label, maxLength, minLength = 1) {
  if (typeof value !== 'string' || value.trim().length < minLength || value.length > maxLength) {
    throw new ValidationError(`${label} harus berisi ${minLength}-${maxLength} karakter.`);
  }
  return value.trim();
}

function saveManga(catalog, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data manga tidak valid.');
  }
  const item = { ...input };
  item.id = requireText(item.id, 'ID manga', 100);
  item.slug = requireText(item.slug, 'Slug manga', 120);
  item.title = requireText(item.title, 'Judul manga', 200, 2);
  item.synopsis = requireText(item.synopsis, 'Sinopsis manga', 10000, 10);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug)) {
    throw new ValidationError('Slug hanya boleh berisi huruf kecil, angka, dan tanda hubung.');
  }
  if (!Array.isArray(item.genres) || item.genres.some((genre) => typeof genre !== 'string' || genre.length > 60)) {
    throw new ValidationError('Genre manga tidak valid.');
  }
  if (item.rating !== undefined && (!Number.isFinite(Number(item.rating)) || Number(item.rating) < 0 || Number(item.rating) > 5)) {
    throw new ValidationError('Rating manga harus berada di antara 0 dan 5.');
  }
  if (catalog.manga.some((manga) => manga.slug === item.slug && manga.id !== item.id)) {
    throw new ValidationError('Slug sudah digunakan oleh manga lain.');
  }

  const index = catalog.manga.findIndex((manga) => manga.id === item.id);
  if (index === -1) catalog.manga.push(item);
  else catalog.manga[index] = item;
}

function saveChapter(catalog, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data chapter tidak valid.');
  }
  const item = { ...input };
  item.id = requireText(item.id, 'ID chapter', 100);
  item.mangaId = requireText(item.mangaId, 'ID manga', 100);
  item.number = Number(item.number);
  if (!Number.isInteger(item.number) || item.number < 1) {
    throw new ValidationError('Nomor chapter harus berupa bilangan bulat positif.');
  }
  if (!catalog.manga.some((manga) => manga.id === item.mangaId)) {
    throw new ValidationError('Manga untuk chapter ini tidak ditemukan.');
  }
  if (!Array.isArray(item.pages)) throw new ValidationError('Daftar halaman chapter tidak valid.');
  if (item.pages.some((page) => !page || typeof page !== 'object' || typeof page.telegramFileId !== 'string')) {
    throw new ValidationError('Data halaman chapter tidak valid.');
  }
  if (catalog.chapters.some((chapter) =>
    chapter.mangaId === item.mangaId && Number(chapter.number) === item.number && chapter.id !== item.id
  )) {
    throw new ValidationError('Nomor chapter tersebut sudah digunakan dalam manga ini.');
  }

  const index = catalog.chapters.findIndex((chapter) => chapter.id === item.id);
  if (index === -1) catalog.chapters.push(item);
  else catalog.chapters[index] = item;
}

function deleteManga(catalog, id) {
  catalog.manga = catalog.manga.filter((manga) => manga.id !== id);
  catalog.chapters = catalog.chapters.filter((chapter) => chapter.mangaId !== id);
  catalog.comments = catalog.comments.filter((comment) => comment.mangaId !== id);
}

function deleteChapter(catalog, id) {
  catalog.chapters = catalog.chapters.filter((chapter) => chapter.id !== id);
}

function deleteComment(catalog, id) {
  catalog.comments = catalog.comments.filter((comment) => comment.id !== id);
}

function addComment(catalog, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data komentar tidak valid.');
  }
  const mangaId = requireText(input.mangaId, 'ID manga', 100);
  if (!catalog.manga.some((manga) => manga.id === mangaId)) {
    throw new ValidationError('Manga tidak ditemukan.');
  }
  const comment = {
    id: `c-${crypto.randomUUID()}`,
    mangaId,
    userId: typeof input.userId === 'string' && input.userId ? input.userId : null,
    authorName: requireText(input.authorName, 'Nama', 80),
    authorAvatar: typeof input.authorAvatar === 'string' ? input.authorAvatar.slice(0, 2048) : null,
    content: requireText(input.content, 'Komentar', 2000, 2),
    createdAt: new Date().toISOString().slice(0, 10),
    status: 'pending'
  };
  catalog.comments.unshift(comment);
  return comment;
}

module.exports = {
  EMPTY_CATALOG,
  ValidationError,
  addComment,
  deleteChapter,
  deleteComment,
  deleteManga,
  claimAdminRole,
  registerOAuthUser,
  saveChapter,
  saveManga,
  validateCatalog
};

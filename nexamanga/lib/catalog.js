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
    throw new Error('Penyimpanan katalog berisi format yang tidak valid.');
  }
  for (const key of ['manga', 'chapters', 'comments']) {
    if (!Array.isArray(catalog[key])) {
      throw new Error(`Penyimpanan katalog tidak memiliki daftar ${key} yang valid.`);
    }
  }
  if (catalog.users === undefined) catalog.users = [];
  if (!Array.isArray(catalog.users)) {
    throw new Error('Penyimpanan katalog tidak memiliki daftar users yang valid.');
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
  if (item.rating !== undefined && (!Number.isFinite(Number(item.rating)) || Number(item.rating) < 0 || Number(item.rating) > 10)) {
    throw new ValidationError('Rating manga harus berada di antara 0 dan 10.');
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
  if (!Number.isFinite(item.number) || item.number <= 0) {
    throw new ValidationError('Nomor chapter harus berupa angka positif.');
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
  const manga = catalog.manga.find((entry) => entry.id === item.mangaId);
  if (manga) manga.updatedAt = new Date().toISOString().slice(0, 10);
}

function pinComment(catalog, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data sematan komentar tidak valid.');
  }
  const id = requireText(input.id, 'ID komentar', 100);
  const comment = catalog.comments.find((item) => item.id === id);
  if (!comment) throw new ValidationError('Komentar tidak ditemukan.');
  comment.pinned = !comment.pinned;
  return comment;
}

function deleteManga(catalog, id) {
  catalog.manga = catalog.manga.filter((manga) => manga.id !== id);
  const chapterIds = catalog.chapters.filter((chapter) => chapter.mangaId === id).map((chapter) => chapter.id);
  catalog.chapters = catalog.chapters.filter((chapter) => chapter.mangaId !== id);
  catalog.comments = catalog.comments.filter((comment) => comment.mangaId !== id);
  if (catalog.reactions && typeof catalog.reactions === 'object' && !Array.isArray(catalog.reactions)) {
    for (const chapterId of chapterIds) delete catalog.reactions[chapterId];
  }
  if (catalog.mangaReactions && typeof catalog.mangaReactions === 'object' && !Array.isArray(catalog.mangaReactions)) {
    delete catalog.mangaReactions[id];
  }
}

function deleteChapter(catalog, id) {
  if (!id) return;
  for (const comment of catalog.comments) {
    if (comment && comment.chapterId === id) comment.chapterId = null;
  }
  catalog.chapters = catalog.chapters.filter((chapter) => chapter.id !== id);
  if (catalog.reactions && typeof catalog.reactions === 'object' && !Array.isArray(catalog.reactions)) {
    delete catalog.reactions[id];
  }
}

function deleteComment(catalog, id) {
  catalog.comments = catalog.comments.filter((comment) => comment.id !== id);
}

function enrichCommentsWithUsers(catalog) {
  if (!catalog || !Array.isArray(catalog.comments)) return catalog;
  const users = Array.isArray(catalog.users) ? catalog.users : [];
  const byId = new Map(users.map((user) => [user.id, user]));
  for (const comment of catalog.comments) {
    if (!comment || !comment.userId) continue;
    const user = byId.get(comment.userId);
    if (!user) continue;
    if (user.name) comment.authorName = user.name;
    if (user.avatar) comment.authorAvatar = user.avatar;
  }
  return catalog;
}

const REACTION_KEYS = Object.freeze(['fire', 'shock', 'cry', 'laugh', 'angry']);

function addChapterReaction(catalog, input) {
  return addReaction(catalog, input, 'chapter');
}

function addMangaReaction(catalog, input) {
  return addReaction(catalog, input, 'manga');
}

function addReaction(catalog, input, targetType = 'chapter') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data reaksi tidak valid.');
  }
  const targetId = requireText(
    targetType === 'chapter' ? input.chapterId : input.mangaId,
    targetType === 'chapter' ? 'ID chapter' : 'ID manga',
    100
  );
  const voterId = requireText(input.voterId, 'ID voter', 100);
  const reaction = typeof input.reaction === 'string' && input.reaction ? input.reaction : null;
  const collectionKey = targetType === 'chapter' ? 'reactions' : 'mangaReactions';
  const exists = targetType === 'chapter'
    ? catalog.chapters.some((chapter) => chapter.id === targetId)
    : catalog.manga.some((manga) => manga.id === targetId);
  if (!exists) {
    throw new ValidationError(targetType === 'chapter' ? 'Chapter tidak ditemukan.' : 'Manga tidak ditemukan.');
  }
  if (!catalog[collectionKey] || typeof catalog[collectionKey] !== 'object' || Array.isArray(catalog[collectionKey])) {
    catalog[collectionKey] = {};
  }
  const forTarget = catalog[collectionKey][targetId] && typeof catalog[collectionKey][targetId] === 'object'
    ? catalog[collectionKey][targetId]
    : {};
  for (const key of REACTION_KEYS) {
    if (!Array.isArray(forTarget[key])) forTarget[key] = [];
  }
  let userVote = null;
  if (reaction) {
    if (!REACTION_KEYS.includes(reaction)) throw new ValidationError('Reaksi tidak valid.');
    const current = forTarget[reaction].indexOf(voterId);
    if (current !== -1) {
      forTarget[reaction].splice(current, 1);
      userVote = null;
    } else {
      for (const key of REACTION_KEYS) {
        const idx = forTarget[key].indexOf(voterId);
        if (idx !== -1) forTarget[key].splice(idx, 1);
      }
      forTarget[reaction].push(voterId);
      userVote = reaction;
    }
  } else {
    for (const key of REACTION_KEYS) {
      if (forTarget[key].includes(voterId)) userVote = key;
    }
  }
  catalog[collectionKey][targetId] = forTarget;
  const counts = {};
  for (const key of REACTION_KEYS) counts[key] = forTarget[key].length;
  return { counts, userVote };
}

function incrementMangaViews(catalog, id) {
  const manga = catalog.manga.find((item) => item.id === id || item.slug === id);
  if (!manga) throw new ValidationError('Manga tidak ditemukan.');
  manga.views = (Number(manga.views) || 0) + 1;
  return manga;
}

function saveSettings(catalog, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data pengaturan tidak valid.');
  }
  const settings = Object.assign({}, catalog.settings || {});
  const stringFields = ['siteName', 'siteTagline', 'logoUrl', 'contactEmail', 'brandMode', 'siteNameColor', 'aboutContent', 'contactContent', 'privacyContent', 'termsContent'];
  for (const field of stringFields) {
    const value = input[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (field === 'siteName' && trimmed.length > 100) throw new ValidationError('Nama situs maksimal 100 karakter.');
    if (field === 'siteTagline' && trimmed.length > 250) throw new ValidationError('Tagline maksimal 250 karakter.');
    if (field === 'logoUrl' && trimmed.length > 2048) throw new ValidationError('URL logo terlalu panjang.');
    if (field === 'logoUrl' && trimmed && !/^https?:\/\//i.test(trimmed)) throw new ValidationError('URL logo harus menggunakan HTTP atau HTTPS.');
    if (field === 'contactEmail' && trimmed.length > 254) throw new ValidationError('Email kontak terlalu panjang.');
    if (['aboutContent', 'contactContent', 'privacyContent', 'termsContent'].includes(field) && trimmed.length > 20000) {
      throw new ValidationError('Konten halaman terlalu panjang (maks 20.000 karakter).');
    }
    if (field === 'contactEmail' && trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      throw new ValidationError('Format email kontak tidak valid.');
    }
    if (field === 'brandMode' && trimmed && !['logo-name', 'logo-only', 'name-only'].includes(trimmed)) {
      throw new ValidationError('Mode tampilan brand tidak valid.');
    }
    if (field === 'siteNameColor' && trimmed && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
      throw new ValidationError('Warna nama situs harus format hex, misalnya #6366f1.');
    }
    settings[field] = trimmed;
  }
  catalog.settings = settings;
  return settings;
}

function addComment(catalog, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data komentar tidak valid.');
  }
  const mangaId = requireText(input.mangaId, 'ID manga', 100);
  if (!catalog.manga.some((manga) => manga.id === mangaId)) {
    throw new ValidationError('Manga tidak ditemukan.');
  }
  const parentIdInput = typeof input.parentId === 'string' && input.parentId ? input.parentId : null;
  let parent = null;
  if (parentIdInput) {
    parent = catalog.comments.find((item) => item.id === parentIdInput && item.mangaId === mangaId) || null;
    if (!parent) throw new ValidationError('Komentar induk tidak ditemukan.');
  }
  let chapterId = typeof input.chapterId === 'string' && input.chapterId ? input.chapterId : null;
  if (chapterId) {
    const chapter = catalog.chapters.find((item) => item.id === chapterId);
    if (!chapter) throw new ValidationError('Chapter tidak ditemukan.');
    if (chapter.mangaId !== mangaId) throw new ValidationError('Chapter bukan bagian dari manga ini.');
    if (parent && (parent.chapterId || null) !== chapterId) {
      throw new ValidationError('Balasan harus berada di chapter yang sama dengan komentar induk.');
    }
  } else if (parent && typeof parent.chapterId === 'string' && parent.chapterId) {
    chapterId = parent.chapterId;
  }
  const parentId = parentIdInput;
  const imageUrl = typeof input.imageUrl === 'string' && input.imageUrl.trim() ? input.imageUrl.trim().slice(0, 2048) : null;
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    throw new ValidationError('URL gambar komentar harus menggunakan HTTP atau HTTPS.');
  }
  const replyTo = typeof input.replyTo === 'string' && input.replyTo.trim() ? input.replyTo.trim().slice(0, 100) : null;
  const comment = {
    id: `c-${crypto.randomUUID()}`,
    mangaId,
    chapterId,
    parentId,
    replyTo,
    imageUrl,
    userId: typeof input.userId === 'string' && input.userId ? input.userId : null,
    authorName: requireText(input.authorName, 'Nama', 80),
    authorAvatar: typeof input.authorAvatar === 'string' ? input.authorAvatar.slice(0, 2048) : null,
    content: requireText(input.content, 'Komentar', 2000, 2),
    createdAt: new Date().toISOString().slice(0, 10),
    status: 'approved',
    upvotes: []
  };
  catalog.comments.unshift(comment);
  return comment;
}

function upvoteComment(catalog, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data upvote tidak valid.');
  }
  const id = requireText(input.id, 'ID komentar', 100);
  const voterId = requireText(input.voterId, 'ID voter', 100);
  const comment = catalog.comments.find((item) => item.id === id);
  if (!comment) throw new ValidationError('Komentar tidak ditemukan.');
  if (!Array.isArray(comment.upvotes)) comment.upvotes = [];
  const index = comment.upvotes.indexOf(voterId);
  if (index === -1) comment.upvotes.push(voterId);
  else comment.upvotes.splice(index, 1);
  return comment;
}
module.exports = {
  EMPTY_CATALOG,
  ValidationError,
  addComment,
  addChapterReaction,
  addMangaReaction,
  deleteChapter,
  deleteComment,
  deleteManga,
  pinComment,
  enrichCommentsWithUsers,
  incrementMangaViews,
  claimAdminRole,
  registerOAuthUser,
  saveChapter,
  saveManga,
  saveSettings,
  upvoteComment,
  validateCatalog
};

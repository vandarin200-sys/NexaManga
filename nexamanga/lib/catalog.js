'use strict';

const crypto = require('node:crypto');
const { uniquePublicSlug } = require('./progress');

const EMPTY_CATALOG = Object.freeze({ manga: [], chapters: [], comments: [], reports: [], users: [] });

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
  if (catalog.reports === undefined) catalog.reports = [];
  if (!Array.isArray(catalog.reports)) {
    throw new Error('Penyimpanan katalog tidak memiliki daftar reports yang valid.');
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
  const id = `usr-${crypto.randomUUID()}`;
  const usedSlugs = new Set(catalog.users.map((item) => item.publicSlug).filter(Boolean));
  const user = {
    id,
    publicSlug: uniquePublicSlug(id, usedSlugs),
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

function requireText(value, label, maxLength, minLength = 1) {
  if (typeof value !== 'string' || value.trim().length < minLength || value.length > maxLength) {
    throw new ValidationError(`${label} harus berisi ${minLength}-${maxLength} karakter.`);
  }
  return value.trim();
}

const EMAIL_VERIFICATION_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFICATION_ATTEMPTS = 5;
const CONNECTION_PROVIDERS = Object.freeze(['anilist', 'mal']);

function findCatalogUser(catalog, userId) {
  if (typeof userId !== 'string' || !userId) throw new ValidationError('ID akun tidak valid.');
  const user = (catalog.users || []).find((item) => item.id === userId);
  if (!user) throw new ValidationError('Pengguna tidak ditemukan.');
  return user;
}

function validateEmailAddress(value) {
  if (typeof value !== 'string') throw new ValidationError('Format email tidak valid.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.includes('..')) {
    throw new ValidationError('Format email tidak valid.');
  }
  return email;
}

function validatePasswordValue(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new ValidationError('Kata sandi harus berisi 8-128 karakter.');
  }
  return value;
}

function hashCredential(value) {
  const salt = crypto.randomBytes(16);
  return {
    hash: crypto.scryptSync(String(value), salt, 64).toString('hex'),
    salt: salt.toString('hex')
  };
}

function verifyCredential(value, hash, salt) {
  if (typeof value !== 'string' || value.length > 1024 ||
      typeof hash !== 'string' || !/^[0-9a-f]{128}$/i.test(hash) ||
      typeof salt !== 'string' || !/^[0-9a-f]{32}$/i.test(salt)) {
    return false;
  }
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(value, Buffer.from(salt, 'hex'), 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function createEmailVerificationCode(now = Date.now()) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const secret = hashCredential(code);
  return {
    code,
    hash: secret.hash,
    salt: secret.salt,
    expiresAt: new Date(now + EMAIL_VERIFICATION_TTL_MS).toISOString(),
    attempts: 0
  };
}

function assertCredentialsAvailable(catalog, userId, email) {
  const user = findCatalogUser(catalog, userId);
  if (user.passwordHash) throw new ValidationError('Akun ini sudah memiliki kata sandi.');
  const normalized = validateEmailAddress(email);
  if ((catalog.users || []).some((item) =>
    item.id !== userId && typeof item.email === 'string' && item.email.toLowerCase() === normalized)) {
    throw new ValidationError('Email sudah digunakan oleh akun lain.');
  }
  return user;
}

function safeUser(user) {
  if (!user) return null;
  const connections = user.connections && typeof user.connections === 'object' && !Array.isArray(user.connections)
    ? user.connections
    : {};
  const summary = (provider) => {
    const item = connections[provider];
    return {
      connected: Boolean(item && (item.connected === true || typeof item.accessToken === 'string')),
      username: item && typeof item.username === 'string' ? item.username : null
    };
  };
  return {
    id: user.id,
    publicSlug: user.publicSlug || null,
    name: user.name,
    email: user.email || null,
    avatar: user.avatar || null,
    bannerUrl: user.profileBannerUrl || null,
    provider: user.provider || null,
    role: user.role || 'member',
    emailVerified: !!user.emailVerified,
    hasPassword: !!user.passwordHash,
    connections: { anilist: summary('anilist'), mal: summary('mal') }
  };
}

function setProfileBanner(catalog, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data banner tidak valid.');
  }
  const user = findCatalogUser(catalog, input.userId);
  let bannerUrl = null;
  if (input.bannerUrl !== null && input.bannerUrl !== undefined) {
    if (typeof input.bannerUrl !== 'string' || input.bannerUrl.length > 2048) {
      throw new ValidationError('URL banner tidak valid.');
    }
    bannerUrl = input.bannerUrl.trim();
    if (bannerUrl && !/^(?:https?:\/\/[^\s'"()\\]+|\/api\/media\/[A-Za-z0-9_=-]+)$/.test(bannerUrl)) {
      throw new ValidationError('URL banner tidak valid.');
    }
    if (!bannerUrl) bannerUrl = null;
  }
  user.profileBannerUrl = bannerUrl;
  return safeUser(user);
}

function setAccountCredentials(catalog, input) {
  const user = assertCredentialsAvailable(catalog, input.userId, input.email);
  if (typeof input.passwordHash !== 'string' || typeof input.passwordSalt !== 'string' ||
      !input.verification || typeof input.verification.hash !== 'string' ||
      typeof input.verification.salt !== 'string' || typeof input.verification.expiresAt !== 'string') {
    throw new ValidationError('Data kredensial tidak valid.');
  }
  user.email = validateEmailAddress(input.email);
  user.emailVerified = false;
  user.passwordHash = input.passwordHash;
  user.passwordSalt = input.passwordSalt;
  user.emailVerification = {
    hash: input.verification.hash,
    salt: input.verification.salt,
    expiresAt: input.verification.expiresAt,
    attempts: 0
  };
  return safeUser(user);
}

function assertEmailVerificationPending(catalog, userId) {
  const user = findCatalogUser(catalog, userId);
  if (!user.email) throw new ValidationError('Email belum tersedia pada akun ini.');
  if (user.emailVerified) throw new ValidationError('Email sudah terverifikasi.');
  return user;
}

function resendEmailVerification(catalog, input) {
  const user = assertEmailVerificationPending(catalog, input.userId);
  if (!input.verification || typeof input.verification.hash !== 'string' ||
      typeof input.verification.salt !== 'string' || typeof input.verification.expiresAt !== 'string') {
    throw new ValidationError('Data verifikasi tidak valid.');
  }
  user.emailVerification = {
    hash: input.verification.hash,
    salt: input.verification.salt,
    expiresAt: input.verification.expiresAt,
    attempts: 0
  };
  return safeUser(user);
}

function verifyEmailVerification(catalog, input) {
  const user = findCatalogUser(catalog, input.userId);
  const pending = user.emailVerification;
  if (!pending || !user.email) {
    delete user.emailVerification;
    return { ok: false, error: 'Kode verifikasi tidak ditemukan. Silakan kirim ulang.' };
  }
  const attempts = Number.isInteger(pending.attempts) ? pending.attempts : 0;
  if (attempts >= MAX_VERIFICATION_ATTEMPTS) {
    delete user.emailVerification;
    return { ok: false, error: 'Terlalu banyak percobaan. Silakan kirim ulang kode verifikasi.' };
  }
  const expiresAt = Date.parse(pending.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    delete user.emailVerification;
    return { ok: false, error: 'Kode verifikasi sudah berakhir. Silakan kirim ulang.' };
  }
  if (!verifyCredential(input.code, pending.hash, pending.salt)) {
    const next = attempts + 1;
    if (next >= MAX_VERIFICATION_ATTEMPTS) {
      delete user.emailVerification;
      return { ok: false, error: 'Kode verifikasi tidak valid. Silakan kirim ulang kode verifikasi.' };
    }
    user.emailVerification = { ...pending, attempts: next };
    return { ok: false, error: `Kode verifikasi tidak valid. Sisa ${MAX_VERIFICATION_ATTEMPTS - next} percobaan.` };
  }
  user.emailVerified = true;
  delete user.emailVerification;
  return { ok: true, user: safeUser(user) };
}

function changeAccountPassword(catalog, input) {
  const user = findCatalogUser(catalog, input.userId);
  if (!user.passwordHash) {
    throw new ValidationError('Akun belum memiliki kata sandi. Tambahkan kredensial terlebih dahulu.');
  }
  if (!verifyCredential(input.oldPassword, user.passwordHash, user.passwordSalt)) {
    throw new ValidationError('Kata sandi lama tidak benar.');
  }
  const password = validatePasswordValue(input.newPassword);
  const secret = hashCredential(password);
  user.passwordHash = secret.hash;
  user.passwordSalt = secret.salt;
  return safeUser(user);
}

function deleteAccount(catalog, input) {
  const user = findCatalogUser(catalog, input.userId);
  if (user.role === 'admin') {
    const adminCount = (catalog.users || []).filter((item) => item.role === 'admin').length;
    if (adminCount <= 1) throw new ValidationError('Tidak dapat menghapus admin terakhir.');
  }
  catalog.users = (catalog.users || []).filter((item) => item.id !== user.id);
  catalog.comments = (catalog.comments || []).filter((comment) => comment.userId !== user.id);
  catalog.reports = (catalog.reports || []).filter((report) => report.userId !== user.id);
  for (const comment of catalog.comments) {
    if (Array.isArray(comment.upvotes)) {
      comment.upvotes = comment.upvotes.filter((voterId) => voterId !== user.id);
    }
  }
  for (const key of ['reactions', 'mangaReactions']) {
    const collection = catalog[key];
    if (!collection || typeof collection !== 'object' || Array.isArray(collection)) continue;
    for (const groups of Object.values(collection)) {
      if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
      for (const [reaction, voters] of Object.entries(groups)) {
        if (Array.isArray(voters)) groups[reaction] = voters.filter((voterId) => voterId !== user.id);
      }
    }
  }
  return { id: user.id };
}

function validateConnectionProvider(value) {
  if (!CONNECTION_PROVIDERS.includes(value)) {
    throw new ValidationError('Penyedia koneksi tidak valid.');
  }
  return value;
}

function linkTrackerConnection(catalog, input) {
  const provider = validateConnectionProvider(input.provider);
  const user = findCatalogUser(catalog, input.userId);
  const profile = input.profile;
  if (!profile || typeof profile.providerId !== 'string' || !profile.providerId ||
      typeof profile.username !== 'string' || !profile.username.trim() ||
      typeof profile.accessToken !== 'string' || !profile.accessToken) {
    throw new ValidationError('Profil koneksi tidak valid.');
  }
  if (!user.connections || typeof user.connections !== 'object' || Array.isArray(user.connections)) {
    user.connections = {};
  }
  user.connections[provider] = {
    connected: true,
    providerId: profile.providerId.slice(0, 200),
    username: profile.username.trim().slice(0, 200),
    accessToken: profile.accessToken,
    updatedAt: new Date().toISOString()
  };
  return safeUser(user);
}

function syncTrackerConnection(catalog, input) {
  const provider = validateConnectionProvider(input.provider);
  const user = findCatalogUser(catalog, input.userId);
  const connection = user.connections && typeof user.connections === 'object' && !Array.isArray(user.connections)
    ? user.connections[provider]
    : null;
  if (!connection || typeof connection.accessToken !== 'string' || !connection.accessToken) {
    throw new ValidationError(`Koneksi ${provider} belum terhubung.`);
  }
  if (typeof input.username !== 'string' || !input.username.trim()) {
    throw new ValidationError('Nama pengguna koneksi tidak valid.');
  }
  const syncedAt = new Date().toISOString();
  connection.username = input.username.trim().slice(0, 200);
  connection.lastSyncedAt = syncedAt;
  return { provider, username: connection.username, syncedAt };
}

function unlinkTrackerConnection(catalog, input) {
  const provider = validateConnectionProvider(input.provider);
  const user = findCatalogUser(catalog, input.userId);
  if (user.connections && typeof user.connections === 'object' && !Array.isArray(user.connections)) {
    delete user.connections[provider];
  }
  return safeUser(user);
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
  if (item.isAdult !== undefined && typeof item.isAdult !== 'boolean' &&
      !['on', 'off', 'true', 'false', '1', '0', ''].includes(String(item.isAdult).toLowerCase())) {
    throw new ValidationError('Penanda manga 18+ tidak valid.');
  }
  const adultGenre = item.genres.some((genre) => ['18+', 'hentai', 'ecchi'].includes(String(genre).toLowerCase()));
  const adultFlag = item.isAdult === true || ['on', 'true', '1'].includes(String(item.isAdult).toLowerCase());
  item.isAdult = adultGenre || adultFlag;
  if (item.releaseYear !== undefined && item.releaseYear !== null && item.releaseYear !== '') {
    const releaseYear = Number(item.releaseYear);
    if (!Number.isInteger(releaseYear) || releaseYear < 1900 || releaseYear > 2100) {
      throw new ValidationError('Tahun rilis manga harus berupa tahun antara 1900 dan 2100.');
    }
    item.releaseYear = releaseYear;
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
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const comment of catalog.comments) {
      if (comment && comment.parentId && ids.has(comment.parentId) && !ids.has(comment.id)) {
        ids.add(comment.id);
        changed = true;
      }
    }
  }
  catalog.comments = catalog.comments.filter((comment) => !ids.has(comment.id));
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
  const stringFields = ['siteName', 'siteTagline', 'logoUrl', 'faviconUrl', 'contactEmail', 'discordUrl', 'brandMode', 'siteNameColor', 'aboutContent', 'contactContent', 'privacyContent', 'termsContent', 'storageProvider'];
  for (const field of stringFields) {
    const value = input[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (field === 'siteName' && trimmed.length > 100) throw new ValidationError('Nama situs maksimal 100 karakter.');
    if (field === 'siteTagline' && trimmed.length > 250) throw new ValidationError('Tagline maksimal 250 karakter.');
    if (field === 'logoUrl' && trimmed.length > 2048) throw new ValidationError('URL logo terlalu panjang.');
    if (field === 'logoUrl' && trimmed && !/^https?:\/\//i.test(trimmed)) throw new ValidationError('URL logo harus menggunakan HTTP atau HTTPS.');
    if (field === 'faviconUrl' && trimmed.length > 2048) throw new ValidationError('URL favicon terlalu panjang.');
    if (field === 'faviconUrl' && trimmed && !/^https?:\/\//i.test(trimmed)) throw new ValidationError('URL favicon harus menggunakan HTTP atau HTTPS.');
    if (field === 'discordUrl' && trimmed.length > 2048) throw new ValidationError('URL Discord terlalu panjang.');
    if (field === 'discordUrl' && trimmed && !/^https?:\/\//i.test(trimmed)) throw new ValidationError('URL Discord harus menggunakan HTTP atau HTTPS.');
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
    if (field === 'storageProvider' && trimmed && !['telegram', 'r2'].includes(trimmed)) {
      throw new ValidationError('Penyimpanan gambar tidak valid.');
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
  const userId = typeof input.userId === 'string' && input.userId ? input.userId : null;
  const comment = {
    id: `c-${crypto.randomUUID()}`,
    mangaId,
    chapterId,
    parentId,
    replyTo,
    imageUrl,
    userId,
    authorKey: userId ? null : (typeof input.authorKey === 'string' && input.authorKey ? input.authorKey.slice(0, 100) : null),
    authorName: userId ? requireText(input.authorName, 'Nama', 80) : 'Pengunjung',
    authorAvatar: userId && typeof input.authorAvatar === 'string' ? input.authorAvatar.slice(0, 2048) : null,
    content: requireText(input.content, 'Komentar', 2000, 2),
    createdAt: new Date().toISOString().slice(0, 10),
    status: 'pending',
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

const REPORT_REASONS = Object.freeze([
  'gambar-rusak',
  'chapter-salah',
  'konten-tidak-sesuai',
  'tautan-tidak-berfungsi',
  'lainnya'
]);

function addReport(catalog, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data laporan tidak valid.');
  }
  const mangaId = requireText(input.mangaId, 'ID manga', 100);
  const chapterId = requireText(input.chapterId, 'ID chapter', 100);
  const manga = catalog.manga.find((item) => item.id === mangaId);
  if (!manga) throw new ValidationError('Manga tidak ditemukan.');
  const chapter = catalog.chapters.find((item) => item.id === chapterId);
  if (!chapter || chapter.mangaId !== mangaId) throw new ValidationError('Chapter tidak ditemukan.');
  const reason = requireText(input.reason, 'Alasan laporan', 40);
  if (!REPORT_REASONS.includes(reason)) throw new ValidationError('Alasan laporan tidak dikenali.');
  const detail = typeof input.detail === 'string' && input.detail.trim()
    ? input.detail.trim().slice(0, 500)
    : '';
  const userId = typeof input.userId === 'string' && input.userId ? input.userId : null;
  const report = {
    id: `r-${crypto.randomUUID()}`,
    mangaId,
    chapterId,
    mangaTitle: String(manga.title || '').slice(0, 200),
    chapterNumber: String(chapter.number || '').slice(0, 40),
    reason,
    detail,
    userId,
    reporterKey: userId ? null : (typeof input.reporterKey === 'string' && input.reporterKey ? input.reporterKey.slice(0, 100) : null),
    createdAt: new Date().toISOString(),
    status: 'open'
  };
  catalog.reports.unshift(report);
  return report;
}

function setReportStatus(catalog, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data laporan tidak valid.');
  }
  const id = requireText(input.id, 'ID laporan', 100);
  const status = requireText(input.status, 'Status laporan', 20);
  if (!['open', 'resolved', 'dismissed'].includes(status)) {
    throw new ValidationError('Status laporan tidak dikenali.');
  }
  const report = catalog.reports.find((item) => item.id === id);
  if (!report) throw new ValidationError('Laporan tidak ditemukan.');
  report.status = status;
  return report;
}

function deleteReport(catalog, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Data laporan tidak valid.');
  }
  const id = requireText(input.id, 'ID laporan', 100);
  const index = catalog.reports.findIndex((item) => item.id === id);
  if (index === -1) throw new ValidationError('Laporan tidak ditemukan.');
  catalog.reports.splice(index, 1);
  return { id };
}

module.exports = {
  EMPTY_CATALOG,
  ValidationError,
  CONNECTION_PROVIDERS,
  addComment,
  addChapterReaction,
  addMangaReaction,
  addReport,
  REACTION_KEYS,
  REPORT_REASONS,
  assertCredentialsAvailable,
  assertEmailVerificationPending,
  changeAccountPassword,
  createEmailVerificationCode,
  deleteAccount,
  deleteChapter,
  deleteComment,
  deleteManga,
  deleteReport,
  enrichCommentsWithUsers,
  hashCredential,
  incrementMangaViews,
  linkTrackerConnection,
  pinComment,
  registerOAuthUser,
  resendEmailVerification,
  safeUser,
  saveChapter,
  saveManga,
  saveSettings,
  setAccountCredentials,
  setProfileBanner,
  setReportStatus,
  syncTrackerConnection,
  unlinkTrackerConnection,
  upvoteComment,
  validateCatalog,
  validateEmailAddress,
  validatePasswordValue,
  verifyCredential,
  verifyEmailVerification
};

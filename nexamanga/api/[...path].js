'use strict';

const {
  createOAuthState,
  createSessionToken,
  verifyOAuthState,
  verifySessionToken
} = require('../lib/auth');
const {
  EMPTY_CATALOG,
  ValidationError,
  addComment,
  claimAdminRole,
  deleteChapter,
  deleteComment,
  deleteManga,
  registerOAuthUser,
  saveChapter,
  saveManga
} = require('../lib/catalog');
const {
  MAX_MEDIA_BYTES,
  CatalogNotInitializedError,
  StorageAlreadyInitializedError,
  TelegramError,
  ensureCatalogInitialized,
  getMedia,
  initializeCatalog,
  readCatalog,
  saveMedia,
  writeCatalog
} = require('../lib/telegram');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

function parseAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, ''))
    .filter(Boolean);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = parseAllowedOrigins();
  const wildcard = (process.env.ALLOWED_ORIGINS || '*').includes('*');

  if (wildcard) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowed.includes(origin.replace(/\/+$/, ''))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function readBody(req, maxBytes = 4.5 * 1024 * 1024) {
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length > maxBytes) throw new HttpError(413, 'Ukuran request terlalu besar.');
      try {
        return JSON.parse(req.body.toString('utf8'));
      } catch {
        throw new HttpError(400, 'Body harus berupa JSON yang valid.');
      }
    }
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body) > maxBytes) throw new HttpError(413, 'Ukuran request terlalu besar.');
      try {
        return JSON.parse(req.body);
      } catch {
        throw new HttpError(400, 'Body harus berupa JSON yang valid.');
      }
    }
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body;
    throw new HttpError(400, 'Body harus berupa JSON yang valid.');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(413, 'Ukuran request terlalu besar.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body harus berupa JSON yang valid.');
  }
}

function isAdmin(req) {
  const claims = sessionClaims(req);
  return Boolean(claims && claims.role === 'admin');
}

function sessionClaims(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? verifySessionToken(match[1]) : null;
}

function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(401, 'Sesi admin tidak valid atau sudah berakhir. Silakan masuk kembali.');
}

function apiBaseUrl() {
  if (!process.env.PUBLIC_API_URL) throw new Error('Environment variable PUBLIC_API_URL is required.');
  let url;
  try {
    url = new URL(process.env.PUBLIC_API_URL);
  } catch {
    throw new Error('PUBLIC_API_URL harus berupa URL HTTPS yang valid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('PUBLIC_API_URL harus berupa URL HTTPS tanpa kredensial.');
  }
  return url.origin;
}

function allowedReturnOrigin(value) {
  if (typeof value !== 'string') return null;
  let origin;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value) return null;
    origin = url.origin;
  } catch {
    return null;
  }
  const allowed = parseAllowedOrigins()
    .filter((item) => item !== '*')
    .map((item) => {
      try { return new URL(item).origin; } catch { return ''; }
    });
  return allowed.includes(origin) ? origin : null;
}

function oauthCallbackUrl(provider) {
  return `${apiBaseUrl()}/api/auth/${provider}/callback`;
}

function setOAuthCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie',
    `nexa_oauth_state=${value}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=${maxAge}`);
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const item = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : '';
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function oauthCredentials(provider) {
  const prefix = provider === 'google' ? 'GOOGLE' : 'DISCORD';
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    throw new Error(`Environment variables ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET are required.`);
  }
  return { clientId, clientSecret };
}

async function fetchOAuthIdentity(provider, code) {
  const { clientId, clientSecret } = oauthCredentials(provider);
  const redirectUri = oauthCallbackUrl(provider);
  const tokenUrl = provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : 'https://discord.com/api/oauth2/token';
  const tokenResponse = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    })
  });
  const tokenResult = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || !tokenResult || typeof tokenResult.access_token !== 'string') {
    throw new HttpError(401, `Login ${provider} gagal diverifikasi.`);
  }

  const profileUrl = provider === 'google'
    ? 'https://www.googleapis.com/oauth2/v3/userinfo'
    : 'https://discord.com/api/users/@me';
  const profileResponse = await fetch(profileUrl, {
    headers: { Authorization: `Bearer ${tokenResult.access_token}` }
  });
  const profile = await profileResponse.json().catch(() => null);
  if (!profileResponse.ok || !profile) throw new HttpError(401, `Profil ${provider} tidak dapat diverifikasi.`);

  if (provider === 'google') {
    if (typeof profile.sub !== 'string' || typeof profile.name !== 'string') {
      throw new HttpError(401, 'Profil Google tidak lengkap.');
    }
    return {
      provider,
      providerId: profile.sub,
      name: profile.name,
      email: profile.email_verified === true ? profile.email : null,
      avatar: profile.picture || null
    };
  }

  if (typeof profile.id !== 'string') throw new HttpError(401, 'Profil Discord tidak lengkap.');
  const avatar = profile.avatar
    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
    : null;
  return {
    provider,
    providerId: profile.id,
    name: profile.global_name || profile.username || `Discord ${profile.id}`,
    email: profile.verified === true ? profile.email : null,
    avatar
  };
}

async function updateCatalog(change) {
  const current = await readCatalog();
  const draft = structuredClone(current);
  change(draft);
  await writeCatalog(draft);
}

function decodeUpload(dataUrl) {
  if (typeof dataUrl !== 'string') throw new HttpError(400, 'Data gambar tidak valid.');
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new HttpError(400, 'Data gambar harus berupa JPEG, PNG, atau WebP base64.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
    throw new HttpError(413, 'Ukuran gambar harus maksimal 3 MiB.');
  }
  return { mimeType: match[1], bytes };
}

function validatePathId(value) {
  const id = decodeURIComponent(value);
  if (!/^[A-Za-z0-9_=-]{10,512}$/.test(id)) throw new HttpError(400, 'ID media tidak valid.');
  return id;
}

async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const pathname = new URL(req.url, 'http://localhost').pathname;
  const route = pathname
    .replace(/^\/+/, '')
    .replace(/^api\//, '')
    .replace(/\/+$/, '');
  try {
    const oauthRoute = route.match(/^auth\/(google|discord)\/(start|callback)$/);
    if (oauthRoute && req.method === 'GET') {
      const [, provider, action] = oauthRoute;
      const { clientId } = oauthCredentials(provider);
      if (action === 'start') {
        const returnOrigin = allowedReturnOrigin(new URL(req.url, 'http://localhost').searchParams.get('return_to'));
        if (!returnOrigin) throw new HttpError(400, 'Origin Blogger tidak diizinkan untuk login OAuth.');
        const state = createOAuthState(provider, returnOrigin);
        const claims = verifyOAuthState(state);
        setOAuthCookie(res, claims.nonce, 600);
        const authorizeUrl = provider === 'google'
          ? new URL('https://accounts.google.com/o/oauth2/v2/auth')
          : new URL('https://discord.com/oauth2/authorize');
        authorizeUrl.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: oauthCallbackUrl(provider),
          response_type: 'code',
          scope: provider === 'google' ? 'openid email profile' : 'identify email',
          state
        }).toString();
        return redirect(res, authorizeUrl.toString());
      }

      const url = new URL(req.url, 'http://localhost');
      const state = verifyOAuthState(url.searchParams.get('state'));
      const stateCookie = getCookie(req, 'nexa_oauth_state');
      setOAuthCookie(res, '', 0);
      if (!state || state.provider !== provider || !stateCookie ||
          state.nonce !== stateCookie || !allowedReturnOrigin(state.returnOrigin)) {
        throw new HttpError(400, 'Sesi OAuth tidak valid atau sudah berakhir. Silakan coba lagi.');
      }
      if (url.searchParams.has('error') || !url.searchParams.get('code')) {
        throw new HttpError(401, 'Login OAuth dibatalkan atau ditolak oleh penyedia akun.');
      }
      const identity = await fetchOAuthIdentity(provider, url.searchParams.get('code'));
      await ensureCatalogInitialized();
      let user;
      await updateCatalog((catalog) => { user = registerOAuthUser(catalog, identity); });
      const token = createSessionToken(user);
      return redirect(res, `${state.returnOrigin}/?auth_token=${encodeURIComponent(token)}#/akun`);
    }

    if (route === 'auth/me' && req.method === 'GET') {
      const claims = sessionClaims(req);
      if (!claims) throw new HttpError(401, 'Sesi tidak valid atau sudah berakhir. Silakan masuk kembali.');
      return sendJson(res, 200, { user: claims.user, role: claims.role });
    }

    if (route === 'auth/claim-admin' && req.method === 'POST') {
      const claims = sessionClaims(req);
      if (!claims) throw new HttpError(401, 'Sesi tidak valid atau sudah berakhir. Silakan masuk kembali.');
      let promoted = false;
      let updatedUser = null;
      await updateCatalog((catalog) => {
        const result = claimAdminRole(catalog, claims.sub);
        promoted = result.promoted;
        updatedUser = result.user;
      });
      if (!promoted) {
        return sendJson(res, 409, { error: 'Sudah ada admin. Tidak ada perubahan.' });
      }
      const token = createSessionToken(updatedUser);
      return sendJson(res, 200, { ok: true, token, user: updatedUser });
    }

    if (route === 'admin/storage/init' && req.method === 'POST') {
      requireAdmin(req);
      const messageId = await initializeCatalog(EMPTY_CATALOG);
      return sendJson(res, 201, {
        messageId,
        instruction: 'Dokumen katalog sudah dipin di chat Telegram. Tidak perlu menyimpan ID tambahan.'
      });
    }

    if (route === 'catalog' && req.method === 'GET') {
      let catalog;
      try {
        catalog = await readCatalog();
      } catch (error) {
        if (!(error instanceof CatalogNotInitializedError)) throw error;
        catalog = { manga: [], chapters: [], comments: [], users: [] };
      }
      if (!isAdmin(req)) {
        catalog.comments = catalog.comments.filter((comment) => comment.status === 'approved');
      }
      delete catalog.users;
      return sendJson(res, 200, catalog);
    }

    if (route === 'comment' && req.method === 'POST') {
      const body = await readBody(req);
      const claims = sessionClaims(req);
      if (claims) {
        body.userId = claims.sub;
        if (!body.authorName) body.authorName = claims.user && claims.user.name ? claims.user.name : 'Pengguna';
        if (!body.authorAvatar && claims.user && claims.user.avatar) body.authorAvatar = claims.user.avatar;
      }
      let created;
      await updateCatalog((catalog) => { created = addComment(catalog, body); });
      return sendJson(res, 201, { comment: created });
    }

    if (route === 'admin/save-manga' && req.method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      await updateCatalog((catalog) => saveManga(catalog, body));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/save-chapter' && req.method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      await updateCatalog((catalog) => saveChapter(catalog, body));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/delete-manga' && req.method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'ID manga tidak valid.');
      await updateCatalog((catalog) => deleteManga(catalog, body.id));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/delete-chapter' && req.method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'ID chapter tidak valid.');
      await updateCatalog((catalog) => deleteChapter(catalog, body.id));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/delete-comment' && req.method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'ID komentar tidak valid.');
      await updateCatalog((catalog) => deleteComment(catalog, body.id));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/comment-status' && req.method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'ID komentar tidak valid.');
      if (!['approved', 'rejected'].includes(body.status)) {
        throw new HttpError(400, 'Status komentar harus approved atau rejected.');
      }
      await updateCatalog((catalog) => {
        const comment = catalog.comments.find((item) => item.id === body.id);
        if (!comment) throw new HttpError(404, 'Komentar tidak ditemukan.');
        comment.status = body.status;
      });
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/users' && req.method === 'GET') {
      requireAdmin(req);
      const catalog = await readCatalog();
      const users = (catalog.users || []).map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        provider: user.provider,
        role: user.role,
        createdAt: user.createdAt
      }));
      return sendJson(res, 200, { users });
    }

    if (route === 'admin/user-role' && req.method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'ID pengguna tidak valid.');
      if (!['admin', 'member'].includes(body.role)) throw new HttpError(400, 'Role harus admin atau member.');
      let updated = null;
      await updateCatalog((catalog) => {
        const user = (catalog.users || []).find((item) => item.id === body.id);
        if (!user) throw new HttpError(404, 'Pengguna tidak ditemukan.');
        if (user.role === 'admin' && body.role === 'member') {
          const adminCount = (catalog.users || []).filter((item) => item.role === 'admin').length;
          if (adminCount <= 1) throw new HttpError(400, 'Tidak dapat menurunkan admin terakhir.');
        }
        user.role = body.role;
        updated = user;
      });
      return sendJson(res, 200, { ok: true, user: updated });
    }

    if (route === 'admin/delete-user' && req.method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'ID pengguna tidak valid.');
      const claims = sessionClaims(req);
      if (claims && claims.sub === body.id) throw new HttpError(400, 'Tidak dapat menghapus akun sendiri.');
      await updateCatalog((catalog) => {
        const user = (catalog.users || []).find((item) => item.id === body.id);
        if (!user) throw new HttpError(404, 'Pengguna tidak ditemukan.');
        if (user.role === 'admin') {
          const adminCount = (catalog.users || []).filter((item) => item.role === 'admin').length;
          if (adminCount <= 1) throw new HttpError(400, 'Tidak dapat menghapus admin terakhir.');
        }
        catalog.users = (catalog.users || []).filter((item) => item.id !== body.id);
      });
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/upload-dual' && req.method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      const { mimeType, bytes } = decodeUpload(body.dataBase64);
      const baseUrl = apiBaseUrl();
      const fileId = await saveMedia(body.fileName, mimeType, bytes);
      const mediaUrl = `${baseUrl}/api/media/${encodeURIComponent(fileId)}`;
      return sendJson(res, 201, {
        telegramFileId: fileId,
        bloggerUrl: mediaUrl,
        telegramStatus: 'tersimpan',
        bloggerStatus: 'proxy aktif'
      });
    }

    if (route.startsWith('media/') && req.method === 'GET') {
      const fileId = validatePathId(route.slice('media/'.length));
      const { bytes, filePath } = await getMedia(fileId);
      const extension = filePath.split('.').pop().toLowerCase();
      const contentType = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[extension];
      if (!contentType) throw new HttpError(415, 'Format media tidak didukung.');
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', bytes.length);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(bytes);
    }

    if (route === 'health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'nexamanga-vercel-backend' });
    }

    throw new HttpError(404, `Endpoint tidak ditemukan: ${req.method} /${route}`);
  } catch (error) {
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
    if (error instanceof ValidationError) return sendJson(res, 400, { error: error.message });
    if (error instanceof StorageAlreadyInitializedError) return sendJson(res, 409, { error: error.message });
    if (error instanceof CatalogNotInitializedError) return sendJson(res, 409, { error: error.message });
    if (error instanceof TelegramError) {
      console.error(error.message);
      return sendJson(res, 502, { error: error.message });
    }
    if (/Environment variable|TOKEN_SECRET|TELEGRAM_STORAGE_CHAT_ID|PUBLIC_API_URL|GOOGLE_CLIENT|DISCORD_CLIENT/.test(error.message)) {
      console.error(error.message);
      return sendJson(res, 500, { error: error.message });
    }
    if (error instanceof SyntaxError) {
      return sendJson(res, 400, { error: 'Body harus berupa JSON yang valid.' });
    }
    console.error('API request failed:', error.name || 'Error', error.message || 'Unknown error');
    return sendJson(res, 500, { error: 'Terjadi kesalahan pada backend.' });
  }
}

module.exports = handler;

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
  pinComment,
  enrichCommentsWithUsers,
  incrementMangaViews,
  registerOAuthUser,
  saveChapter,
  saveManga,
  saveSettings,
  addChapterReaction,
  addMangaReaction,
  upvoteComment
} = require('../lib/catalog');
const {
  MAX_MEDIA_BYTES,
  TelegramError,
  getMedia,
  saveMedia
} = require('../lib/telegram');
const {
  CatalogNotInitializedError,
  ConcurrentUpdateError,
  StorageAlreadyInitializedError,
  ensureCatalogInitialized,
  initializeCatalog,
  modifyCatalog,
  readCatalog,
  recordTrack,
  readAnalytics
} = require('../lib/db');

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

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
}

function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = parseAllowedOrigins();
  const wildcard = allowed.includes('*');

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

async function freshSessionClaims(req) {
  const claims = sessionClaims(req);
  if (!claims) return null;
  try {
    const catalog = await readCatalog();
    const user = (catalog.users || []).find((item) => item.id === claims.sub);
    if (!user) return null;
    return {
      sub: user.id,
      role: user.role,
      user: {
        id: user.id,
        name: user.name,
        email: user.email || null,
        avatar: user.avatar || null,
        provider: user.provider
      },
      exp: claims.exp
    };
  } catch (error) {
    if (error instanceof CatalogNotInitializedError) {
      // Basis data belum siap (misal untuk storage/init pertama); percayai JWT.
      return claims;
    }
    throw error;
  }
}

async function isAdmin(req) {
  const claims = await freshSessionClaims(req);
  return Boolean(claims && claims.role === 'admin');
}

function sessionClaims(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? verifySessionToken(match[1]) : null;
}

async function requireAdmin(req) {
  if (!(await isAdmin(req))) throw new HttpError(401, 'Sesi admin tidak valid atau sudah berakhir. Silakan masuk kembali.');
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
  return modifyCatalog(change);
}

function decodeUpload(dataUrl) {
  if (typeof dataUrl !== 'string') throw new HttpError(400, 'Data gambar tidak valid.');
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new HttpError(400, 'Data gambar harus berupa JPEG, PNG, atau WebP base64.');
  if (match[2].length > 4.5 * 1024 * 1024) throw new HttpError(413, 'Ukuran request terlalu besar.');
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

const LANDING_HTML = '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NexaManga Vercel Backend</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:40px 20px;background:#0f172a;color:#e2e8f0}.card{max-width:640px;margin:0 auto;background:#1e293b;border-radius:12px;padding:32px;box-shadow:0 10px 30px rgba(0,0,0,.3)}h1{margin:0 0 8px;font-size:1.6rem}p{line-height:1.6;color:#cbd5e1}a{color:#38bdf8}code{background:#0f172a;padding:2px 6px;border-radius:4px}.status{display:inline-block;margin-top:16px;padding:8px 12px;background:#16a34a;color:#fff;border-radius:6px;text-decoration:none}</style></head><body><div class="card"><h1>NexaManga Vercel Backend</h1><p>Backend serverless untuk tema Blogger NexaManga. API tersedia di <code>/api/*</code>.</p><p>Periksa status layanan:</p><a class="status" href="/api/health">Cek Health</a></div></body></html>';

async function handler(req, res) {
  setSecurityHeaders(res);
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
  if ((route === '' || route === 'index.html') && req.method === 'GET') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(LANDING_HTML);
  }
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
      const rawClaims = sessionClaims(req);
      const claims = await freshSessionClaims(req);
      if (!claims) {
        throw new HttpError(401, rawClaims
          ? 'Akun tidak ditemukan atau sudah dihapus. Silakan masuk kembali.'
          : 'Sesi tidak valid atau sudah berakhir. Silakan masuk kembali.');
      }
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

    if (route === 'admin/settings' && req.method === 'POST') {
      await requireAdmin(req);
      const body = await readBody(req);
      let saved;
      await updateCatalog((catalog) => { saved = saveSettings(catalog, body); });
      return sendJson(res, 200, { settings: saved });
    }

    if (route === 'admin/storage/init' && req.method === 'POST') {
      await requireAdmin(req);
      const rowId = await initializeCatalog(EMPTY_CATALOG);
      return sendJson(res, 201, {
        rowId,
        instruction: 'Baris snapshot awal sudah tersimpan di tabel nexamanga_snapshot pada database Neon.'
      });
    }

    if (route === 'manga/view' && req.method === 'POST') {
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id : (typeof body.slug === 'string' ? body.slug : '');
      if (!id) throw new HttpError(400, 'ID atau slug manga tidak valid.');
      let updated;
      await updateCatalog((catalog) => { updated = incrementMangaViews(catalog, id); });
      return sendJson(res, 200, { ok: true, views: updated.views });
    }

    if (route === 'mangadex/manga' && req.method === 'GET') {
      await requireAdmin(req);
      const url = new URL(req.url, 'http://localhost');
      const id = url.searchParams.get('id');
      if (!id) throw new HttpError(400, 'ID manga tidak valid.');
      const r = await fetch('https://api.mangadex.org/manga/' + encodeURIComponent(id) + '?includes[]=cover_art&includes[]=author&includes[]=artist', {
        headers: { 'Accept': 'application/json', 'User-Agent': 'NexaManga/1.0' }
      });
      const data = await r.json();
      if (!r.ok) throw new HttpError(r.status, (data && data.errors && data.errors[0] && data.errors[0].detail) || 'Gagal mengambil manga.');
      return sendJson(res, 200, data);
    }

    if (route === 'mangadex/chapters' && req.method === 'GET') {
      await requireAdmin(req);
      const url = new URL(req.url, 'http://localhost');
      const id = url.searchParams.get('id');
      if (!id) throw new HttpError(400, 'ID manga tidak valid.');
      const offset = url.searchParams.get('offset') || '0';
      const lang = url.searchParams.get('lang');
      const langParam = lang && lang !== 'all' ? '&translatedLanguage[]=' + encodeURIComponent(lang) : '';
      const r = await fetch('https://api.mangadex.org/manga/' + encodeURIComponent(id) + '/feed?limit=500&offset=' + encodeURIComponent(offset) + '&order[chapter]=asc' + langParam, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'NexaManga/1.0' }
      });
      const data = await r.json();
      if (!r.ok) throw new HttpError(r.status, (data && data.errors && data.errors[0] && data.errors[0].detail) || 'Gagal mengambil chapter.');
      return sendJson(res, 200, data);
    }

    if (route === 'mangadex/athome' && req.method === 'GET') {
      await requireAdmin(req);
      const url = new URL(req.url, 'http://localhost');
      const chapterId = url.searchParams.get('chapterId');
      if (!chapterId) throw new HttpError(400, 'ID chapter tidak valid.');
      const r = await fetch('https://api.mangadex.org/at-home/server/' + encodeURIComponent(chapterId), {
        headers: { 'Accept': 'application/json', 'User-Agent': 'NexaManga/1.0' }
      });
      const data = await r.json();
      if (!r.ok) throw new HttpError(r.status, (data && data.errors && data.errors[0] && data.errors[0].detail) || 'Gagal mengambil server gambar.');
      return sendJson(res, 200, data);
    }

    if (route === 'mangadex/image' && req.method === 'GET') {
      await requireAdmin(req);
      const url = new URL(req.url, 'http://localhost');
      const imageUrl = url.searchParams.get('url');
      if (!imageUrl) throw new HttpError(400, 'URL gambar tidak valid.');
      let parsed;
      try { parsed = new URL(imageUrl); } catch { throw new HttpError(400, 'URL gambar tidak valid.'); }
      if (parsed.protocol !== 'https:') throw new HttpError(400, 'URL gambar harus menggunakan HTTPS.');
      const host = parsed.hostname.toLowerCase();
      const allowed = host === 'uploads.mangadex.org' ||
        host.endsWith('.mangadex.org') ||
        host.endsWith('.mangadex.network') ||
        host.endsWith('.mangadex.cc');
      if (!allowed) {
        throw new HttpError(400, 'Host gambar tidak diizinkan.');
      }
      const r = await fetch(imageUrl, { headers: { 'User-Agent': 'NexaManga/1.0' } });
      if (!r.ok) throw new HttpError(r.status, 'Gagal mengunduh gambar.');
      const buf = Buffer.from(await r.arrayBuffer());
      const mime = r.headers.get('content-type') || 'image/jpeg';
      return sendJson(res, 200, { dataBase64: 'data:' + mime + ';base64,' + buf.toString('base64'), mimeType: mime });
    }

    if (route === 'track' && req.method === 'POST') {
      const body = await readBody(req);
      const visitorId = typeof body.visitorId === 'string' ? body.visitorId.slice(0, 100) : '';
      await recordTrack(visitorId);
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'analytics' && req.method === 'GET') {
      await requireAdmin(req);
      const url = new URL(req.url, 'http://localhost');
      const from = url.searchParams.get('from') || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
      const to = url.searchParams.get('to') || new Date().toISOString().slice(0, 10);
      const rows = await readAnalytics(from, to);
      const totals = rows.reduce((acc, r) => {
        acc.pageviews += r.pageviews;
        acc.visitors += r.visitors;
        acc.visits += r.visits;
        return acc;
      }, { pageviews: 0, visitors: 0, visits: 0 });
      const avg = totals.visits ? (totals.pageviews / totals.visits) : 0;
      return sendJson(res, 200, { from, to, totals: { pageviews: totals.pageviews, visitors: totals.visitors, visits: totals.visits, average: Number(avg.toFixed(1)) }, daily: rows });
    }

    if (route === 'chapter/reaction' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.voterId !== 'string' || !body.voterId) throw new HttpError(400, 'ID voter tidak valid.');
      let result;
      await updateCatalog((catalog) => { result = addChapterReaction(catalog, body); });
      return sendJson(res, 200, result);
    }

    if (route === 'manga/reaction' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.voterId !== 'string' || !body.voterId) throw new HttpError(400, 'ID voter tidak valid.');
      let result;
      await updateCatalog((catalog) => { result = addMangaReaction(catalog, body); });
      return sendJson(res, 200, result);
    }

    if (route === 'comment/upvote' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.voterId !== 'string' || !body.voterId) throw new HttpError(400, 'ID voter tidak valid.');
      let updated;
      await updateCatalog((catalog) => { updated = upvoteComment(catalog, body); });
      return sendJson(res, 200, { comment: updated });
    }

    if (route === 'comment/image' && req.method === 'POST') {
      const rawClaims = sessionClaims(req);
      const claims = await freshSessionClaims(req);
      if (!claims) throw new HttpError(401, rawClaims ? 'Akun tidak ditemukan atau sudah dihapus. Silakan masuk kembali.' : 'Masuk terlebih dahulu untuk mengunggah gambar.');
      const body = await readBody(req);
      const { mimeType, bytes } = decodeUpload(body.dataBase64);
      const fileId = await saveMedia(body.fileName || 'comment.jpg', mimeType, bytes);
      const url = `${apiBaseUrl()}/api/media/${encodeURIComponent(fileId)}`;
      return sendJson(res, 201, { url });
    }

    if (route === 'catalog' && req.method === 'GET') {
      let catalog;
      try {
        catalog = await readCatalog();
      } catch (error) {
        if (!(error instanceof CatalogNotInitializedError)) throw error;
        catalog = { manga: [], chapters: [], comments: [], users: [] };
      }
      enrichCommentsWithUsers(catalog);
      if (!(await isAdmin(req))) {
        catalog.comments = catalog.comments.filter((comment) => comment.status === 'approved');
      }
      delete catalog.users;
      return sendJson(res, 200, catalog);
    }

    if (route === 'comment' && req.method === 'POST') {
      const body = await readBody(req);
      const rawClaims = sessionClaims(req);
      const claims = await freshSessionClaims(req);
      if (rawClaims && !claims) {
        throw new HttpError(401, 'Akun tidak ditemukan atau sudah dihapus. Silakan masuk kembali.');
      }
      if (claims) {
        body.userId = claims.sub;
        body.authorName = claims.user && claims.user.name ? claims.user.name : 'Pengguna';
        body.authorAvatar = claims.user && claims.user.avatar ? claims.user.avatar : null;
      } else {
        body.userId = null;
        body.authorAvatar = null;
      }
      let created;
      await updateCatalog((catalog) => { created = addComment(catalog, body); });
      return sendJson(res, 201, { comment: created });
    }

    if (route === 'admin/save-manga' && req.method === 'POST') {
      await requireAdmin(req);
      const body = await readBody(req);
      await updateCatalog((catalog) => saveManga(catalog, body));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/save-chapter' && req.method === 'POST') {
      await requireAdmin(req);
      const body = await readBody(req);
      await updateCatalog((catalog) => saveChapter(catalog, body));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/delete-manga' && req.method === 'POST') {
      await requireAdmin(req);
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'ID manga tidak valid.');
      await updateCatalog((catalog) => deleteManga(catalog, body.id));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/delete-chapter' && req.method === 'POST') {
      await requireAdmin(req);
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'ID chapter tidak valid.');
      await updateCatalog((catalog) => deleteChapter(catalog, body.id));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/delete-comment' && req.method === 'POST') {
      await requireAdmin(req);
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'ID komentar tidak valid.');
      await updateCatalog((catalog) => deleteComment(catalog, body.id));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/comment-status' && req.method === 'POST') {
      await requireAdmin(req);
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
      await requireAdmin(req);
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
      await requireAdmin(req);
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
      await requireAdmin(req);
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

    if (route === 'admin/pin-comment' && req.method === 'POST') {
      await requireAdmin(req);
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'ID komentar tidak valid.');
      let updated;
      await updateCatalog((catalog) => { updated = pinComment(catalog, body); });
      return sendJson(res, 200, { ok: true, pinned: !!updated.pinned });
    }

    if (route === 'admin/upload-dual' && req.method === 'POST') {
      await requireAdmin(req);
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
    if (error instanceof ConcurrentUpdateError) return sendJson(res, 409, { error: error.message });
    if (error instanceof TelegramError) {
      console.error(error.message);
      return sendJson(res, 502, { error: error.message });
    }
    if (/Environment variable|TOKEN_SECRET|DATABASE_URL|PUBLIC_API_URL|GOOGLE_CLIENT|DISCORD_CLIENT/.test(error.message)) {
      console.error(error.message);
      return sendJson(res, 500, { error: 'Konfigurasi backend tidak lengkap.' });
    }
    if (error instanceof SyntaxError) {
      return sendJson(res, 400, { error: 'Body harus berupa JSON yang valid.' });
    }
    console.error('API request failed:', error.name || 'Error', error.message || 'Unknown error');
    return sendJson(res, 500, { error: 'Terjadi kesalahan pada backend.' });
  }
}

module.exports = handler;

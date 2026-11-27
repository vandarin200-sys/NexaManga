'use strict';

const crypto = require('node:crypto');
const {
  SESSION_REFRESH_WINDOW_SECONDS,
  TRACKER_PROVIDERS,
  createOAuthLinkState,
  createOAuthState,
  createSessionToken,
  verifyOAuthLinkState,
  verifyOAuthState,
  verifySessionToken
} = require('../lib/auth');
const {
  EMPTY_CATALOG,
  ValidationError,
  addComment,
  addReport,
  REACTION_KEYS,
  assertCredentialsAvailable,
  assertEmailVerificationPending,
  changeAccountPassword,
  createEmailVerificationCode,
  deleteAccount,
  deleteChapter,
  deleteComment,
  deleteManga,
  deleteReport,
  pinComment,
  enrichCommentsWithUsers,
  hashCredential,
  incrementMangaViews,
  linkTrackerConnection,
  registerOAuthUser,
  resendEmailVerification,
  safeUser,
  saveChapter,
  saveManga,
  saveSettings,
  setAccountCredentials,
  setReportStatus,
  syncTrackerConnection,
  unlinkTrackerConnection,
  validateEmailAddress,
  validatePasswordValue,
  verifyCredential,
  verifyEmailVerification,
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
const { uploadImage } = require('../lib/storage');
const {
  CatalogNotInitializedError,
  ConcurrentUpdateError,
  StorageAlreadyInitializedError,
  awardXp,
  ensureCatalogInitialized,
  initializeCatalog,
  migrateLegacyCatalog,
  modifyCatalog,
  readCatalog,
  readLeaderboard,
  readUserProgress,
  recordTrack,
  readAnalytics
} = require('../lib/db');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimits = new Map();

function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  const first = forwarded.split(',')[0].trim();
  if (first) return first;
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function requestViewerKey(req, claims) {
  if (claims && claims.sub) return claims.sub;
  const ip = requestIp(req);
  const agent = String(req.headers['user-agent'] || '');
  const secret = String(process.env.TOKEN_SECRET || '');
  return 'anon-' + crypto.createHmac('sha256', secret).update(`${ip}|${agent}`).digest('hex').slice(0, 32);
}

function enforceRateLimit(req, action, limit) {
  const key = `${action}:${requestViewerKey(req, sessionClaims(req))}`;
  const now = Date.now();
  if (rateLimits.size > 5000) {
    for (const [entryKey, entry] of rateLimits) {
      if (now - entry.start >= RATE_LIMIT_WINDOW_MS) rateLimits.delete(entryKey);
    }
  }
  const bucket = rateLimits.get(key);
  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(key, { start: now, count: 1 });
    return;
  }
  if (bucket.count >= limit) throw new HttpError(429, 'Terlalu banyak permintaan. Coba lagi beberapa saat lagi.');
  bucket.count += 1;
}

function reactionSummaries(collection, viewerKey) {
  const summaries = {};
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) return summaries;
  for (const [targetId, groups] of Object.entries(collection)) {
    const counts = {};
    let userVote = null;
    for (const key of REACTION_KEYS) {
      const voters = groups && Array.isArray(groups[key]) ? groups[key] : [];
      counts[key] = voters.length;
      if (voters.includes(viewerKey)) userVote = key;
    }
    summaries[targetId] = { counts, userVote };
  }
  return summaries;
}

function sanitizeComment(comment, viewerKey) {
  const output = { ...comment };
  delete output.upvotes;
  delete output.authorKey;
  const voters = Array.isArray(comment.upvotes) ? comment.upvotes : [];
  output.upvoteCount = voters.length;
  output.userUpvoted = voters.includes(viewerKey);
  return output;
}

function sanitizeCatalog(catalog, viewerKey, claims, showAllComments) {
  const output = { ...catalog };
  if (catalog.reactions) output.reactions = reactionSummaries(catalog.reactions, viewerKey);
  if (catalog.mangaReactions) output.mangaReactions = reactionSummaries(catalog.mangaReactions, viewerKey);
  output.comments = (catalog.comments || [])
    .filter((comment) => showAllComments || comment.status === 'approved' ||
      (claims && comment.userId === claims.sub) ||
      (!claims && viewerKey && comment.authorKey === viewerKey))
    .map((comment) => sanitizeComment(comment, viewerKey));
  delete output.users;
  delete output.reports;
  return output;
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-NexaManga-Auth', '1');
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
  res.setHeader('Access-Control-Expose-Headers', 'X-NexaManga-Auth');
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
      record: user,
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

async function requireAccount(req) {
  const rawClaims = sessionClaims(req);
  const claims = await freshSessionClaims(req);
  if (!claims || !claims.sub) {
    throw new HttpError(401, rawClaims
      ? 'Akun tidak ditemukan atau sudah dihapus. Silakan masuk kembali.'
      : 'Sesi tidak valid atau sudah berakhir. Silakan masuk kembali.');
  }
  return claims;
}

function emailWebhookUrl() {
  const value = process.env.EMAIL_VERIFY_WEBHOOK_URL;
  const message = 'Pengiriman email verifikasi belum dikonfigurasi.';
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(503, message);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid webhook');
  } catch {
    throw new HttpError(503, message);
  }
  return value;
}

async function sendVerificationEmail(email, name, code) {
  const url = emailWebhookUrl();
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.EMAIL_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${process.env.EMAIL_WEBHOOK_TOKEN}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to: email, name, code, type: 'email_verification' })
    });
  } catch {
    throw new HttpError(502, 'Email verifikasi gagal dikirim.');
  }
  if (!response.ok) throw new HttpError(502, 'Email verifikasi gagal dikirim.');
}

function trackerProvider(value) {
  if (!TRACKER_PROVIDERS.includes(value)) throw new HttpError(400, 'Penyedia koneksi tidak valid.');
  return value;
}

function trackerCredentials(provider) {
  const prefix = provider === 'anilist' ? 'ANILIST' : 'MAL';
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) throw new HttpError(503, `Koneksi ${provider} belum dikonfigurasi.`);
  return { clientId, clientSecret };
}

function trackerRedirectUrl(provider) {
  return `${apiBaseUrl()}/api/auth/${provider}/link/callback`;
}

async function exchangeTrackerCode(provider, code, linkState) {
  const { clientId, clientSecret } = trackerCredentials(provider);
  const redirectUri = trackerRedirectUrl(provider);
  let response;
  if (provider === 'anilist') {
    response = await fetch('https://anilist.co/api/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code
      })
    });
  } else {
    response = await fetch('https://myanimelist.net/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code_verifier: linkState.codeVerifier,
        code,
        redirect_uri: redirectUri
      })
    });
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || typeof result.access_token !== 'string' || !result.access_token) {
    throw new HttpError(401, `Koneksi ${provider} gagal diverifikasi.`);
  }
  return result.access_token;
}

function trackerTokenInvalid(response, data) {
  if (response.status === 401 || response.status === 403) return true;
  const message = data && typeof data === 'object' ? JSON.stringify(data) : String(data || '');
  return /invalid[_\s-]?token|token[_\s-]?(expired|invalid)|expired|unauthorized/i.test(message);
}

async function fetchTrackerIdentity(provider, accessToken, invalidTokenMessage) {
  let response;
  let data;
  if (provider === 'anilist') {
    response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ query: '{ Viewer { id name avatar { medium } } }' })
    });
    data = await response.json().catch(() => null);
    const viewer = data && data.data && data.data.Viewer;
    if (!response.ok || !viewer || viewer.id === undefined || viewer.id === null) {
      if (trackerTokenInvalid(response, data)) throw new HttpError(401, invalidTokenMessage);
      throw new HttpError(401, `Profil ${provider} tidak dapat diverifikasi.`);
    }
    return {
      providerId: String(viewer.id),
      username: typeof viewer.name === 'string' && viewer.name ? viewer.name : `AniList ${viewer.id}`
    };
  }
  response = await fetch('https://api.myanimelist.net/v2/users/@me', {
    headers: { 'Accept': 'application/json', Authorization: `Bearer ${accessToken}` }
  });
  data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.id) {
    if (trackerTokenInvalid(response, data)) throw new HttpError(401, invalidTokenMessage);
    throw new HttpError(401, `Profil ${provider} tidak dapat diverifikasi.`);
  }
  return {
    providerId: String(data.id),
    username: typeof data.name === 'string' && data.name ? data.name : `MyAnimeList ${data.id}`
  };
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
  if (!allowed.includes(origin)) {
    try { if (origin === apiBaseUrl()) allowed.push(origin); } catch {}
  }
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

async function awardProgress(claims, activity, refKey, amount) {
  if (!claims || !claims.sub) return null;
  try {
    return await awardXp({
      userId: claims.sub,
      username: claims.user && claims.user.name ? claims.user.name : '',
      name: claims.user && claims.user.name ? claims.user.name : 'Member',
      avatar: claims.user && claims.user.avatar ? claims.user.avatar : null,
      activity,
      refKey,
      amount
    });
  } catch (error) {
    console.error('[progress] gagal mencatat XP:', error && error.message ? error.message : error);
    return null;
  }
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

function mediaContentType(filePath, bytes) {
  const extension = String(filePath || '').split('.').pop().toLowerCase();
  let contentType = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' })[extension];
  if (!contentType && Buffer.isBuffer(bytes)) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) contentType = 'image/jpeg';
    else if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) contentType = 'image/png';
    else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') contentType = 'image/webp';
    else if (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) contentType = 'image/gif';
  }
  return contentType || '';
}

function mediaFileId(value) {
  if (typeof value !== 'string') return '';
  const match = value.match(/(?:^|\/)api\/media\/([A-Za-z0-9_=-]{10,512})/);
  return match ? match[1] : '';
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
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(html);
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
      await awardProgress(
        { sub: user.id, user: { name: user.name, avatar: user.avatar } },
        'welcome',
        user.id,
        25
      );
      const token = createSessionToken(user);
      return redirect(res, `${state.returnOrigin}/?auth_token=${encodeURIComponent(token)}#/akun`);
    }

    const linkRoute = route.match(/^auth\/(anilist|mal)\/link\/(start|callback)$/);
    if (linkRoute && req.method === 'GET') {
      const [, provider, action] = linkRoute;
      const { clientId } = trackerCredentials(provider);
      const url = new URL(req.url, 'http://localhost');
      const linkState = verifyOAuthLinkState(action === 'start'
        ? url.searchParams.get('token')
        : url.searchParams.get('state'));
      const stateCookie = getCookie(req, 'nexa_oauth_state');
      if (!linkState || linkState.provider !== provider || !stateCookie ||
          linkState.nonce !== stateCookie || !allowedReturnOrigin(linkState.returnOrigin)) {
        throw new HttpError(400, 'Sesi koneksi tidak valid atau sudah berakhir. Silakan coba lagi.');
      }
      if (action === 'start') {
        setOAuthCookie(res, linkState.nonce, 600);
        const authorizeUrl = provider === 'anilist'
          ? new URL('https://anilist.co/api/v2/oauth/authorize')
          : new URL('https://myanimelist.net/v1/oauth2/authorize');
        const params = provider === 'anilist'
          ? {
            client_id: clientId,
            redirect_uri: trackerRedirectUrl(provider),
            response_type: 'code',
            state: url.searchParams.get('token')
          }
          : {
            client_id: clientId,
            code_challenge: linkState.codeChallenge,
            code_challenge_method: 'S256',
            response_type: 'code',
            state: url.searchParams.get('token')
          };
        authorizeUrl.search = new URLSearchParams(params).toString();
        return redirect(res, authorizeUrl.toString());
      }

      setOAuthCookie(res, '', 0);
      if (url.searchParams.has('error') || !url.searchParams.get('code')) {
        throw new HttpError(401, `Koneksi ${provider} dibatalkan atau ditolak oleh penyedia akun.`);
      }
      const accessToken = await exchangeTrackerCode(provider, url.searchParams.get('code'), linkState);
      const profile = await fetchTrackerIdentity(provider, accessToken, `Koneksi ${provider} perlu dihubungkan ulang.`);
      await ensureCatalogInitialized();
      let account;
      await updateCatalog((catalog) => {
        account = linkTrackerConnection(catalog, { userId: linkState.sub, provider, profile: { ...profile, accessToken } });
      });
      const token = createSessionToken(account);
      return redirect(res, `${linkState.returnOrigin}/?auth_token=${encodeURIComponent(token)}#/settings`);
    }

    if (route === 'auth/me' && req.method === 'GET') {
      const rawClaims = sessionClaims(req);
      const claims = await freshSessionClaims(req);
      if (!claims) {
        throw new HttpError(401, rawClaims
          ? 'Akun tidak ditemukan atau sudah dihapus. Silakan masuk kembali.'
          : 'Sesi tidak valid atau sudah berakhir. Silakan masuk kembali.');
      }
      const now = Math.floor(Date.now() / 1000);
      const refreshedToken = claims.exp - now <= SESSION_REFRESH_WINDOW_SECONDS
        ? createSessionToken({ ...claims.user, id: claims.sub, role: claims.role }, now)
        : null;
      const payload = { user: safeUser(claims.record || claims.user), role: claims.role };
      if (refreshedToken) payload.token = refreshedToken;
      return sendJson(res, 200, payload);
    }

    const progressRoute = route.match(/^user\/([^/]+)\/xp$/);
    if (progressRoute && req.method === 'GET') {
      let username;
      try {
        username = decodeURIComponent(progressRoute[1]);
      } catch {
        throw new HttpError(400, 'Username tidak valid.');
      }
      if (!username || username.length > 100) throw new HttpError(400, 'Username tidak valid.');
      const progress = await readUserProgress(username);
      if (!progress) throw new HttpError(404, 'Progres pengguna tidak ditemukan.');
      return sendJson(res, 200, progress);
    }

    if (route === 'account/credentials' && req.method === 'POST') {
      const claims = await requireAccount(req);
      const body = await readBody(req);
      const email = validateEmailAddress(body.email);
      const password = validatePasswordValue(body.password);
      if (body.confirm_password !== password) throw new HttpError(400, 'Konfirmasi kata sandi tidak sama.');
      emailWebhookUrl();
      const current = await readCatalog();
      assertCredentialsAvailable(current, claims.sub, email);
      const secret = hashCredential(password);
      const verification = createEmailVerificationCode();
      const name = (claims.record && claims.record.name) || (claims.user && claims.user.name) || 'Pengguna';
      await sendVerificationEmail(email, name, verification.code);
      await updateCatalog((catalog) => {
        setAccountCredentials(catalog, {
          userId: claims.sub,
          email,
          passwordHash: secret.hash,
          passwordSalt: secret.salt,
          verification
        });
      });
      return sendJson(res, 200, { ok: true, requiresVerification: true });
    }

    if (route === 'account/email/resend' && req.method === 'POST') {
      const claims = await requireAccount(req);
      await readBody(req);
      emailWebhookUrl();
      const current = await readCatalog();
      const account = assertEmailVerificationPending(current, claims.sub);
      const verification = createEmailVerificationCode();
      const name = account.name || 'Pengguna';
      await sendVerificationEmail(account.email, name, verification.code);
      await updateCatalog((catalog) => {
        resendEmailVerification(catalog, { userId: claims.sub, verification });
      });
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'account/email/verify' && req.method === 'POST') {
      const claims = await requireAccount(req);
      const body = await readBody(req);
      if (typeof body.verification_code !== 'string' || !/^\d{6}$/.test(body.verification_code)) {
        throw new HttpError(400, 'Kode verifikasi harus berupa 6 digit angka.');
      }
      let result;
      await updateCatalog((catalog) => {
        result = verifyEmailVerification(catalog, { userId: claims.sub, code: body.verification_code });
      });
      if (!result.ok) throw new HttpError(400, result.error);
      return sendJson(res, 200, { ok: true, user: result.user });
    }

    if (route === 'account/password' && req.method === 'POST') {
      const claims = await requireAccount(req);
      const body = await readBody(req);
      if (typeof body.old_password !== 'string' || !body.old_password) {
        throw new HttpError(400, 'Kata sandi lama tidak valid.');
      }
      const password = validatePasswordValue(body.new_password);
      if (body.confirm_password !== password) throw new HttpError(400, 'Konfirmasi kata sandi tidak sama.');
      await updateCatalog((catalog) => {
        changeAccountPassword(catalog, { userId: claims.sub, oldPassword: body.old_password, newPassword: password });
      });
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'account/delete' && req.method === 'POST') {
      const claims = await requireAccount(req);
      const body = await readBody(req);
      if (body.confirm !== 'DELETE') throw new HttpError(400, 'Konfirmasi harus berisi DELETE.');
      await updateCatalog((catalog) => { deleteAccount(catalog, { userId: claims.sub }); });
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'account/connections/link-token' && req.method === 'POST') {
      const claims = await requireAccount(req);
      const body = await readBody(req);
      const provider = trackerProvider(body.provider);
      const returnOrigin = allowedReturnOrigin(body.return_to);
      if (!returnOrigin) throw new HttpError(400, 'Origin Blogger tidak diizinkan untuk koneksi tracker.');
      trackerCredentials(provider);
      const codeVerifier = crypto.randomBytes(48).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      const nonce = crypto.randomBytes(32).toString('base64url');
      const linkState = createOAuthLinkState({
        sub: claims.sub,
        provider,
        returnOrigin,
        nonce,
        codeVerifier,
        codeChallenge
      });
      setOAuthCookie(res, nonce, 600);
      const url = `${apiBaseUrl()}/api/auth/${provider}/link/start?token=${encodeURIComponent(linkState)}`;
      return sendJson(res, 200, { url });
    }

    if (route === 'account/connections/unlink' && req.method === 'POST') {
      const claims = await requireAccount(req);
      const body = await readBody(req);
      const provider = trackerProvider(body.provider);
      await updateCatalog((catalog) => {
        unlinkTrackerConnection(catalog, { userId: claims.sub, provider });
      });
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'account/connections/sync' && req.method === 'POST') {
      const claims = await requireAccount(req);
      const body = await readBody(req);
      const provider = trackerProvider(body.provider);
      const current = await readCatalog();
      const currentUser = (current.users || []).find((item) => item.id === claims.sub);
      const connection = currentUser && currentUser.connections && currentUser.connections[provider];
      if (!connection || typeof connection.accessToken !== 'string' || !connection.accessToken) {
        throw new HttpError(400, `Koneksi ${provider} belum terhubung.`);
      }
      const identity = await fetchTrackerIdentity(provider, connection.accessToken, `Koneksi ${provider} perlu dihubungkan ulang.`);
      let synced;
      await updateCatalog((catalog) => {
        synced = syncTrackerConnection(catalog, { userId: claims.sub, provider, username: identity.username });
      });
      return sendJson(res, 200, { ok: true, provider, username: synced.username, syncedAt: synced.syncedAt });
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
      let force = false;
      if (Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding']) {
        const body = await readBody(req);
        force = body.force === true;
      }
      const rowId = await initializeCatalog(EMPTY_CATALOG, { allowLegacyOverwrite: force });
      return sendJson(res, 201, {
        rowId,
        instruction: 'Tabel relasional NexaManga sudah diinisialisasi pada database Neon.'
      });
    }

    if (route === 'admin/storage/migrate' && req.method === 'POST') {
      await requireAdmin(req);
      const result = await migrateLegacyCatalog();
      if (result.ok) {
        return sendJson(res, 200, { ok: true, message: 'Data dari nexamanga_snapshot berhasil dipindahkan ke tabel relasional.' });
      }
      if (result.reason === 'already-initialized') {
        return sendJson(res, 200, { ok: true, alreadyInitialized: true, message: 'Database relasional sudah terinisialisasi.' });
      }
      if (result.reason === 'invalid-legacy-data') {
        throw new HttpError(400, 'Data pada nexamanga_snapshot tidak valid sehingga tidak dapat dimigrasikan.');
      }
      throw new HttpError(404, 'Tidak ditemukan data lama pada nexamanga_snapshot untuk dimigrasikan.');
    }

    if (route === 'manga/view' && req.method === 'POST') {
      enforceRateLimit(req, 'manga-view', 120);
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id : (typeof body.slug === 'string' ? body.slug : '');
      if (!id) throw new HttpError(400, 'ID atau slug manga tidak valid.');
      const claims = sessionClaims(req);
      let updated;
      await updateCatalog((catalog) => { updated = incrementMangaViews(catalog, id); });
      await awardProgress(claims, 'manga_view', `${updated.id}:${new Date().toISOString().slice(0, 10)}`, 3);
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

    if (route === 'mangadex/rating' && req.method === 'GET') {
      await requireAdmin(req);
      const url = new URL(req.url, 'http://localhost');
      const id = url.searchParams.get('id');
      if (!id) throw new HttpError(400, 'ID manga tidak valid.');
      const r = await fetch('https://api.mangadex.org/statistics/manga/' + encodeURIComponent(id), {
        headers: { 'Accept': 'application/json', 'User-Agent': 'NexaManga/1.0' }
      });
      const data = await r.json();
      if (!r.ok) throw new HttpError(r.status, (data && data.errors && data.errors[0] && data.errors[0].detail) || 'Gagal mengambil rating.');
      const stat = data && data.statistics && data.statistics[id];
      const raw = stat && stat.rating ? (stat.rating.bayesian || stat.rating.average || 0) : 0;
      const rating = Number(raw);
      return sendJson(res, 200, { rating: Number.isFinite(rating) ? Math.round(rating * 100) / 100 : 0 });
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
      enforceRateLimit(req, 'track', 120);
      await readBody(req);
      await recordTrack(requestViewerKey(req, sessionClaims(req)));
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
      enforceRateLimit(req, 'chapter-reaction', 120);
      const body = await readBody(req);
      const claims = await freshSessionClaims(req);
      const key = requestViewerKey(req, claims);
      let result;
      await updateCatalog((catalog) => { result = addChapterReaction(catalog, { ...body, voterId: key }); });
      if (result && result.userVote) {
        await awardProgress(claims, 'reaction', `chapter:${body.chapterId}`, 2);
      }
      return sendJson(res, 200, result);
    }

    if (route === 'manga/reaction' && req.method === 'POST') {
      enforceRateLimit(req, 'manga-reaction', 120);
      const body = await readBody(req);
      const claims = await freshSessionClaims(req);
      const key = requestViewerKey(req, claims);
      let result;
      await updateCatalog((catalog) => { result = addMangaReaction(catalog, { ...body, voterId: key }); });
      if (result && result.userVote) {
        await awardProgress(claims, 'reaction', `manga:${body.mangaId}`, 2);
      }
      return sendJson(res, 200, result);
    }

    if (route === 'comment/upvote' && req.method === 'POST') {
      enforceRateLimit(req, 'comment-upvote', 120);
      const body = await readBody(req);
      const key = requestViewerKey(req, await freshSessionClaims(req));
      let updated;
      await updateCatalog((catalog) => { updated = upvoteComment(catalog, { ...body, voterId: key }); });
      return sendJson(res, 200, { comment: sanitizeComment(updated, key) });
    }

    if (route === 'comment/image' && req.method === 'POST') {
      enforceRateLimit(req, 'comment-image', 20);
      const rawClaims = sessionClaims(req);
      const claims = await freshSessionClaims(req);
      if (!claims) throw new HttpError(401, rawClaims ? 'Akun tidak ditemukan atau sudah dihapus. Silakan masuk kembali.' : 'Masuk terlebih dahulu untuk mengunggah gambar.');
      const body = await readBody(req);
      const { mimeType, bytes } = decodeUpload(body.dataBase64);
      const fileId = await saveMedia(body.fileName || 'comment.jpg', mimeType, bytes);
      const url = `${apiBaseUrl()}/api/media/${encodeURIComponent(fileId)}`;
      return sendJson(res, 201, { url });
    }

    if (route === 'leaderboard' && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const requestedType = url.searchParams.get('type');
      const resolvedType = requestedType === 'anime' ? 'anime'
        : requestedType === 'users' ? 'users'
          : requestedType === 'both' ? 'both' : 'users';
      const range = ['day', 'week', 'month', 'all'].includes(url.searchParams.get('range'))
        ? url.searchParams.get('range')
        : 'week';
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 50));
      const users = resolvedType === 'anime' ? [] : await readLeaderboard(range, limit);
      let anime = [];
      if (resolvedType !== 'users') {
        let catalog;
        try {
          catalog = await readCatalog();
        } catch (error) {
          if (!(error instanceof CatalogNotInitializedError)) throw error;
          catalog = { manga: [] };
        }
        const factor = { day: 1 / 30, week: 1, month: 4, all: 8 }[range] || 1;
        anime = (catalog.manga || []).map((manga) => {
          const raw = Number(manga.views || manga.followers || 0);
          return {
            anime_id: manga.id || manga.slug || '',
            title: manga.title || '',
            poster: manga.coverBloggerUrl || manga.coverUrl || '',
            tmdb_poster: manga.tmdbPoster || '',
            backdrop: manga.backdrop || '',
            views: Math.max(1, Math.round(raw * factor)),
            all_time_views: Number(manga.allTimeViews || manga.all_time_views || raw),
            rank: 0
          };
        }).sort((a, b) => b.views - a.views).slice(0, limit).map((item, index) => {
          item.rank = index + 1;
          return item;
        });
      }
      return sendJson(res, 200, { range, type: resolvedType, page: 1, limit, users, anime });
    }

    if (route === 'catalog' && req.method === 'GET') {
      let catalog;
      try {
        catalog = await readCatalog();
      } catch (error) {
        if (!(error instanceof CatalogNotInitializedError)) throw error;
        catalog = { manga: [], chapters: [], comments: [], reports: [], users: [] };
      }
      enrichCommentsWithUsers(catalog);
      const claims = await freshSessionClaims(req);
      const showAllComments = Boolean(claims && claims.role === 'admin');
      const viewerKey = requestViewerKey(req, claims);
      return sendJson(res, 200, sanitizeCatalog(catalog, viewerKey, claims, showAllComments));
    }

    if (route === 'comment' && req.method === 'POST') {
      enforceRateLimit(req, 'comment', 15);
      const body = await readBody(req);
      const rawClaims = sessionClaims(req);
      const claims = await freshSessionClaims(req);
      if (rawClaims && !claims) {
        throw new HttpError(401, 'Akun tidak ditemukan atau sudah dihapus. Silakan masuk kembali.');
      }
      const key = requestViewerKey(req, claims);
      body.authorKey = key;
      if (claims) {
        body.userId = claims.sub;
        body.authorName = claims.user && claims.user.name ? claims.user.name : 'Pengguna';
        body.authorAvatar = claims.user && claims.user.avatar ? claims.user.avatar : null;
      } else {
        body.userId = null;
        body.authorName = 'Pengunjung';
        body.authorAvatar = null;
      }
      let created;
      await updateCatalog((catalog) => { created = addComment(catalog, body); });
      return sendJson(res, 201, { comment: sanitizeComment(created, key) });
    }

    if (route === 'report' && req.method === 'POST') {
      enforceRateLimit(req, 'report', 5);
      const body = await readBody(req);
      const rawClaims = sessionClaims(req);
      const claims = await freshSessionClaims(req);
      if (rawClaims && !claims) {
        throw new HttpError(401, 'Akun tidak ditemukan atau sudah dihapus. Silakan masuk kembali.');
      }
      body.reporterKey = requestViewerKey(req, claims);
      body.userId = claims ? claims.sub : null;
      let created;
      await updateCatalog((catalog) => { created = addReport(catalog, body); });
      return sendJson(res, 201, { ok: true, id: created.id });
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
      if (!['pending', 'approved', 'rejected'].includes(body.status)) {
        throw new HttpError(400, 'Status komentar harus pending, approved, atau rejected.');
      }
      let approved = null;
      await updateCatalog((catalog) => {
        const comment = catalog.comments.find((item) => item.id === body.id);
        if (!comment) throw new HttpError(404, 'Komentar tidak ditemukan.');
        comment.status = body.status;
        if (body.status === 'approved' && comment.userId) approved = comment;
      });
      if (approved) {
        try {
          await awardXp({
            userId: approved.userId,
            username: approved.authorName || 'Member',
            name: approved.authorName || 'Member',
            avatar: approved.authorAvatar || null,
            activity: 'comment_approved',
            refKey: approved.id,
            amount: 25
          });
        } catch (error) {
          console.error('[progress] gagal mencatat XP persetujuan komentar:', error && error.message ? error.message : error);
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/reports' && req.method === 'GET') {
      await requireAdmin(req);
      const catalog = await readCatalog();
      return sendJson(res, 200, { reports: catalog.reports || [] });
    }

    if (route === 'admin/report-status' && req.method === 'POST') {
      await requireAdmin(req);
      const body = await readBody(req);
      await updateCatalog((catalog) => setReportStatus(catalog, body));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'admin/delete-report' && req.method === 'POST') {
      await requireAdmin(req);
      const body = await readBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'ID laporan tidak valid.');
      await updateCatalog((catalog) => deleteReport(catalog, body));
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

    if (route === 'profile/upload-background' && req.method === 'POST') {
      const claims = await freshSessionClaims(req);
      if (!claims) throw new HttpError(401, 'Sesi akun tidak valid atau sudah berakhir. Silakan masuk kembali.');
      const body = await readBody(req);
      const { mimeType, bytes } = decodeUpload(body.dataBase64);
      const baseUrl = apiBaseUrl();
      const result = await uploadImage(body.fileName, mimeType, bytes, null, baseUrl);
      return sendJson(res, 201, {
        telegramFileId: result.fileId,
        url: result.url,
        telegramStatus: result.status,
        bloggerStatus: 'proxy aktif'
      });
    }

    if (route === 'admin/upload-dual' && req.method === 'POST') {
      await requireAdmin(req);
      const body = await readBody(req);
      const { mimeType, bytes } = decodeUpload(body.dataBase64);
      const baseUrl = apiBaseUrl();
      const result = await uploadImage(body.fileName, mimeType, bytes, null, baseUrl);
      return sendJson(res, 201, {
        telegramFileId: result.fileId,
        bloggerUrl: result.url,
        telegramStatus: result.status,
        bloggerStatus: 'proxy aktif'
      });
    }

    if (route.startsWith('media/') && req.method === 'GET') {
      const fileId = validatePathId(route.slice('media/'.length));
      const { bytes, filePath } = await getMedia(fileId);
      const contentType = mediaContentType(filePath, bytes);
      if (!contentType) throw new HttpError(415, 'Format media tidak didukung.');
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', bytes.length);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(bytes);
    }

    if (route === 'favicon.ico' && (req.method === 'GET' || req.method === 'HEAD')) {
      let settings = {};
      try {
        const catalog = await readCatalog();
        settings = catalog && catalog.settings ? catalog.settings : {};
      } catch (error) {
        settings = {};
      }
      const value = typeof settings.faviconUrl === 'string' ? settings.faviconUrl.trim() : '';
      if (!value) {
        res.statusCode = 204;
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.end();
      }
      const fileId = mediaFileId(value);
      if (fileId) {
        const media = await getMedia(fileId);
        const contentType = mediaContentType(media.filePath, media.bytes);
        if (!contentType) throw new HttpError(415, 'Format favicon tidak didukung.');
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', media.bytes.length);
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
        return res.end(req.method === 'HEAD' ? undefined : media.bytes);
      }
      if (/^https?:\/\//i.test(value)) {
        res.statusCode = 302;
        res.setHeader('Location', value);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.end();
      }
      res.statusCode = 204;
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end();
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
    if (/MySQL tidak didukung/.test(error.message)) return sendJson(res, 500, { error: error.message });
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


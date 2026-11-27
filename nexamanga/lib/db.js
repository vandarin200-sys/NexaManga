'use strict';

const { neon } = require('@neondatabase/serverless');
const { EMPTY_CATALOG, validateCatalog } = require('./catalog');
const { config } = require('./env');
const {
  XP_ACTIVITIES,
  normalizePublicSlug,
  normalizeUsername,
  progressFromXp,
  rangeSince,
  serializeProgress,
  uniquePublicSlug
} = require('./progress');

const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const CAS_MAX_ATTEMPTS = 5;
const MYSQL_ERROR = 'MySQL tidak didukung. NexaManga hanya mendukung PostgreSQL/Neon.';
const VISITOR_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const REACTION_KEYS = ['fire', 'shock', 'cry', 'laugh', 'angry'];
const ISOLATION_LEVELS = new Set(['read committed', 'repeatable read', 'serializable']);

class ConcurrentUpdateError extends Error {
  constructor() {
    super('Data berubah oleh request lain saat penyimpanan berlangsung. Silakan coba lagi.');
    this.name = 'ConcurrentUpdateError';
  }
}

class StorageAlreadyInitializedError extends Error {
  constructor(message = 'Database NexaManga sudah diinisialisasi pada tabel relasional.') {
    super(message);
    this.name = 'StorageAlreadyInitializedError';
  }
}

class CatalogNotInitializedError extends Error {
  constructor() {
    super('Database NexaManga belum diinisialisasi. Jalankan /api/admin/storage/init atau /api/admin/storage/migrate.');
    this.name = 'CatalogNotInitializedError';
  }
}

function rawDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (typeof raw !== 'string') return '';
  return raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'")))
    ? raw.slice(1, -1)
    : raw;
}

function assertPostgresUrl(value) {
  if (/^mysql2?:\/\//i.test(value)) throw new Error(MYSQL_ERROR);
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    throw new Error('DATABASE_URL harus berupa connection string PostgreSQL.');
  }
  return value;
}

function dbDriver() {
  const explicit = String(process.env.DB_DRIVER || '').toLowerCase();
  if (explicit === 'mysql' || explicit === 'mysql2') throw new Error(MYSQL_ERROR);
  const url = rawDatabaseUrl();
  if (/^mysql2?:\/\//i.test(url)) throw new Error(MYSQL_ERROR);
  if (explicit === 'pg' || explicit === 'postgres' || explicit === 'postgresql') return 'pg';
  if (explicit === 'neon') return 'neon';
  if (url) return 'neon';
  if (process.env.DB_HOST) {
    if (String(process.env.DB_PORT || '') === '3306') throw new Error(MYSQL_ERROR);
    return 'pg';
  }
  return 'neon';
}

function databaseUrl() {
  const url = rawDatabaseUrl();
  if (url) return assertPostgresUrl(url);
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT;
  const name = process.env.DB_NAME || process.env.DB_DATABASE;
  const user = process.env.DB_USER || process.env.DB_USERNAME;
  const password = process.env.DB_PASSWORD;
  if (host && name && user) {
    const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
    return assertPostgresUrl(`postgresql://${auth}@${host}:${port || '5432'}/${name}`);
  }
  return assertPostgresUrl(config('DATABASE_URL'));
}

let client = null;
let pool = null;
let pgExecutor = null;

function buildPgQuery(strings, values) {
  let text = '';
  strings.forEach((str, index) => {
    text += str;
    if (index < values.length) text += `$${index + 1}`;
  });
  return { text, values };
}

function makeQuery(query, params, runner) {
  return {
    query,
    params,
    then(onFulfilled, onRejected) {
      return runner(query, params).then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return this.then(undefined, onRejected);
    },
    finally(onFinally) {
      return this.then(
        (value) => {
          if (onFinally) onFinally();
          return value;
        },
        (error) => {
          if (onFinally) onFinally();
          throw error;
        }
      );
    }
  };
}

function makeTag(runner) {
  function tag(strings, ...values) {
    const built = buildPgQuery(strings, values);
    return makeQuery(built.text, built.values, runner);
  }
  tag.query = (text, params = []) => makeQuery(text, params, runner);
  return tag;
}

function createPgExecutor() {
  if (pgExecutor) return pgExecutor;
  if (!pool) {
    const { Pool } = require('pg');
    const url = databaseUrl();
    pool = new Pool({
      connectionString: url,
      ssl: /sslmode=require/i.test(url) ? { rejectUnauthorized: false } : undefined
    });
  }
  const runPool = (text, params) => pool.query(text, params).then((result) => result.rows || []);
  const executor = makeTag(runPool);
  executor.transaction = async (fn, options = {}) => {
    const connection = await pool.connect();
    const runTransaction = (text, params) => connection.query(text, params).then((result) => result.rows || []);
    const tx = makeTag(runTransaction);
    try {
      await connection.query('BEGIN');
      const isolationLevel = String(options.isolationLevel || '').toLowerCase();
      if (ISOLATION_LEVELS.has(isolationLevel)) {
        await connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
      }
      const result = await fn(tx);
      if (Array.isArray(result)) {
        const results = [];
        for (const query of result) {
          results.push(query ? await runTransaction(query.query, query.params) : []);
        }
        await connection.query('COMMIT');
        return results;
      }
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      connection.release();
    }
  };
  pgExecutor = executor;
  return executor;
}

function executor() {
  if (dbDriver() === 'pg') return createPgExecutor();
  if (!client) client = neon(databaseUrl());
  return client;
}

function transactionIsolationLevel() {
  return dbDriver() === 'pg' ? 'repeatable read' : 'RepeatableRead';
}

let schemaPromise = null;

function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = executor();
      await db`CREATE TABLE IF NOT EXISTS nexamanga_catalog_state (
        id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        initialized boolean NOT NULL DEFAULT false,
        revision bigint NOT NULL DEFAULT 0,
        legacy_version bigint,
        migrated_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await db`INSERT INTO nexamanga_catalog_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_manga (
        id text PRIMARY KEY,
        slug text UNIQUE NOT NULL,
        title text NOT NULL,
        alt_title text,
        author text,
        synopsis text NOT NULL,
        cover_blogger_url text,
        type text,
        status text,
        rating numeric,
        release_year integer,
        featured boolean NOT NULL DEFAULT false,
        recommended boolean NOT NULL DEFAULT false,
        is_adult boolean NOT NULL DEFAULT false,
        views bigint NOT NULL DEFAULT 0,
        updated_at date,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_manga_genres (
        manga_id text NOT NULL REFERENCES nexamanga_manga(id) ON DELETE CASCADE,
        genre text NOT NULL,
        sort_order integer NOT NULL,
        PRIMARY KEY (manga_id, genre)
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_chapters (
        id text PRIMARY KEY,
        manga_id text NOT NULL REFERENCES nexamanga_manga(id) ON DELETE CASCADE,
        number numeric NOT NULL,
        title text,
        published_at date,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (manga_id, number)
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_chapter_pages (
        id bigserial PRIMARY KEY,
        chapter_id text NOT NULL REFERENCES nexamanga_chapters(id) ON DELETE CASCADE,
        sort_order integer NOT NULL,
        file_name text,
        blogger_url text,
        telegram_file_id text,
        status text,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (chapter_id, sort_order)
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_comments (
        id text PRIMARY KEY,
        manga_id text NOT NULL REFERENCES nexamanga_manga(id) ON DELETE CASCADE,
        chapter_id text REFERENCES nexamanga_chapters(id) ON DELETE SET NULL,
        parent_id text,
        reply_to text,
        image_url text,
        user_id text,
        author_key text,
        author_name text NOT NULL,
        author_avatar text,
        content text NOT NULL,
        created_at date NOT NULL DEFAULT CURRENT_DATE,
        status text NOT NULL DEFAULT 'pending',
        pinned boolean,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb
      )`;
      await db`ALTER TABLE nexamanga_comments DROP CONSTRAINT IF EXISTS nexamanga_comments_parent_id_fkey`;
      await db`ALTER TABLE nexamanga_comments ALTER COLUMN pinned DROP NOT NULL`;
      await db`ALTER TABLE nexamanga_comments ALTER COLUMN pinned DROP DEFAULT`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_comment_upvotes (
        comment_id text NOT NULL REFERENCES nexamanga_comments(id) ON DELETE CASCADE,
        voter_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (comment_id, voter_id)
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_reports (
        id text PRIMARY KEY,
        manga_id text NOT NULL,
        chapter_id text NOT NULL,
        manga_title text,
        chapter_number text,
        reason text NOT NULL,
        detail text NOT NULL DEFAULT '',
        user_id text,
        reporter_key text,
        created_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'open',
        extra jsonb NOT NULL DEFAULT '{}'::jsonb
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_accounts (
        id text PRIMARY KEY,
        provider text NOT NULL,
        provider_id text NOT NULL,
        name text NOT NULL,
        email text,
        avatar text,
        role text NOT NULL DEFAULT 'member',
        public_slug text,
        created_at timestamptz NOT NULL,
        email_verified boolean NOT NULL DEFAULT false,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (provider, provider_id)
      )`;
      await db`ALTER TABLE nexamanga_accounts ADD COLUMN IF NOT EXISTS public_slug text`;
      await db`CREATE UNIQUE INDEX IF NOT EXISTS nexamanga_accounts_public_slug_idx ON nexamanga_accounts (public_slug)`;
      const existingSlugs = new Set(rows(await db`SELECT public_slug FROM nexamanga_accounts WHERE public_slug IS NOT NULL AND public_slug <> ''`).map((row) => String(row.public_slug)));
      const missingSlugRows = rows(await db`SELECT id FROM nexamanga_accounts WHERE public_slug IS NULL OR public_slug = '' ORDER BY id`);
      for (const row of missingSlugRows) {
        const slug = uniquePublicSlug(String(row.id), existingSlugs);
        const updated = rows(await db`UPDATE nexamanga_accounts SET public_slug = ${slug} WHERE id = ${row.id} AND (public_slug IS NULL OR public_slug = '') RETURNING public_slug`);
        if (updated.length) existingSlugs.add(slug);
      }
      await db`DROP INDEX IF EXISTS nexamanga_accounts_email_lower_idx`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_account_credentials (
        account_id text PRIMARY KEY REFERENCES nexamanga_accounts(id) ON DELETE CASCADE,
        password_hash text,
        password_salt text,
        verification_hash text,
        verification_salt text,
        verification_expires_at timestamptz,
        verification_attempts integer NOT NULL DEFAULT 0
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_account_connections (
        account_id text NOT NULL REFERENCES nexamanga_accounts(id) ON DELETE CASCADE,
        provider text NOT NULL,
        connected boolean NOT NULL DEFAULT false,
        provider_id text,
        username text,
        access_token text,
        updated_at timestamptz,
        last_synced_at timestamptz,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (account_id, provider)
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_user_progress (
        user_id text PRIMARY KEY REFERENCES nexamanga_accounts(id) ON DELETE CASCADE,
        username text NOT NULL,
        name text NOT NULL,
        avatar text,
        xp bigint NOT NULL DEFAULT 0,
        level integer NOT NULL DEFAULT 1,
        streak_days integer NOT NULL DEFAULT 0,
        last_active_date date,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_xp_events (
        id bigserial PRIMARY KEY,
        user_id text NOT NULL REFERENCES nexamanga_user_progress(user_id) ON DELETE CASCADE,
        activity text NOT NULL,
        ref_key text NOT NULL DEFAULT '',
        amount integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, activity, ref_key)
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_manga_view_events (
        id bigserial PRIMARY KEY,
        manga_id text NOT NULL REFERENCES nexamanga_manga(id) ON DELETE CASCADE,
        viewer_key text NOT NULL,
        day date NOT NULL DEFAULT CURRENT_DATE,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (manga_id, viewer_key, day)
      )`;
      await db`INSERT INTO nexamanga_user_progress (user_id, username, name, avatar)
        SELECT a.id,
          COALESCE(NULLIF(regexp_replace(lower(COALESCE(NULLIF(a.name, ''), 'member')), '[^a-z0-9_]', '', 'g'), ''), 'member'),
          a.name, a.avatar
        FROM nexamanga_accounts a
        ON CONFLICT (user_id) DO NOTHING`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_chapter_reactions (
        chapter_id text NOT NULL REFERENCES nexamanga_chapters(id) ON DELETE CASCADE,
        voter_id text NOT NULL,
        reaction text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (chapter_id, voter_id)
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_manga_reactions (
        manga_id text NOT NULL REFERENCES nexamanga_manga(id) ON DELETE CASCADE,
        voter_id text NOT NULL,
        reaction text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (manga_id, voter_id)
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_settings (
        key text PRIMARY KEY,
        value text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_analytics_days (
        day date PRIMARY KEY,
        pageviews bigint NOT NULL DEFAULT 0,
        visits bigint NOT NULL DEFAULT 0
      )`;
      await db`CREATE TABLE IF NOT EXISTS nexamanga_analytics_visitors (
        day date NOT NULL REFERENCES nexamanga_analytics_days(day) ON DELETE CASCADE,
        visitor_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (day, visitor_id)
      )`;
      await db`CREATE INDEX IF NOT EXISTS nexamanga_chapters_manga_id_idx ON nexamanga_chapters (manga_id)`;
      await db`CREATE INDEX IF NOT EXISTS nexamanga_comments_manga_created_idx ON nexamanga_comments (manga_id, created_at DESC)`;
      await db`CREATE INDEX IF NOT EXISTS nexamanga_comments_chapter_id_idx ON nexamanga_comments (chapter_id)`;
      await db`CREATE INDEX IF NOT EXISTS nexamanga_comments_status_idx ON nexamanga_comments (status)`;
      await db`CREATE INDEX IF NOT EXISTS nexamanga_reports_status_created_idx ON nexamanga_reports (status, created_at DESC)`;
      await db`CREATE INDEX IF NOT EXISTS nexamanga_analytics_visitors_day_created_idx ON nexamanga_analytics_visitors (day, created_at DESC)`;
      await db`CREATE INDEX IF NOT EXISTS nexamanga_user_progress_xp_idx ON nexamanga_user_progress (xp DESC)`;
      await db`CREATE INDEX IF NOT EXISTS nexamanga_user_progress_username_idx ON nexamanga_user_progress (username)`;
      await db`CREATE INDEX IF NOT EXISTS nexamanga_xp_events_created_idx ON nexamanga_xp_events (created_at DESC)`;
      await db`CREATE INDEX IF NOT EXISTS nexamanga_manga_view_events_manga_created_idx ON nexamanga_manga_view_events (manga_id, created_at DESC)`;
      await db`CREATE INDEX IF NOT EXISTS nexamanga_manga_view_events_created_idx ON nexamanga_manga_view_events (created_at DESC)`;
      await db`CREATE OR REPLACE VIEW nexamanga_users AS
        SELECT a.id, a.public_slug, a.name, a.email, a.avatar, a.provider, a.role,
          a.created_at::text AS created_at,
          COALESCE(p.xp, 0) AS xp,
          COALESCE(p.level, 1) AS level,
          COALESCE(p.streak_days, 0) AS streak_days
        FROM nexamanga_accounts a
        LEFT JOIN nexamanga_user_progress p ON p.user_id = a.id`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function rows(result) {
  return Array.isArray(result) ? result : [];
}

function firstRow(result) {
  return rows(result)[0] || null;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateString(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timestampString(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function numberValue(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textValue(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function parseJson(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extraOf(item, knownKeys) {
  const extra = {};
  if (!item || typeof item !== 'object' || Array.isArray(item)) return extra;
  const known = new Set(knownKeys);
  for (const [key, value] of Object.entries(item)) {
    if (!known.has(key) && value !== undefined) extra[key] = value;
  }
  return extra;
}

function jsonParam(value) {
  return JSON.stringify(value || {});
}

const MANGA_KEYS = [
  'id', 'slug', 'title', 'altTitle', 'author', 'synopsis', 'coverBloggerUrl', 'type',
  'status', 'rating', 'releaseYear', 'featured', 'recommended', 'isAdult', 'views',
  'updatedAt', 'genres'
];
const CHAPTER_KEYS = ['id', 'mangaId', 'number', 'title', 'publishedAt', 'pages'];
const PAGE_KEYS = ['order', 'fileName', 'bloggerUrl', 'telegramFileId', 'status'];
const COMMENT_KEYS = [
  'id', 'mangaId', 'chapterId', 'parentId', 'replyTo', 'imageUrl', 'userId',
  'authorKey', 'authorName', 'authorAvatar', 'content', 'createdAt', 'status',
  'upvotes', 'pinned'
];
const REPORT_KEYS = [
  'id', 'mangaId', 'chapterId', 'mangaTitle', 'chapterNumber', 'reason', 'detail',
  'userId', 'reporterKey', 'createdAt', 'status'
];
const USER_KEYS = [
  'id', 'publicSlug', 'provider', 'providerId', 'name', 'email', 'avatar', 'role', 'createdAt',
  'emailVerified', 'passwordHash', 'passwordSalt', 'emailVerification', 'connections'
];
const CONNECTION_KEYS = [
  'connected', 'providerId', 'username', 'accessToken', 'updatedAt', 'lastSyncedAt'
];

function catalogQueries(tx) {
  return [
    tx`SELECT initialized, revision FROM nexamanga_catalog_state WHERE id = 1`,
    tx`SELECT * FROM nexamanga_manga ORDER BY id`,
    tx`SELECT manga_id, genre FROM nexamanga_manga_genres ORDER BY manga_id, sort_order`,
    tx`SELECT * FROM nexamanga_chapters ORDER BY manga_id, number, id`,
    tx`SELECT * FROM nexamanga_chapter_pages ORDER BY chapter_id, sort_order`,
    tx`SELECT * FROM nexamanga_comments ORDER BY created_at DESC, id`,
    tx`SELECT comment_id, voter_id FROM nexamanga_comment_upvotes ORDER BY comment_id, voter_id`,
    tx`SELECT * FROM nexamanga_reports ORDER BY created_at DESC, id`,
    tx`SELECT * FROM nexamanga_accounts ORDER BY created_at, id`,
    tx`SELECT * FROM nexamanga_account_credentials`,
    tx`SELECT * FROM nexamanga_account_connections ORDER BY account_id, provider`,
    tx`SELECT key, value FROM nexamanga_settings ORDER BY key`,
    tx`SELECT chapter_id, voter_id, reaction FROM nexamanga_chapter_reactions`,
    tx`SELECT manga_id, voter_id, reaction FROM nexamanga_manga_reactions`
  ];
}

function groupBy(list, key) {
  const map = new Map();
  for (const row of rows(list)) {
    const id = row[key];
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

function emptyReactionGroups() {
  const groups = {};
  for (const key of REACTION_KEYS) groups[key] = [];
  return groups;
}

function assembleReactions(list, targetKey) {
  const output = {};
  for (const row of rows(list)) {
    const targetId = row[targetKey];
    if (!targetId || !REACTION_KEYS.includes(row.reaction)) continue;
    if (!output[targetId]) output[targetId] = emptyReactionGroups();
    const voters = output[targetId][row.reaction];
    if (!voters.includes(row.voter_id)) voters.push(row.voter_id);
  }
  for (const groups of Object.values(output)) {
    for (const key of REACTION_KEYS) groups[key].sort();
  }
  return output;
}

function assembleCatalog(results) {
  const genreMap = groupBy(results[2], 'manga_id');
  const pageMap = groupBy(results[4], 'chapter_id');
  const upvoteMap = groupBy(results[6], 'comment_id');
  const credentialMap = new Map(rows(results[9]).map((row) => [row.account_id, row]));
  const connectionMap = groupBy(results[10], 'account_id');

  const manga = rows(results[1]).map((row) => {
    const extra = parseJson(row.extra);
    const genres = (genreMap.get(row.id) || []).map((item) => item.genre);
    return {
      ...extra,
      id: row.id,
      slug: row.slug,
      title: row.title,
      altTitle: row.alt_title,
      author: row.author,
      synopsis: row.synopsis,
      coverBloggerUrl: row.cover_blogger_url,
      type: row.type,
      status: row.status,
      rating: nullableNumber(row.rating),
      releaseYear: row.release_year === null || row.release_year === undefined ? null : Number(row.release_year),
      featured: Boolean(row.featured),
      recommended: Boolean(row.recommended),
      isAdult: Boolean(row.is_adult),
      views: numberValue(row.views),
      updatedAt: dateString(row.updated_at),
      genres
    };
  });

  const chapters = rows(results[3]).map((row) => {
    const extra = parseJson(row.extra);
    const pages = (pageMap.get(row.id) || []).map((page) => {
      const pageExtra = parseJson(page.extra);
      return {
        ...pageExtra,
        order: page.sort_order,
        fileName: page.file_name,
        bloggerUrl: page.blogger_url,
        telegramFileId: page.telegram_file_id,
        status: page.status
      };
    });
    return {
      ...extra,
      id: row.id,
      mangaId: row.manga_id,
      number: numberValue(row.number),
      title: row.title,
      publishedAt: dateString(row.published_at),
      pages
    };
  });

  const comments = rows(results[5]).map((row) => {
    const extra = parseJson(row.extra);
    const comment = {
      ...extra,
      id: row.id,
      mangaId: row.manga_id,
      chapterId: row.chapter_id,
      parentId: row.parent_id,
      replyTo: row.reply_to,
      imageUrl: row.image_url,
      userId: row.user_id,
      authorKey: row.author_key,
      authorName: row.author_name,
      authorAvatar: row.author_avatar,
      content: row.content,
      createdAt: dateString(row.created_at),
      status: row.status,
      upvotes: (upvoteMap.get(row.id) || []).map((item) => item.voter_id).sort()
    };
    if (row.pinned !== null && row.pinned !== undefined) comment.pinned = Boolean(row.pinned);
    return comment;
  });

  const reports = rows(results[7]).map((row) => {
    const extra = parseJson(row.extra);
    return {
      ...extra,
      id: row.id,
      mangaId: row.manga_id,
      chapterId: row.chapter_id,
      mangaTitle: row.manga_title,
      chapterNumber: row.chapter_number,
      reason: row.reason,
      detail: row.detail,
      userId: row.user_id,
      reporterKey: row.reporter_key,
      createdAt: timestampString(row.created_at),
      status: row.status
    };
  });

  const users = rows(results[8]).map((row) => {
    const extra = parseJson(row.extra);
    const credentials = credentialMap.get(row.id) || null;
    const user = {
      ...extra,
      id: row.id,
      publicSlug: row.public_slug || null,
      provider: row.provider,
      providerId: row.provider_id,
      name: row.name,
      email: row.email,
      avatar: row.avatar,
      role: row.role,
      createdAt: timestampString(row.created_at),
      emailVerified: Boolean(row.email_verified)
    };
    if (credentials) {
      if (credentials.password_hash !== null && credentials.password_hash !== undefined) {
        user.passwordHash = credentials.password_hash;
      }
      if (credentials.password_salt !== null && credentials.password_salt !== undefined) {
        user.passwordSalt = credentials.password_salt;
      }
      if (credentials.verification_hash !== null && credentials.verification_hash !== undefined) {
        user.emailVerification = {
          hash: credentials.verification_hash,
          salt: credentials.verification_salt,
          expiresAt: timestampString(credentials.verification_expires_at),
          attempts: numberValue(credentials.verification_attempts)
        };
      }
    }
    const connections = {};
    for (const item of connectionMap.get(row.id) || []) {
      if (item.connected !== true && typeof item.access_token !== 'string') continue;
      const itemExtra = parseJson(item.extra);
      const connection = { ...itemExtra };
      connection.connected = Boolean(item.connected) || typeof item.access_token === 'string';
      if (item.provider_id !== null && item.provider_id !== undefined) connection.providerId = item.provider_id;
      if (item.username !== null && item.username !== undefined) connection.username = item.username;
      if (item.access_token !== null && item.access_token !== undefined) connection.accessToken = item.access_token;
      if (item.updated_at !== null && item.updated_at !== undefined) connection.updatedAt = timestampString(item.updated_at);
      if (item.last_synced_at !== null && item.last_synced_at !== undefined) connection.lastSyncedAt = timestampString(item.last_synced_at);
      connections[item.provider] = connection;
    }
    user.connections = connections;
    return user;
  });

  const settings = {};
  for (const row of rows(results[11])) settings[row.key] = row.value;

  return {
    manga,
    chapters,
    comments,
    reports,
    users,
    settings,
    reactions: assembleReactions(results[12], 'chapter_id'),
    mangaReactions: assembleReactions(results[13], 'manga_id')
  };
}

function guardedLock(tx, revision, initialized) {
  return tx.query(
    'SELECT 1 FROM nexamanga_catalog_state WHERE id = 1 AND revision = $1 AND initialized = $2 FOR UPDATE',
    [revision, initialized]
  );
}

function guardedDelete(tx, table, revision, initialized) {
  return tx.query(
    `WITH guard AS (SELECT 1 FROM nexamanga_catalog_state WHERE id = 1 AND revision = $1 AND initialized = $2 FOR UPDATE)
     DELETE FROM ${table} WHERE EXISTS (SELECT 1 FROM guard)`,
    [revision, initialized]
  );
}

function insertBatches(dataRows, width) {
  if (!dataRows.length) return [];
  const batchSize = Math.max(1, Math.floor((60000 - 2) / Math.max(width, 1)));
  const batches = [];
  for (let index = 0; index < dataRows.length; index += batchSize) {
    batches.push(dataRows.slice(index, index + batchSize));
  }
  return batches;
}

const INSERT_COLUMN_TYPES = {
  nexamanga_manga: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'numeric', 'integer', 'boolean', 'boolean', 'boolean', 'bigint', 'date', 'jsonb'],
  nexamanga_manga_genres: ['text', 'text', 'integer'],
  nexamanga_chapters: ['text', 'text', 'numeric', 'text', 'date', 'jsonb'],
  nexamanga_chapter_pages: ['text', 'integer', 'text', 'text', 'text', 'text', 'jsonb'],
  nexamanga_comments: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'date', 'text', 'boolean', 'jsonb'],
  nexamanga_comment_upvotes: ['text', 'text'],
  nexamanga_reports: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamptz', 'text', 'jsonb'],
  nexamanga_accounts: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'timestamptz', 'boolean', 'jsonb'],
  nexamanga_account_credentials: ['text', 'text', 'text', 'text', 'text', 'timestamptz', 'integer'],
  nexamanga_account_connections: ['text', 'text', 'boolean', 'text', 'text', 'text', 'timestamptz', 'timestamptz', 'jsonb'],
  nexamanga_chapter_reactions: ['text', 'text', 'text'],
  nexamanga_manga_reactions: ['text', 'text', 'text'],
  nexamanga_settings: ['text', 'text']
};

function guardedInsert(tx, table, columns, dataRows, revision, initialized) {
  if (!dataRows.length) return null;
  const params = dataRows.flat();
  const revisionPlaceholder = `$${params.length + 1}`;
  const initializedPlaceholder = `$${params.length + 2}`;
  const width = dataRows[0].length;
  const types = INSERT_COLUMN_TYPES[table] || columns.map(() => 'text');
  const selects = dataRows.map((row, rowIndex) => {
    const values = row.map((_, index) => `$${rowIndex * width + index + 1}::${types[index] || 'text'}`).join(', ');
    return `SELECT ${values} FROM guard`;
  }).join(' UNION ALL ');
  return tx.query(
    `WITH guard AS (SELECT 1 FROM nexamanga_catalog_state WHERE id = 1 AND revision = ${revisionPlaceholder} AND initialized = ${initializedPlaceholder} FOR UPDATE)
     INSERT INTO ${table} (${columns.join(', ')}) ${selects}`,
    [...params, revision, initialized]
  );
}

function replaceCatalog(tx, catalog, revision, initialized) {
  const queries = [guardedLock(tx, revision, initialized)];
  const deletes = [
    'nexamanga_chapter_reactions',
    'nexamanga_manga_reactions',
    'nexamanga_comment_upvotes',
    'nexamanga_chapter_pages',
    'nexamanga_comments',
    'nexamanga_reports',
    'nexamanga_chapters',
    'nexamanga_manga_genres',
    'nexamanga_manga',
    'nexamanga_account_connections',
    'nexamanga_account_credentials',
    'nexamanga_accounts',
    'nexamanga_settings'
  ];
  for (const table of deletes) queries.push(guardedDelete(tx, table, revision, initialized));
  const mangaRows = [];
  const genreRows = [];
  const chapterRows = [];
  const pageRows = [];
  const commentRows = [];
  const upvoteRows = [];
  const reportRows = [];
  const accountRows = [];
  const credentialRows = [];
  const connectionRows = [];
  const chapterReactionRows = [];
  const mangaReactionRows = [];
  const settingRows = [];

  for (const item of catalog.manga || []) {
    mangaRows.push([
      textValue(item.id),
      textValue(item.slug),
      textValue(item.title),
      item.altTitle === undefined ? null : textValue(item.altTitle, null),
      item.author === undefined ? null : textValue(item.author, null),
      textValue(item.synopsis),
      item.coverBloggerUrl === undefined ? null : textValue(item.coverBloggerUrl, null),
      item.type === undefined ? null : textValue(item.type, null),
      item.status === undefined ? null : textValue(item.status, null),
      nullableNumber(item.rating),
      nullableNumber(item.releaseYear),
      Boolean(item.featured),
      Boolean(item.recommended),
      Boolean(item.isAdult),
      numberValue(item.views),
      dateString(item.updatedAt),
      jsonParam(extraOf(item, MANGA_KEYS))
    ]);
    const seen = new Set();
    for (const genre of Array.isArray(item.genres) ? item.genres : []) {
      const name = textValue(genre);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      genreRows.push([textValue(item.id), name, seen.size - 1]);
    }
  }
  for (const item of catalog.chapters || []) {
    chapterRows.push([
      textValue(item.id),
      textValue(item.mangaId),
      nullableNumber(item.number) ?? 0,
      item.title === undefined ? null : textValue(item.title, null),
      dateString(item.publishedAt),
      jsonParam(extraOf(item, CHAPTER_KEYS))
    ]);
    const pages = Array.isArray(item.pages) ? item.pages : [];
    pages.forEach((page, index) => {
      pageRows.push([
        textValue(item.id),
        page && page.order !== undefined ? numberValue(page.order, index + 1) : index + 1,
        page && page.fileName !== undefined ? textValue(page.fileName, null) : null,
        page && page.bloggerUrl !== undefined ? textValue(page.bloggerUrl, null) : null,
        page && page.telegramFileId !== undefined ? textValue(page.telegramFileId, null) : null,
        page && page.status !== undefined ? textValue(page.status, null) : null,
        jsonParam(extraOf(page, PAGE_KEYS))
      ]);
    });
  }
  for (const item of catalog.comments || []) {
    commentRows.push([
      textValue(item.id),
      textValue(item.mangaId),
      item.chapterId ? textValue(item.chapterId, null) : null,
      item.parentId ? textValue(item.parentId, null) : null,
      item.replyTo === undefined ? null : textValue(item.replyTo, null),
      item.imageUrl === undefined ? null : textValue(item.imageUrl, null),
      item.userId ? textValue(item.userId, null) : null,
      item.authorKey === undefined ? null : textValue(item.authorKey, null),
      textValue(item.authorName, 'Pengunjung'),
      item.authorAvatar === undefined ? null : textValue(item.authorAvatar, null),
      textValue(item.content),
      dateString(item.createdAt) || new Date().toISOString().slice(0, 10),
      textValue(item.status, 'pending'),
      item.pinned === undefined ? null : Boolean(item.pinned),
      jsonParam(extraOf(item, COMMENT_KEYS))
    ]);
    const seenUpvotes = new Set();
    for (const voterId of Array.isArray(item.upvotes) ? item.upvotes : []) {
      const id = textValue(voterId);
      if (!id || seenUpvotes.has(id)) continue;
      seenUpvotes.add(id);
      upvoteRows.push([textValue(item.id), id]);
    }
  }
  for (const item of catalog.reports || []) {
    reportRows.push([
      textValue(item.id),
      textValue(item.mangaId),
      textValue(item.chapterId),
      item.mangaTitle === undefined ? null : textValue(item.mangaTitle, null),
      item.chapterNumber === undefined ? null : textValue(item.chapterNumber, null),
      textValue(item.reason),
      textValue(item.detail, ''),
      item.userId ? textValue(item.userId, null) : null,
      item.reporterKey === undefined ? null : textValue(item.reporterKey, null),
      timestampString(item.createdAt) || new Date().toISOString(),
      textValue(item.status, 'open'),
      jsonParam(extraOf(item, REPORT_KEYS))
    ]);
  }
  for (const item of catalog.users || []) {
    accountRows.push([
      textValue(item.id),
      item.publicSlug === undefined ? null : textValue(item.publicSlug, null),
      textValue(item.provider),
      textValue(item.providerId),
      textValue(item.name),
      item.email === undefined ? null : textValue(item.email, null),
      item.avatar === undefined ? null : textValue(item.avatar, null),
      textValue(item.role, 'member'),
      timestampString(item.createdAt) || new Date().toISOString(),
      Boolean(item.emailVerified),
      jsonParam(extraOf(item, USER_KEYS))
    ]);
    credentialRows.push([
      textValue(item.id),
      item.passwordHash === undefined ? null : textValue(item.passwordHash, null),
      item.passwordSalt === undefined ? null : textValue(item.passwordSalt, null),
      item.emailVerification && item.emailVerification.hash !== undefined
        ? textValue(item.emailVerification.hash, null)
        : null,
      item.emailVerification && item.emailVerification.salt !== undefined
        ? textValue(item.emailVerification.salt, null)
        : null,
      item.emailVerification && item.emailVerification.expiresAt !== undefined
        ? timestampString(item.emailVerification.expiresAt)
        : null,
      item.emailVerification ? numberValue(item.emailVerification.attempts) : 0
    ]);
    const connections = item.connections && typeof item.connections === 'object' && !Array.isArray(item.connections)
      ? item.connections
      : {};
    for (const [provider, connection] of Object.entries(connections)) {
      if (!connection || typeof connection !== 'object' || Array.isArray(connection)) continue;
      connectionRows.push([
        textValue(item.id),
        textValue(provider),
        Boolean(connection.connected) || typeof connection.accessToken === 'string',
        connection.providerId === undefined ? null : textValue(connection.providerId, null),
        connection.username === undefined ? null : textValue(connection.username, null),
        connection.accessToken === undefined ? null : textValue(connection.accessToken, null),
        connection.updatedAt === undefined ? null : timestampString(connection.updatedAt),
        connection.lastSyncedAt === undefined ? null : timestampString(connection.lastSyncedAt),
        jsonParam(extraOf(connection, CONNECTION_KEYS))
      ]);
    }
  }
  for (const [targetId, groups] of Object.entries(catalog.reactions || {})) {
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
    const voters = new Map();
    for (const key of REACTION_KEYS) {
      for (const voterId of Array.isArray(groups[key]) ? groups[key] : []) {
        voters.set(textValue(voterId), key);
      }
    }
    for (const [voterId, reaction] of voters) {
      chapterReactionRows.push([textValue(targetId), voterId, reaction]);
    }
  }
  for (const [targetId, groups] of Object.entries(catalog.mangaReactions || {})) {
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
    const voters = new Map();
    for (const key of REACTION_KEYS) {
      for (const voterId of Array.isArray(groups[key]) ? groups[key] : []) {
        voters.set(textValue(voterId), key);
      }
    }
    for (const [voterId, reaction] of voters) {
      mangaReactionRows.push([textValue(targetId), voterId, reaction]);
    }
  }
  for (const [key, value] of Object.entries(catalog.settings || {})) {
    settingRows.push([textValue(key), textValue(value)]);
  }

  const inserts = [
    ['nexamanga_manga', ['id', 'slug', 'title', 'alt_title', 'author', 'synopsis', 'cover_blogger_url', 'type', 'status', 'rating', 'release_year', 'featured', 'recommended', 'is_adult', 'views', 'updated_at', 'extra'], mangaRows],
    ['nexamanga_manga_genres', ['manga_id', 'genre', 'sort_order'], genreRows],
    ['nexamanga_chapters', ['id', 'manga_id', 'number', 'title', 'published_at', 'extra'], chapterRows],
    ['nexamanga_chapter_pages', ['chapter_id', 'sort_order', 'file_name', 'blogger_url', 'telegram_file_id', 'status', 'extra'], pageRows],
    ['nexamanga_comments', ['id', 'manga_id', 'chapter_id', 'parent_id', 'reply_to', 'image_url', 'user_id', 'author_key', 'author_name', 'author_avatar', 'content', 'created_at', 'status', 'pinned', 'extra'], commentRows],
    ['nexamanga_comment_upvotes', ['comment_id', 'voter_id'], upvoteRows],
    ['nexamanga_reports', ['id', 'manga_id', 'chapter_id', 'manga_title', 'chapter_number', 'reason', 'detail', 'user_id', 'reporter_key', 'created_at', 'status', 'extra'], reportRows],
    ['nexamanga_accounts', ['id', 'public_slug', 'provider', 'provider_id', 'name', 'email', 'avatar', 'role', 'created_at', 'email_verified', 'extra'], accountRows],
    ['nexamanga_account_credentials', ['account_id', 'password_hash', 'password_salt', 'verification_hash', 'verification_salt', 'verification_expires_at', 'verification_attempts'], credentialRows],
    ['nexamanga_account_connections', ['account_id', 'provider', 'connected', 'provider_id', 'username', 'access_token', 'updated_at', 'last_synced_at', 'extra'], connectionRows],
    ['nexamanga_chapter_reactions', ['chapter_id', 'voter_id', 'reaction'], chapterReactionRows],
    ['nexamanga_manga_reactions', ['manga_id', 'voter_id', 'reaction'], mangaReactionRows],
    ['nexamanga_settings', ['key', 'value'], settingRows]
  ];
  for (const [table, columns, dataRows] of inserts) {
    for (const batch of insertBatches(dataRows, columns.length)) {
      const query = guardedInsert(tx, table, columns, batch, revision, initialized);
      if (query) queries.push(query);
    }
  }
  return queries;
}

function commitResult(results) {
  if (!results.length) return false;
  return rows(results[results.length - 1]).length === 1;
}

async function readStateRow() {
  const executorDb = executor();
  const result = await executorDb`SELECT initialized, revision FROM nexamanga_catalog_state WHERE id = 1`;
  return firstRow(result) || { initialized: false, revision: 0 };
}

async function readCatalog() {
  await ensureSchema();
  const db = executor();
  let results = await db.transaction((tx) => catalogQueries(tx), { isolationLevel: transactionIsolationLevel() });
  let state = firstRow(results[0]);
  if (!state || !state.initialized) {
    await migrateLegacyCatalog();
    results = await db.transaction((tx) => catalogQueries(tx), { isolationLevel: transactionIsolationLevel() });
    state = firstRow(results[0]);
    if (!state || !state.initialized) throw new CatalogNotInitializedError();
  }
  return assembleCatalog(results);
}

async function initializeCatalog(catalog, options = {}) {
  await ensureSchema();
  validateCatalog(catalog);
  if (!options.allowLegacyOverwrite && await legacySnapshotExists()) {
    throw new StorageAlreadyInitializedError('Data lama masih ada pada nexamanga_snapshot. Jalankan /api/admin/storage/migrate atau gunakan force.');
  }
  const state = await readStateRow();
  if (state.initialized) throw new StorageAlreadyInitializedError();
  const revision = numberValue(state.revision);
  const db = executor();
  const results = await db.transaction((tx) => [
    ...replaceCatalog(tx, catalog, revision, false),
    tx`UPDATE nexamanga_catalog_state
       SET initialized = true, revision = revision + 1, updated_at = now()
       WHERE id = 1 AND initialized = false AND revision = ${revision}
       RETURNING revision`
  ]);
  if (!commitResult(results)) throw new StorageAlreadyInitializedError();
  return 1;
}

async function legacySnapshotExists() {
  const db = executor();
  const table = await db`SELECT to_regclass('nexamanga_snapshot') AS name`;
  if (!firstRow(table) || firstRow(table).name === null) return false;
  return Boolean(firstRow(await db`SELECT 1 FROM nexamanga_snapshot WHERE id = 1`));
}

async function ensureCatalogInitialized() {
  try {
    await readCatalog();
  } catch (error) {
    if (!(error instanceof CatalogNotInitializedError)) throw error;
    if (await legacySnapshotExists()) return;
    try {
      await initializeCatalog(EMPTY_CATALOG);
    } catch (initializeError) {
      if (!(initializeError instanceof StorageAlreadyInitializedError)) throw initializeError;
    }
  }
}

async function modifyCatalog(change) {
  await ensureSchema();
  const db = executor();
  for (let attempt = 1; ; attempt += 1) {
    let results = await db.transaction((tx) => catalogQueries(tx), { isolationLevel: transactionIsolationLevel() });
    let state = firstRow(results[0]);
    if (!state || !state.initialized) {
      await migrateLegacyCatalog();
      results = await db.transaction((tx) => catalogQueries(tx), { isolationLevel: transactionIsolationLevel() });
      state = firstRow(results[0]);
      if (!state || !state.initialized) throw new CatalogNotInitializedError();
    }
    const draft = structuredClone(assembleCatalog(results));
    change(draft);
    validateCatalog(draft);
    const revision = numberValue(state.revision);
    const written = await db.transaction((tx) => [
      ...replaceCatalog(tx, draft, revision, true),
      tx`UPDATE nexamanga_catalog_state
         SET revision = revision + 1, updated_at = now()
         WHERE id = 1 AND initialized = true AND revision = ${revision}
         RETURNING revision`
    ]);
    if (commitResult(written)) return draft;
    if (attempt >= CAS_MAX_ATTEMPTS) throw new ConcurrentUpdateError();
  }
}

async function migrateLegacyCatalog() {
  await ensureSchema();
  const state = await readStateRow();
  if (state.initialized) return { ok: false, reason: 'already-initialized' };
  const db = executor();
  const table = await db`SELECT to_regclass('nexamanga_snapshot') AS name`;
  if (!firstRow(table) || firstRow(table).name === null) {
    return { ok: false, reason: 'no-legacy-table' };
  }
  const legacyRows = await db`SELECT data, version FROM nexamanga_snapshot WHERE id = 1`;
  const legacyRow = firstRow(legacyRows);
  if (!legacyRow) return { ok: false, reason: 'no-legacy-row' };
  let data = legacyRow.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return { ok: false, reason: 'invalid-legacy-data' };
    }
  }
  try {
    validateCatalog(data);
  } catch {
    return { ok: false, reason: 'invalid-legacy-data' };
  }
  const revision = numberValue(state.revision);
  const legacyVersion = numberValue(legacyRow.version, 1);
  const results = await db.transaction((tx) => [
    ...replaceCatalog(tx, data, revision, false),
    tx`UPDATE nexamanga_catalog_state
       SET initialized = true,
           revision = revision + 1,
           legacy_version = ${legacyVersion},
           migrated_at = now(),
           updated_at = now()
       WHERE id = 1 AND initialized = false AND revision = ${revision}
       RETURNING revision`
  ]);
  if (!commitResult(results)) return { ok: false, reason: 'already-initialized' };
  return { ok: true };
}

async function recordTrack(visitorId) {
  await ensureSchema();
  const db = executor();
  const day = new Date().toISOString().slice(0, 10);
  const safeVisitorId = typeof visitorId === 'string' && VISITOR_ID_RE.test(visitorId) ? visitorId : '';
  await db.transaction((tx) => {
    const queries = [
      tx`INSERT INTO nexamanga_analytics_days (day, pageviews)
          VALUES (${day}, 1)
          ON CONFLICT (day) DO UPDATE SET pageviews = nexamanga_analytics_days.pageviews + 1`
    ];
    if (safeVisitorId) {
      queries.push(tx`INSERT INTO nexamanga_analytics_visitors (day, visitor_id)
        VALUES (${day}, ${safeVisitorId})
        ON CONFLICT (day, visitor_id) DO NOTHING`);
    }
    queries.push(tx`DELETE FROM nexamanga_analytics_visitors
      WHERE day = ${day}
        AND visitor_id NOT IN (
          SELECT visitor_id FROM nexamanga_analytics_visitors
          WHERE day = ${day}
          ORDER BY created_at DESC, visitor_id DESC
          LIMIT 10000
        )`);
    queries.push(tx`UPDATE nexamanga_analytics_days
      SET visits = (SELECT count(*) FROM nexamanga_analytics_visitors WHERE day = ${day})
      WHERE day = ${day}`);
    return queries;
  });
}

async function readAnalytics(from, to) {
  await ensureSchema();
  const db = executor();
  const result = await db`SELECT d.day, d.pageviews, d.visits,
    (SELECT count(*) FROM nexamanga_analytics_visitors v WHERE v.day = d.day) AS visitors
    FROM nexamanga_analytics_days d
    WHERE d.day >= ${from} AND d.day <= ${to}
    ORDER BY d.day ASC`;
  return rows(result).map((row) => ({
    date: dateString(row.day),
    pageviews: numberValue(row.pageviews),
    visits: numberValue(row.visits),
    visitors: numberValue(row.visitors)
  }));
}

function utcDay(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text.slice(0, 10);
}

function previousDay(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function awardXp(input) {
  await ensureSchema();
  if (!input || typeof input !== 'object') return null;
  const userId = typeof input.userId === 'string' && input.userId ? input.userId.slice(0, 100) : '';
  const activity = typeof input.activity === 'string' && XP_ACTIVITIES.includes(input.activity) ? input.activity : '';
  const amount = Math.max(1, Math.min(100, Math.floor(numberValue(input.amount))));
  if (!userId || !activity || !amount) return null;

  const username = normalizeUsername(input.username || input.name);
  const name = String(input.name || username).slice(0, 100) || username;
  const avatar = typeof input.avatar === 'string' && input.avatar ? input.avatar.slice(0, 2048) : null;
  const refKey = String(input.refKey || '').slice(0, 300);
  const day = new Date().toISOString().slice(0, 10);
  const db = executor();

  return db.transaction(async (tx) => {
    await tx`INSERT INTO nexamanga_user_progress (user_id, username, name, avatar)
      VALUES (${userId}, ${username}, ${name}, ${avatar})
      ON CONFLICT (user_id) DO UPDATE SET
        username = EXCLUDED.username,
        name = EXCLUDED.name,
        avatar = COALESCE(EXCLUDED.avatar, nexamanga_user_progress.avatar),
        updated_at = now()`;

    const eventRows = await tx`INSERT INTO nexamanga_xp_events (user_id, activity, ref_key, amount)
      VALUES (${userId}, ${activity}, ${refKey}, ${amount})
      ON CONFLICT (user_id, activity, ref_key) DO NOTHING
      RETURNING amount`;
    if (!rows(eventRows).length) return null;

    const currentRows = await tx`SELECT xp, streak_days, last_active_date
      FROM nexamanga_user_progress WHERE user_id = ${userId} FOR UPDATE`;
    const current = firstRow(currentRows) || { xp: 0, streak_days: 0, last_active_date: null };
    const lastActive = utcDay(current.last_active_date);
    const streak = lastActive === day
      ? Math.max(1, Math.floor(numberValue(current.streak_days)))
      : lastActive === previousDay(day)
        ? Math.max(1, Math.floor(numberValue(current.streak_days))) + 1
        : 1;
    const totalXp = Math.max(0, Math.floor(numberValue(current.xp))) + amount;
    const progress = progressFromXp(totalXp);
    await tx`UPDATE nexamanga_user_progress
      SET xp = ${totalXp}, level = ${progress.level}, streak_days = ${streak},
          last_active_date = ${day}, updated_at = now()
      WHERE user_id = ${userId}`;
    return serializeProgress(Object.assign({}, current, {
      user_id: userId,
      username,
      name,
      avatar,
      total_xp: totalXp,
      streak_days: streak
    }));
  });
}

async function readLeaderboard(range = 'week', limit = 50) {
  await ensureSchema();
  const db = executor();
  const since = rangeSince(['day', 'week', 'month', 'all'].includes(range) ? range : 'week');
  const safeLimit = Math.max(1, Math.min(50, Math.floor(numberValue(limit, 50))));
  const result = await db`SELECT p.user_id, p.username, p.name, p.avatar, a.public_slug,
      p.xp AS total_xp, p.streak_days,
      COALESCE(SUM(e.amount), 0) AS score
    FROM nexamanga_user_progress p
    LEFT JOIN nexamanga_accounts a ON a.id = p.user_id
    LEFT JOIN nexamanga_xp_events e
      ON e.user_id = p.user_id AND e.created_at >= ${since}
    GROUP BY p.user_id, p.username, p.name, p.avatar, a.public_slug, p.xp, p.streak_days
    ORDER BY score DESC, p.xp DESC, p.user_id ASC
    LIMIT ${safeLimit}`;
  return rows(result).map((row, index) => serializeProgress(row, index + 1, numberValue(row.score)));
}

async function readUserProgress(identifier) {
  await ensureSchema();
  const db = executor();
  const raw = typeof identifier === 'string' ? identifier : '';
  const username = normalizeUsername(raw);
  const result = await db`SELECT p.user_id, p.username, p.name, p.avatar, a.public_slug,
      p.xp AS total_xp, p.streak_days
    FROM nexamanga_user_progress p
    LEFT JOIN nexamanga_accounts a ON a.id = p.user_id
    WHERE p.username = ${username} OR p.user_id = ${raw}
    ORDER BY p.xp DESC, p.updated_at DESC
    LIMIT 1`;
  const row = firstRow(result);
  return row ? serializeProgress(row) : null;
}

async function recordMangaView(identifier, viewerKey) {
  await ensureSchema();
  const db = executor();
  const key = String(viewerKey || 'anon').slice(0, 100) || 'anon';
  const lookupRows = await db`SELECT id, views FROM nexamanga_manga WHERE id = ${identifier} OR slug = ${identifier} LIMIT 1`;
  const manga = firstRow(lookupRows);
  if (!manga) return { recorded: false, reason: 'not-found', mangaId: '', views: 0 };
  const insertedRows = await db`INSERT INTO nexamanga_manga_view_events (manga_id, viewer_key)
    VALUES (${manga.id}, ${key})
    ON CONFLICT (manga_id, viewer_key, day) DO NOTHING
    RETURNING id`;
  return {
    recorded: rows(insertedRows).length > 0,
    reason: rows(insertedRows).length ? 'recorded' : 'duplicate',
    mangaId: manga.id,
    views: numberValue(manga.views)
  };
}

async function readMangaLeaderboard(range = 'week', limit = 50) {
  await ensureSchema();
  const db = executor();
  const safeRange = ['day', 'week', 'month', 'all'].includes(range) ? range : 'week';
  const safeLimit = Math.max(1, Math.min(50, Math.floor(numberValue(limit, 50))));
  if (safeRange === 'all') {
    const result = await db`SELECT m.id, m.slug, m.title,
        COALESCE(m.extra->>'poster', m.extra->>'tmdb_poster', m.extra->>'coverUrl', m.cover_blogger_url, '') AS poster,
        m.views AS views, m.views AS all_time_views
      FROM nexamanga_manga m
      WHERE m.views > 0
      ORDER BY m.views DESC, m.id ASC
      LIMIT ${safeLimit}`;
    return rows(result).map((row, index) => ({
      manga_id: String(row.id || ''),
      slug: String(row.slug || ''),
      title: String(row.title || ''),
      poster: String(row.poster || ''),
      views: numberValue(row.views),
      all_time_views: numberValue(row.all_time_views),
      rank: index + 1
    }));
  }
  const since = rangeSince(safeRange);
  const result = await db`SELECT m.id, m.slug, m.title,
      COALESCE(m.extra->>'poster', m.extra->>'tmdb_poster', m.extra->>'coverUrl', m.cover_blogger_url, '') AS poster,
      COUNT(e.id) AS views, m.views AS all_time_views
    FROM nexamanga_manga m
    JOIN nexamanga_manga_view_events e ON e.manga_id = m.id AND e.created_at >= ${since}
    GROUP BY m.id, m.slug, m.title, m.extra, m.cover_blogger_url, m.views
    HAVING COUNT(e.id) > 0
    ORDER BY views DESC, all_time_views DESC, m.id ASC
    LIMIT ${safeLimit}`;
  return rows(result).map((row, index) => ({
    manga_id: String(row.id || ''),
    slug: String(row.slug || ''),
    title: String(row.title || ''),
    poster: String(row.poster || ''),
    views: numberValue(row.views),
    all_time_views: numberValue(row.all_time_views),
    rank: index + 1
  }));
}

async function readPublicProfile(slug) {
  await ensureSchema();
  const normalized = normalizePublicSlug(slug);
  if (!normalized) return null;
  const db = executor();
  const result = await db`SELECT a.id, a.public_slug, a.name, a.avatar, a.role, a.created_at,
      COALESCE(p.xp, 0) AS total_xp, COALESCE(p.streak_days, 0) AS streak_days
    FROM nexamanga_accounts a
    LEFT JOIN nexamanga_user_progress p ON p.user_id = a.id
    WHERE a.public_slug = ${normalized}
    LIMIT 1`;
  const row = firstRow(result);
  if (!row) return null;
  const totalXp = Math.max(0, Math.floor(numberValue(row.total_xp)));
  const commentsResult = await db`SELECT c.id, c.manga_id, m.slug AS manga_slug, m.title AS manga_title,
      c.content, c.created_at
    FROM nexamanga_comments c
    LEFT JOIN nexamanga_manga m ON m.id = c.manga_id
    WHERE c.user_id = ${row.id} AND c.status = 'approved'
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT 4`;
  return {
    slug: String(row.public_slug),
    username: normalizeUsername(row.name),
    name: String(row.name || ''),
    avatar: row.avatar ? String(row.avatar) : null,
    role: String(row.role || 'member'),
    created_at: timestampString(row.created_at),
    progress: Object.assign({
      total_xp: totalXp,
      streak_days: Math.max(0, Math.floor(numberValue(row.streak_days)))
    }, progressFromXp(totalXp)),
    comments: rows(commentsResult).map((comment) => ({
      id: String(comment.id || ''),
      manga_id: String(comment.manga_id || ''),
      manga_slug: String(comment.manga_slug || ''),
      manga_title: String(comment.manga_title || 'Diskusi Manga'),
      content: String(comment.content || ''),
      created_at: timestampString(comment.created_at)
    }))
  };
}

module.exports = {
  CatalogNotInitializedError,
  ConcurrentUpdateError,
  MAX_SNAPSHOT_BYTES,
  StorageAlreadyInitializedError,
  awardXp,
  ensureCatalogInitialized,
  initializeCatalog,
  modifyCatalog,
  readCatalog,
  readLeaderboard,
  readMangaLeaderboard,
  readPublicProfile,
  readUserProgress,
  recordMangaView,
  recordTrack,
  readAnalytics,
  migrateLegacyCatalog
};

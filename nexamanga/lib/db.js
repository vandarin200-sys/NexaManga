'use strict';

const { neon } = require('@neondatabase/serverless');
const { EMPTY_CATALOG, validateCatalog } = require('./catalog');
const { config } = require('./env');

const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const CAS_MAX_ATTEMPTS = 5;

class ConcurrentUpdateError extends Error {
  constructor() {
    super('Data berubah oleh request lain saat penyimpanan berlangsung. Silakan coba lagi.');
    this.name = 'ConcurrentUpdateError';
  }
}

class StorageAlreadyInitializedError extends Error {
  constructor() {
    super('Database NexaManga sudah diinisialisasi pada tabel snapshot Neon.');
    this.name = 'StorageAlreadyInitializedError';
  }
}

class CatalogNotInitializedError extends Error {
  constructor() {
    super('Database NexaManga belum diinisialisasi. Jalankan /api/admin/storage/init.');
    this.name = 'CatalogNotInitializedError';
  }
}

function databaseUrl() {
  if (process.env.DATABASE_URL) {
    const value = config('DATABASE_URL');
    if (!/^(postgres(ql)?|mysql2?):\/\//i.test(value)) {
      throw new Error('DATABASE_URL harus berupa connection string PostgreSQL atau MySQL.');
    }
    return value;
  }
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT;
  const name = process.env.DB_NAME || process.env.DB_DATABASE;
  const user = process.env.DB_USER || process.env.DB_USERNAME;
  const password = process.env.DB_PASSWORD;
  const driver = dbDriver();
  if (host && name && user) {
    const scheme = driver === 'mysql' ? 'mysql' : 'postgresql';
    const defaultPort = driver === 'mysql' ? '3306' : '5432';
    const portPart = `:${port || defaultPort}`;
    const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
    return `${scheme}://${auth}@${host}${portPart}/${name}`;
  }
  const value = config('DATABASE_URL');
  if (!/^(postgres(ql)?|mysql2?):\/\//i.test(value)) {
    throw new Error('DATABASE_URL harus berupa connection string PostgreSQL atau MySQL.');
  }
  return value;
}

function dbDriver() {
  const explicit = String(process.env.DB_DRIVER || '').toLowerCase();
  if (explicit === 'mysql' || explicit === 'mysql2') return 'mysql';
  if (explicit === 'pg' || explicit === 'postgres' || explicit === 'postgresql') return 'pg';
  if (explicit === 'neon') return 'neon';
  const url = process.env.DATABASE_URL;
  if (url) {
    if (/^mysql2?:\/\//i.test(url)) return 'mysql';
    if (/^postgres(ql)?:\/\//i.test(url)) return 'neon';
  }
  if (process.env.DB_HOST) {
    if (String(process.env.DB_PORT || '') === '3306') return 'mysql';
    return 'pg';
  }
  return 'neon';
}

let client = null;
let pool = null;
let mysqlPool = null;

function sql() {
  const driver = dbDriver();
  if (driver === 'mysql') {
    if (!mysqlPool) {
      const mysql = require('mysql2/promise');
      mysqlPool = mysql.createPool(databaseUrl());
    }
    return function (strings, ...values) {
      let text = '';
      strings.forEach((str, i) => {
        text += str;
        if (i < values.length) text += '?';
      });
      text = text.replace(/::jsonb/g, '');
      return mysqlPool.query(text, values).then((result) => result[0]);
    };
  }
  if (driver === 'pg') {
    if (!pool) {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: databaseUrl(), ssl: /sslmode=require/i.test(databaseUrl()) ? { rejectUnauthorized: false } : undefined });
    }
    return function (strings, ...values) {
      let text = '';
      strings.forEach((str, i) => {
        text += str;
        if (i < values.length) text += `$${i + 1}`;
      });
      return pool.query(text, values).then((result) => result.rows);
    };
  }
  if (!client) client = neon(databaseUrl());
  return client;
}

let schemaPromise = null;

function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const driver = dbDriver();
      if (driver === 'mysql') {
        await sql()`CREATE TABLE IF NOT EXISTS nexamanga_snapshot (
          id SMALLINT PRIMARY KEY,
          data JSON NOT NULL,
          version BIGINT NOT NULL DEFAULT 1,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`;
        await sql()`CREATE TABLE IF NOT EXISTS nexamanga_analytics (
          day DATE PRIMARY KEY,
          pageviews BIGINT NOT NULL DEFAULT 0,
          visits BIGINT NOT NULL DEFAULT 0,
          visitors JSON NOT NULL
        )`;
        try {
          await sql()`INSERT IGNORE INTO nexamanga_snapshot (id, data) VALUES (1, ${JSON.stringify(EMPTY_CATALOG)})`;
        } catch (error) {
          // Abaikan; inisialisasi dilakukan lewat endpoint admin jika diperlukan.
        }
        return;
      }

       await sql()`CREATE TABLE IF NOT EXISTS nexamanga_snapshot (
         id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
         data jsonb NOT NULL,
         version bigint NOT NULL DEFAULT 1,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`;
       await sql()`CREATE TABLE IF NOT EXISTS nexamanga_analytics (
         day date PRIMARY KEY,
         pageviews bigint NOT NULL DEFAULT 0,
         visits bigint NOT NULL DEFAULT 0,
         visitors jsonb NOT NULL DEFAULT '[]'::jsonb
       )`;

      try {
        await sql()`CREATE OR REPLACE VIEW nexamanga_users AS
          SELECT (u.item->>'id') AS id,
                 (u.item->>'name') AS name,
                 (u.item->>'email') AS email,
                 (u.item->>'avatar') AS avatar,
                 (u.item->>'provider') AS provider,
                 (u.item->>'role') AS role,
                 (u.item->>'createdAt') AS created_at
          FROM nexamanga_snapshot,
               LATERAL jsonb_array_elements(data->'users') AS u(item)`;
      } catch (error) {
        console.error('View nexamanga_users gagal dibuat (opsional, tidak memengaruhi API):', error && error.message ? error.message : error);
      }
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function snapshotPayload(catalog) {
  validateCatalog(catalog);
  const payload = JSON.stringify(catalog);
  if (Buffer.byteLength(payload, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('Katalog melebihi batas 50 MiB yang didukung.');
  }
  return payload;
}

function parseRow(row) {
  let data = row.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error('Dokumen katalog di Neon bukan JSON yang valid.');
    }
  }
  return { data: validateCatalog(data), version: Number(row.version) };
}

async function readSnapshotRow() {
  await ensureSchema();
  const rows = await sql()`SELECT data, version FROM nexamanga_snapshot WHERE id = 1`;
  if (rows.length === 0) return null;
  return parseRow(rows[0]);
}

async function readCatalog() {
  const row = await readSnapshotRow();
  if (!row) throw new CatalogNotInitializedError();
  return row.data;
}

async function initializeCatalog(catalog) {
  await ensureSchema();
  const payload = snapshotPayload(catalog);
  const existing = await sql()`SELECT id FROM nexamanga_snapshot WHERE id = 1`;
  if (existing.length > 0) throw new StorageAlreadyInitializedError();
  if (dbDriver() === 'mysql') {
    await sql()`INSERT IGNORE INTO nexamanga_snapshot (id, data) VALUES (1, ${payload})`;
  } else {
    await sql()`INSERT INTO nexamanga_snapshot (id, data)
      VALUES (1, ${payload}::jsonb)
      ON CONFLICT (id) DO NOTHING`;
  }
  return 1;
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

async function modifyCatalog(change) {
  for (let attempt = 1; ; attempt += 1) {
    const row = await readSnapshotRow();
    if (!row) throw new CatalogNotInitializedError();
    const draft = structuredClone(row.data);
    change(draft);
    const payload = snapshotPayload(draft);
    let updated;
    if (dbDriver() === 'mysql') {
      updated = await sql()`UPDATE nexamanga_snapshot
        SET data = ${payload}, version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1 AND version = ${row.version}`;
      if (updated && updated.affectedRows === 1) return draft;
    } else {
      const rows = await sql()`UPDATE nexamanga_snapshot
        SET data = ${payload}::jsonb, version = version + 1, updated_at = now()
        WHERE id = 1 AND version = ${row.version}
        RETURNING version`;
      if (rows.length === 1) return draft;
    }
    if (attempt >= CAS_MAX_ATTEMPTS) throw new ConcurrentUpdateError();
  }
}

async function recordTrack(visitorId) {
  await ensureSchema();
  const day = new Date().toISOString().slice(0, 10);
  const rows = await sql()`SELECT pageviews, visits, visitors FROM nexamanga_analytics WHERE day = ${day}`;
  let pageviews = 1;
  let visitors = [];
  if (rows.length) {
    pageviews = Number(rows[0].pageviews) + 1;
    visitors = Array.isArray(rows[0].visitors) ? rows[0].visitors.slice() : [];
  }
    const safeVisitorId = typeof visitorId === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(visitorId) ? visitorId : '';
    if (safeVisitorId && !visitors.includes(safeVisitorId)) visitors.push(safeVisitorId);
    if (visitors.length > 10000) visitors = visitors.slice(visitors.length - 10000);
  const visits = visitors.length;
  const visitorsJson = JSON.stringify(visitors);
  if (dbDriver() === 'mysql') {
    await sql()`INSERT INTO nexamanga_analytics (day, pageviews, visits, visitors)
      VALUES (${day}, ${pageviews}, ${visits}, ${visitorsJson})
      ON DUPLICATE KEY UPDATE pageviews = ${pageviews}, visits = ${visits}, visitors = ${visitorsJson}`;
  } else {
    await sql()`INSERT INTO nexamanga_analytics (day, pageviews, visits, visitors)
      VALUES (${day}, ${pageviews}, ${visits}, ${visitorsJson}::jsonb)
      ON CONFLICT (day) DO UPDATE SET pageviews = ${pageviews}, visits = ${visits}, visitors = ${visitorsJson}::jsonb`;
  }
}

async function readAnalytics(from, to) {
  await ensureSchema();
  const rows = await sql()`SELECT day, pageviews, visits, visitors FROM nexamanga_analytics WHERE day >= ${from} AND day <= ${to} ORDER BY day ASC`;
  return rows.map((row) => ({
    date: row.day,
    pageviews: Number(row.pageviews),
    visits: Number(row.visits),
    visitors: Array.isArray(row.visitors) ? row.visitors.length : 0
  }));
}

module.exports = {
  CatalogNotInitializedError,
  ConcurrentUpdateError,
  MAX_SNAPSHOT_BYTES,
  StorageAlreadyInitializedError,
  ensureCatalogInitialized,
  initializeCatalog,
  modifyCatalog,
  readCatalog,
  recordTrack,
  readAnalytics
};

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
  const value = config('DATABASE_URL');
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    throw new Error('DATABASE_URL harus berupa connection string PostgreSQL, misalnya postgresql://user:password@host/dbname?sslmode=require.');
  }
  return value;
}

let client = null;

function sql() {
  if (!client) client = neon(databaseUrl());
  return client;
}

let schemaPromise = null;

function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = sql()`CREATE TABLE IF NOT EXISTS nexamanga_snapshot (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      data jsonb NOT NULL,
      version bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.then(() => undefined).catch((error) => {
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
  await sql()`INSERT INTO nexamanga_snapshot (id, data)
    VALUES (1, ${payload}::jsonb)
    ON CONFLICT (id) DO NOTHING`;
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
    const rows = await sql()`UPDATE nexamanga_snapshot
      SET data = ${payload}::jsonb, version = version + 1, updated_at = now()
      WHERE id = 1 AND version = ${row.version}
      RETURNING version`;
    if (rows.length === 1) return draft;
    if (attempt >= CAS_MAX_ATTEMPTS) throw new ConcurrentUpdateError();
  }
}

module.exports = {
  CatalogNotInitializedError,
  ConcurrentUpdateError,
  MAX_SNAPSHOT_BYTES,
  StorageAlreadyInitializedError,
  ensureCatalogInitialized,
  initializeCatalog,
  modifyCatalog,
  readCatalog
};

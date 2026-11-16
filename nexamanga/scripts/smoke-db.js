'use strict';

// Smoke check (bukan bagian dari test suite): jalankan lib/db.js terhadap
// pg-mem melalui jalur HTTP asli dari @neondatabase/serverless.
// Perlu: npm install --no-save pg-mem

const { newDb } = require('pg-mem');
const { neonConfig } = require('@neondatabase/serverless');

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const pool = new Pool();

neonConfig.fetchEndpoint = 'http://localhost/sql';
neonConfig.fetchFunction = async (url, init = {}) => {
  const body = JSON.parse(init.body);
  const client = await pool.connect();
  try {
    const run = async (query, params = []) => {
      const result = await client.query(query, params);
      const rawFields = Array.isArray(result.fields) && result.fields.length
        ? result.fields
        : Object.keys((result.rows || [])[0] || {}).map((name) => ({ name }));
      return {
        command: 'OK',
        fields: rawFields.map((field) => ({ name: field.name, dataTypeID: 25 })),
        rows: (result.rows || []).map((row) =>
          rawFields.map((field) => {
            const value = row[field.name];
            if (value === null || value === undefined) return null;
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
          })
        ),
        rowCount: result.rowCount
      };
    };
    if (body.queries) {
      const results = [];
      for (const entry of body.queries) {
        results.push(await run(entry.query, entry.params || []));
      }
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const result = await run(body.query, body.params || []);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ message: error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  } finally {
    client.release();
  }
};

process.env.DATABASE_URL = 'postgresql://user:pass@localhost/dbname';

(async () => {
  const db = require('../lib/db');

  console.log('1. initializeCatalog (empty)...');
  await db.initializeCatalog({ manga: [], chapters: [], comments: [], users: [] });
  console.log('   ok');

  console.log('2. initializeCatalog lagi (harus StorageAlreadyInitializedError)...');
  try {
    await db.initializeCatalog({ manga: [], chapters: [], comments: [], users: [] });
    console.log('   GAGAL: tidak melempar error');
    process.exitCode = 1;
    return;
  } catch (error) {
    if (error.name !== 'StorageAlreadyInitializedError') throw error;
    console.log('   ok, mendapat', error.name);
  }

  console.log('3. modifyCatalog menambah manga...');
  await db.modifyCatalog((catalog) => {
    catalog.manga.push({
      id: 'mng-1',
      slug: 'judul-smoke',
      title: 'Judul Smoke',
      synopsis: 'Sinopsis yang cukup panjang untuk lolos validasi.',
      genres: ['Aksi'],
      rating: 4
    });
  });
  const catalog = await db.readCatalog();
  console.log('   ok, manga tersimpan:', catalog.manga.map((item) => item.slug).join(','));

  console.log('4. modifyCatalog lain (version harus naik)...');
  await db.modifyCatalog((draft) => { draft.manga[0].views = (Number(draft.manga[0].views) || 0) + 1; });
  const again = await db.readCatalog();
  console.log('   ok, views =', again.manga[0].views);

  console.log('Smoke test Neon/pg-mem lulus.');
})().catch((error) => {
  console.error('Smoke test gagal:', error);
  process.exitCode = 1;
});

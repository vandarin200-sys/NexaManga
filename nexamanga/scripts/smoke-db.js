'use strict';

// Smoke check (bukan bagian dari test suite): jalankan lib/db.js terhadap
// PostgreSQL/Neon uji. Perlu SMOKE_DATABASE_URL dan database yang bisa dihapus isinya.

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

(async () => {
  const databaseUrl = process.env.SMOKE_DATABASE_URL;
  if (!databaseUrl) {
    console.log('Lewati smoke DB: SMOKE_DATABASE_URL belum diisi.');
    return;
  }
  process.env.DATABASE_URL = databaseUrl;
  process.env.DB_DRIVER = 'pg';

  const db = require('../lib/db');
  const marker = `smoke-${randomUUID()}`;
  let inserted = false;

  try {
    console.log('1. migrateLegacyCatalog...');
    const migration = await db.migrateLegacyCatalog();
    console.log('   hasil:', migration);
    if (migration.reason === 'invalid-legacy-data') throw new Error('Data lama tidak valid.');

    console.log('2. pastikan katalog terinisialisasi...');
    if (!migration.ok && migration.reason !== 'already-initialized') {
      try {
        await db.initializeCatalog({ manga: [], chapters: [], comments: [], reports: [], users: [] });
      } catch (error) {
        if (error.name !== 'StorageAlreadyInitializedError') throw error;
      }
    }
    console.log('   ok');

    console.log('3. modifyCatalog menambah manga uji...');
    await db.modifyCatalog((catalog) => {
      catalog.manga.push({
        id: marker,
        slug: marker,
        title: 'Judul Smoke',
        synopsis: 'Sinopsis yang cukup panjang untuk lolos validasi.',
        genres: ['Aksi'],
        rating: 4
      });
    });
    inserted = true;
    console.log('   ok');

    console.log('4. readCatalog mengembalikan manga uji...');
    const catalog = await db.readCatalog();
    assert(catalog.manga.some((item) => item.id === marker), 'Manga uji tidak ditemukan.');
    console.log('   ok');

    console.log('5. modifyCatalog membersihkan manga uji...');
    await db.modifyCatalog((draft) => {
      draft.manga = draft.manga.filter((item) => item.id !== marker);
    });
    inserted = false;
    const after = await db.readCatalog();
    assert(!after.manga.some((item) => item.id === marker), 'Manga uji tidak terhapus.');
    console.log('   ok');

    console.log('Smoke test database relasional lulus.');
  } finally {
    if (inserted) {
      try {
        await db.modifyCatalog((draft) => {
          draft.manga = draft.manga.filter((item) => item.id !== marker);
        });
      } catch (error) {
        console.error('Gagal membersihkan manga uji:', error.message);
      }
    }
  }
})().catch((error) => {
  console.error('Smoke test gagal:', error);
  process.exitCode = 1;
});

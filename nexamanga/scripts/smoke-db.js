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
  const accountId = `usr-${marker}`;
  let inserted = false;
  let accountInserted = false;

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

    console.log('5. mencatat event baca komik uji...');
    const firstView = await db.recordMangaView(marker, `viewer-${marker}`);
    assert(firstView.recorded && firstView.mangaId === marker, 'Event baca komik tidak tercatat.');
    const repeatView = await db.recordMangaView(marker, `viewer-${marker}`);
    assert(!repeatView.recorded && repeatView.reason === 'duplicate', 'Event baca duplikat seharusnya diabaikan.');
    const comicBoard = await db.readMangaLeaderboard('week', 50);
    assert(comicBoard.some((item) => item.manga_id === marker && item.views >= 1), 'Leaderboard komik tidak mengembalikan event uji.');
    console.log('   ok');

    console.log('6. modifyCatalog membersihkan manga uji...');
    await db.modifyCatalog((draft) => {
      draft.manga = draft.manga.filter((item) => item.id !== marker);
    });
    inserted = false;
    const after = await db.readCatalog();
    assert(!after.manga.some((item) => item.id === marker), 'Manga uji tidak terhapus.');
    console.log('   ok');

    console.log('7. mencatat progres XP uji...');
    await db.modifyCatalog((catalog) => {
      catalog.users.push({
        id: accountId,
        provider: 'google',
        providerId: marker,
        name: 'Smoke XP',
        role: 'member',
        createdAt: new Date().toISOString()
      });
    });
    accountInserted = true;
    const awarded = await db.awardXp({
      userId: accountId,
      username: 'Smoke XP',
      name: 'Smoke XP',
      activity: 'welcome',
      refKey: accountId,
      amount: 25
    });
    assert(awarded && awarded.total_xp === 25, 'XP uji tidak tercatat.');
    const duplicate = await db.awardXp({
      userId: accountId,
      username: 'Smoke XP',
      name: 'Smoke XP',
      activity: 'welcome',
      refKey: accountId,
      amount: 25
    });
    assert(duplicate === null, 'XP duplikat seharusnya diabaikan.');
    const board = await db.readLeaderboard('all', 50);
    assert(board.some((item) => item.user_id === accountId && item.score === 25), 'Leaderboard XP tidak mengembalikan progres uji.');
    const profile = await db.readUserProgress('smokexp');
    assert(profile && profile.user_id === accountId && profile.total_xp === 25, 'Profil XP tidak ditemukan.');
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
    if (accountInserted) {
      try {
        await db.modifyCatalog((catalog) => {
          catalog.users = catalog.users.filter((item) => item.id !== accountId);
        });
      } catch (error) {
        console.error('Gagal membersihkan akun uji:', error.message);
      }
    }
  }
})().catch((error) => {
  console.error('Smoke test gagal:', error);
  process.exitCode = 1;
});

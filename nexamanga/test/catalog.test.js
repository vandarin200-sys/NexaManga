'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ValidationError,
  addComment,
  deleteManga,
  registerOAuthUser,
  saveChapter,
  saveManga
} = require('../lib/catalog');

function catalog() {
  return { manga: [], chapters: [], comments: [], users: [] };
}

function manga(id = 'm1') {
  return {
    id,
    slug: 'judul-manga',
    title: 'Judul Manga',
    synopsis: 'Sinopsis manga yang cukup panjang.',
    genres: ['Aksi'],
    rating: 4.5
  };
}

test('creates and updates manga while rejecting duplicate slugs', () => {
  const data = catalog();
  saveManga(data, manga());
  assert.equal(data.manga.length, 1);
  saveManga(data, { ...manga(), title: 'Judul Baru' });
  assert.equal(data.manga[0].title, 'Judul Baru');
  assert.throws(
    () => saveManga(data, { ...manga('m2'), slug: 'judul-manga' }),
    ValidationError
  );
});

test('saves chapters and prevents duplicates within a manga', () => {
  const data = catalog();
  saveManga(data, manga());
  const chapter = { id: 'ch1', mangaId: 'm1', number: 1, title: 'Chapter 1', pages: [] };
  saveChapter(data, chapter);
  assert.equal(data.chapters.length, 1);
  assert.throws(() => saveChapter(data, { ...chapter, id: 'ch2' }), ValidationError);
});

test('stores comments as pending and cascades manga deletion', () => {
  const data = catalog();
  saveManga(data, manga());
  saveChapter(data, { id: 'ch1', mangaId: 'm1', number: 1, title: '', pages: [] });
  const comment = addComment(data, { mangaId: 'm1', authorName: 'Pembaca', content: 'Komentar yang cukup baik.' });
  assert.equal(comment.status, 'pending');
  assert.equal(data.comments.length, 1);
  deleteManga(data, 'm1');
  assert.deepEqual(data, { manga: [], chapters: [], comments: [], users: [] });
});

test('first OAuth account is admin, later accounts are members, and logins reuse identity', () => {
  const data = catalog();
  const first = registerOAuthUser(data, {
    provider: 'google',
    providerId: 'google-1',
    name: 'Admin Pertama',
    email: 'admin@example.com'
  });
  const repeated = registerOAuthUser(data, {
    provider: 'google',
    providerId: 'google-1',
    name: 'Nama Berubah',
    email: 'admin@example.com'
  });
  const second = registerOAuthUser(data, {
    provider: 'discord',
    providerId: 'discord-2',
    name: 'Member Kedua'
  });
  assert.equal(first.role, 'admin');
  assert.equal(repeated.id, first.id);
  assert.equal(data.users.length, 2);
  assert.equal(second.role, 'member');
});

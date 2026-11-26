'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ValidationError,
  addChapterReaction,
  addComment,
  deleteManga,
  pinComment,
  registerOAuthUser,
  saveChapter,
  saveManga,
  saveSettings
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

test('saveManga normalizes adult flag and preserves legacy adult genres', () => {
  const data = catalog();
  saveManga(data, { ...manga(), isAdult: true });
  assert.equal(data.manga[0].isAdult, true);

  saveManga(data, { ...manga('m2'), slug: 'judul-dewasa', isAdult: false });
  assert.equal(data.manga[1].isAdult, false);

  saveManga(data, { ...manga('m3'), slug: 'judul-hentai', genres: ['Hentai'], isAdult: false });
  assert.equal(data.manga[2].isAdult, true);

  assert.throws(
    () => saveManga(data, { ...manga('m4'), slug: 'judul-invalid', isAdult: 'mungkin' }),
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

test('anonymous comments cannot choose an author name', () => {
  const data = catalog();
  saveManga(data, manga());
  const comment = addComment(data, {
    mangaId: 'm1',
    authorName: 'Admin',
    authorAvatar: 'https://evil.example/avatar.png',
    authorKey: 'anon-123',
    content: 'Komentar yang cukup baik.'
  });
  assert.equal(comment.userId, null);
  assert.equal(comment.authorName, 'Pengunjung');
  assert.equal(comment.authorAvatar, null);
  assert.equal(comment.authorKey, 'anon-123');
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

test('chapter reactions toggle per voter and reject unknown chapter/reaction', () => {
  const data = catalog();
  saveManga(data, manga());
  saveChapter(data, { id: 'ch1', mangaId: 'm1', number: 1, title: '', pages: [] });
  const first = addChapterReaction(data, { chapterId: 'ch1', voterId: 'v1', reaction: 'fire' });
  assert.equal(first.counts.fire, 1);
  assert.equal(first.userVote, 'fire');
  addChapterReaction(data, { chapterId: 'ch1', voterId: 'v2', reaction: 'fire' });
  const switched = addChapterReaction(data, { chapterId: 'ch1', voterId: 'v1', reaction: 'laugh' });
  assert.equal(switched.counts.fire, 1);
  assert.equal(switched.counts.laugh, 1);
  assert.equal(switched.userVote, 'laugh');
  const toggledOff = addChapterReaction(data, { chapterId: 'ch1', voterId: 'v1', reaction: 'laugh' });
  assert.equal(toggledOff.counts.laugh, 0);
  assert.equal(toggledOff.userVote, null);
  assert.throws(() => addChapterReaction(data, { chapterId: 'tidak-ada', voterId: 'v1', reaction: 'fire' }), ValidationError);
  assert.throws(() => addChapterReaction(data, { chapterId: 'ch1', voterId: 'v1', reaction: 'rock' }), ValidationError);
});

test('admin can pin and unpin comments', () => {
  const data = catalog();
  saveManga(data, manga());
  const comment = addComment(data, { mangaId: 'm1', authorName: 'Pembaca', content: 'Komentar untuk disematkan.' });
  const pinned = pinComment(data, { id: comment.id });
  assert.equal(pinned.pinned, true);
  const pinnedAgain = pinComment(data, { id: comment.id });
  assert.equal(pinnedAgain.pinned, false);
  assert.throws(() => pinComment(data, { id: 'tidak-ada' }), ValidationError);
});

test('chapter comments are scoped to their chapter and replies inherit it', () => {
  const data = catalog();
  saveManga(data, manga());
  saveChapter(data, { id: 'ch1', mangaId: 'm1', number: 1, title: '', pages: [] });
  saveChapter(data, { id: 'ch2', mangaId: 'm1', number: 2, title: '', pages: [] });
  const comment = addComment(data, { mangaId: 'm1', chapterId: 'ch1', authorName: 'Pembaca', content: 'Komentar untuk chapter 1.' });
  assert.equal(comment.chapterId, 'ch1');
  const reply = addComment(data, { mangaId: 'm1', parentId: comment.id, authorName: 'Pembaca', content: 'Balasan tanpa chapterId.' });
  assert.equal(reply.chapterId, 'ch1');
  assert.throws(() => addComment(data, { mangaId: 'm1', chapterId: 'ch2', parentId: comment.id, authorName: 'X', content: 'Balasan beda chapter.' }), ValidationError);
  assert.throws(() => addComment(data, { mangaId: 'm1', chapterId: 'tidak-ada', authorName: 'X', content: 'Chapter hantu.' }), ValidationError);
});

test('saveSettings accepts and validates favicon URL', () => {
  const data = catalog();
  const settings = saveSettings(data, { faviconUrl: ' https://cdn.example.com/favicon.png ' });
  assert.equal(settings.faviconUrl, 'https://cdn.example.com/favicon.png');
  assert.throws(
    () => saveSettings(data, { faviconUrl: 'javascript:alert(1)' }),
    ValidationError
  );
  assert.equal(data.settings.faviconUrl, 'https://cdn.example.com/favicon.png');
});

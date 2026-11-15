'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/[...path].js');
const { createSessionToken } = require('../lib/auth');

function responseHarness() {
  return {
    headers: {},
    statusCode: 0,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value; }
  };
}

async function call(method, url, headers = {}, body) {
  const res = responseHarness();
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = value;
  await handler({ method, url, headers: normalized, body }, res);
  const isJson = (res.headers['content-type'] || '').includes('application/json');
  return { ...res, json: isJson && res.body ? JSON.parse(res.body.toString()) : null };
}

function setEnv() {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_STORAGE_CHAT_ID = '"-100123"';
  process.env.TOKEN_SECRET = 'test-secret-with-more-than-32-characters';
  process.env.ALLOWED_ORIGINS = 'https://nexa.example';
  process.env.PUBLIC_API_URL = 'https://nexa.example';
}

function adminToken() {
  return createSessionToken({
    id: 'usr-admin',
    role: 'admin',
    name: 'Admin',
    email: null,
    provider: 'google'
  });
}

function mockTelegram({ catalog, pinned = true, fileId = 'AgACAgUAAxkBAAM_catalog-file-id' }) {
  const realFetch = global.fetch;
  const snapshot = Buffer.from(JSON.stringify(catalog));
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/getChat')) {
      return Response.json({
        ok: true,
        result: {
          id: -100123,
          pinned_message: pinned
            ? {
                message_id: 321,
                caption: 'NexaManga database snapshot',
                document: { file_id: fileId, file_size: snapshot.length }
              }
            : null
        }
      });
    }
    if (url.endsWith('/getFile')) {
      return Response.json({
        ok: true,
        result: { file_path: 'documents/catalog.json', file_size: snapshot.length }
      });
    }
    if (url.includes('/file/bot')) {
      return new Response(snapshot, { status: 200 });
    }
    if (url.endsWith('/sendDocument')) {
      const name = init.body && typeof init.body.get === 'function' ? init.body.get('document').name : '';
      if (name === 'nexamanga-catalog.json') {
        return Response.json({ ok: true, result: { message_id: 321, document: { file_id: fileId } } });
      }
      return Response.json({ ok: true, result: { message_id: 400, document: { file_id: 'AgACAgUAAxkBAAM_image-file-id' } } });
    }
    if (url.endsWith('/editMessageMedia')) {
      return Response.json({ ok: true, result: { message_id: 321 } });
    }
    if (url.endsWith('/pinChatMessage')) {
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: 'unexpected ' + url }, { status: 400 });
  };
  return () => { global.fetch = realFetch; };
}

test('health endpoint responds without Telegram', async () => {
  setEnv();
  const res = await call('GET', '/api/health');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.service, 'nexamanga-vercel-backend');
});

test('unknown route returns 404 in Indonesian', async () => {
  setEnv();
  const res = await call('GET', '/api/tidak-ada');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.error, 'Endpoint tidak ditemukan.');
});

test('catalog hides pending comments and users from visitors', async () => {
  setEnv();
  const restore = mockTelegram({
    catalog: {
      manga: [],
      chapters: [],
      comments: [
        { id: 'public', status: 'approved' },
        { id: 'private', status: 'pending' }
      ],
      users: [{ id: 'usr-x', role: 'admin' }]
    }
  });
  try {
    const res = await call('GET', '/api/catalog');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json.comments.map((c) => c.id), ['public']);
    assert.equal(res.json.users, undefined);
  } finally {
    restore();
  }
});

test('admin session sees pending comments but still no users list', async () => {
  setEnv();
  const restore = mockTelegram({
    catalog: {
      manga: [],
      chapters: [],
      comments: [
        { id: 'public', status: 'approved' },
        { id: 'private', status: 'pending' }
      ],
      users: [{ id: 'usr-x', role: 'admin' }]
    }
  });
  try {
    const res = await call('GET', '/api/catalog', { Authorization: `Bearer ${adminToken()}` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json.comments.map((c) => c.id), ['public', 'private']);
    assert.equal(res.json.users, undefined);
  } finally {
    restore();
  }
});

test('admin write endpoints reject missing or non-admin tokens', async () => {
  setEnv();
  const member = createSessionToken({
    id: 'usr-member',
    role: 'member',
    name: 'Member',
    email: null,
    provider: 'google'
  });
  for (const headers of [
    {},
    { Authorization: 'Bearer bukan-token' },
    { Authorization: `Bearer ${member}` }
  ]) {
    const res = await call('POST', '/api/admin/save-manga', headers, { id: 'm1' });
    assert.equal(res.statusCode, 401);
    assert.match(res.json.error, /Sesi admin/);
  }
});

test('comment rejects unknown manga with validation error', async () => {
  setEnv();
  const restore = mockTelegram({ catalog: { manga: [], chapters: [], comments: [], users: [] } });
  try {
    const res = await call('POST', '/api/comment', {}, {
      mangaId: 'tidak-ada',
      authorName: 'Pembaca',
      content: 'Komentar yang cukup baik.'
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'Manga tidak ditemukan.');
  } finally {
    restore();
  }
});

test('catalog returns empty payload when storage not yet initialized', async () => {
  setEnv();
  const restore = mockTelegram({ catalog: null, pinned: false });
  try {
    const res = await call('GET', '/api/catalog');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { manga: [], chapters: [], comments: [] });
  } finally {
    restore();
  }
});

test('CORS allows configured blog origin even with quoted env value', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_STORAGE_CHAT_ID = '-100123';
  process.env.TOKEN_SECRET = 'test-secret-with-more-than-32-characters';
  process.env.ALLOWED_ORIGINS = '"https://nexa.example/"';
  process.env.PUBLIC_API_URL = 'https://nexa.example';
  const res = await call('GET', '/api/health', { Origin: 'https://nexa.example' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'https://nexa.example');
});

test('auth/me rejects missing session', async () => {
  setEnv();
  const res = await call('GET', '/api/auth/me');
  assert.equal(res.statusCode, 401);
  assert.match(res.json.error, /Sesi tidak valid/);
});

test('auth/me returns profile for valid session', async () => {
  setEnv();
  const res = await call('GET', '/api/auth/me', { Authorization: `Bearer ${adminToken()}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.role, 'admin');
  assert.equal(res.json.user.id, 'usr-admin');
});

test('admin save-manga persists through Telegram snapshot', async () => {
  setEnv();
  let stored = { manga: [], chapters: [], comments: [], users: [] };
  const realFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/getChat')) {
      return Response.json({
        ok: true,
        result: {
          id: -100123,
          pinned_message: {
            message_id: 321,
            caption: 'NexaManga database snapshot',
            document: { file_id: 'AgACAgUAAxkBAAM_catalog-file-id', file_size: 10 }
          }
        }
      });
    }
    if (url.endsWith('/getFile')) {
      return Response.json({ ok: true, result: { file_path: 'documents/catalog.json', file_size: 10 } });
    }
    if (url.includes('/file/bot')) {
      return new Response(Buffer.from(JSON.stringify(stored)), { status: 200 });
    }
    if (url.endsWith('/editMessageMedia')) {
      stored = JSON.parse(Buffer.from(await init.body.get('snapshot').arrayBuffer()).toString('utf8'));
      return Response.json({ ok: true, result: { message_id: 321 } });
    }
    return Response.json({ ok: false, description: 'unexpected' }, { status: 400 });
  };
  try {
    const manga = {
      id: 'mng-1',
      slug: 'judul-baru',
      title: 'Judul Baru',
      synopsis: 'Sinopsis yang cukup panjang untuk lolos validasi.',
      genres: ['Aksi'],
      rating: 4
    };
    const res = await call('POST', '/api/admin/save-manga', { Authorization: `Bearer ${adminToken()}` }, manga);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(stored.manga.length, 1);
    assert.equal(stored.manga[0].slug, 'judul-baru');
  } finally {
    global.fetch = realFetch;
  }
});

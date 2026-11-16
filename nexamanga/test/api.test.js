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
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/testdb';
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

function neonResult(rows, fields) {
  return Response.json({ command: 'OK', fields, rows, rowCount: rows.length });
}

function textFields(names) {
  return names.map((name) => ({ name, dataTypeID: 25 }));
}

function mockDatabase({ catalog, initialized = true, failCas = false } = {}) {
  const state = {
    data: initialized && catalog ? structuredClone(catalog) : null,
    version: 1
  };
  const realFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/sql')) {
      const body = JSON.parse(init.body);
      const query = String(body.query || '');
      if (/CREATE TABLE IF NOT EXISTS/i.test(query)) {
        return neonResult([], []);
      }
      if (/CREATE OR REPLACE VIEW/i.test(query)) {
        return neonResult([], []);
      }
      if (/SELECT data, version FROM nexamanga_snapshot/i.test(query)) {
        if (!state.data) return neonResult([], textFields(['data', 'version']));
        return neonResult([[JSON.stringify(state.data), String(state.version)]], textFields(['data', 'version']));
      }
      if (/SELECT id FROM nexamanga_snapshot/i.test(query)) {
        return neonResult(state.data ? [['1']] : [], textFields(['id']));
      }
      if (/INSERT INTO nexamanga_snapshot/i.test(query)) {
        if (state.data) return neonResult([], textFields(['id']));
        state.data = JSON.parse(body.params[0]);
        state.version = 1;
        return neonResult([['1']], textFields(['id']));
      }
      if (/UPDATE nexamanga_snapshot/i.test(query)) {
        if (failCas) return neonResult([], textFields(['version']));
        const expectedVersion = Number(body.params[1]);
        if (state.data && state.version === expectedVersion) {
          state.data = JSON.parse(body.params[0]);
          state.version += 1;
          return neonResult([[String(state.version)]], textFields(['version']));
        }
        return neonResult([], textFields(['version']));
      }
      return Response.json({ message: `unexpected query: ${query}` }, { status: 400 });
    }
    return Response.json({ ok: false, description: 'unexpected ' + url }, { status: 400 });
  };
  return {
    state,
    restore() { global.fetch = realFetch; }
  };
}

test('health endpoint responds without database access', async () => {
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
  assert.match(res.json.error, /Endpoint tidak ditemukan/);
});

test('oauth start route matches regardless of URL shape', async () => {
  setEnv();
  process.env.DISCORD_CLIENT_ID = 'cid';
  process.env.DISCORD_CLIENT_SECRET = 'csecret';
  const shapes = [
    '/api/auth/discord/start?return_to=https%3A%2F%2Fnexa.example',
    '/auth/discord/start?return_to=https%3A%2F%2Fnexa.example',
    'api/auth/discord/start?return_to=https%3A%2F%2Fnexa.example',
    '/api/auth/discord/start/?return_to=https%3A%2F%2Fnexa.example'
  ];
  for (const url of shapes) {
    const res = await call('GET', url);
    assert.notEqual(res.statusCode, 404, `shape ${url} should not 404, got ${res.statusCode}: ${JSON.stringify(res.json)}`);
    assert.equal(res.statusCode, 302, `shape ${url} should redirect`);
    assert.match(String(res.headers.location || ''), /discord\.com\/oauth2\/authorize/);
  }
});

test('oauth start rejects origin not in ALLOWED_ORIGINS', async () => {
  setEnv();
  process.env.DISCORD_CLIENT_ID = 'cid';
  process.env.DISCORD_CLIENT_SECRET = 'csecret';
  const res = await call('GET', '/api/auth/discord/start?return_to=https%3A%2F%2Fevil.example');
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /Origin Blogger/);
});

test('catalog hides pending comments and users from visitors', async () => {
  setEnv();
  const db = mockDatabase({
    catalog: {
      manga: [],
      chapters: [],
      comments: [
        { id: 'public', status: 'approved' },
        { id: 'private', status: 'pending' }
      ],
      users: [{ id: 'usr-admin', role: 'admin' }]
    }
  });
  try {
    const res = await call('GET', '/api/catalog');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json.comments.map((c) => c.id), ['public']);
    assert.equal(res.json.users, undefined);
  } finally {
    db.restore();
  }
});

test('admin session sees pending comments but still no users list', async () => {
  setEnv();
  const db = mockDatabase({
    catalog: {
      manga: [],
      chapters: [],
      comments: [
        { id: 'public', status: 'approved' },
        { id: 'private', status: 'pending' }
      ],
      users: [{ id: 'usr-admin', role: 'admin' }]
    }
  });
  try {
    const res = await call('GET', '/api/catalog', { Authorization: `Bearer ${adminToken()}` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json.comments.map((c) => c.id), ['public', 'private']);
    assert.equal(res.json.users, undefined);
  } finally {
    db.restore();
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
  const db = mockDatabase({
    catalog: {
      manga: [],
      chapters: [],
      comments: [],
      users: [{ id: 'usr-member', role: 'member' }]
    }
  });
  try {
    for (const headers of [
      {},
      { Authorization: 'Bearer bukan-token' },
      { Authorization: `Bearer ${member}` }
    ]) {
      const res = await call('POST', '/api/admin/save-manga', headers, { id: 'm1' });
      assert.equal(res.statusCode, 401);
      assert.match(res.json.error, /Sesi admin/);
    }
  } finally {
    db.restore();
  }
});

test('comment rejects unknown manga with validation error', async () => {
  setEnv();
  const db = mockDatabase({ catalog: { manga: [], chapters: [], comments: [], users: [] } });
  try {
    const res = await call('POST', '/api/comment', {}, {
      mangaId: 'tidak-ada',
      authorName: 'Pembaca',
      content: 'Komentar yang cukup baik.'
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'Manga tidak ditemukan.');
  } finally {
    db.restore();
  }
});

test('comment ignores client-sent identity when session exists', async () => {
  setEnv();
  const member = createSessionToken({
    id: 'usr-member-9',
    role: 'member',
    name: 'Budi Asli',
    email: 'budi@example.com',
    provider: 'google'
  });
  const db = mockDatabase({
    catalog: {
      manga: [{ id: 'm1', slug: 'judul', title: 'Judul', synopsis: 'Sinopsis yang cukup panjang untuk lolos validasi.', genres: [] }],
      chapters: [],
      comments: [],
      users: [{ id: 'usr-member-9', role: 'member', name: 'Budi Asli' }]
    }
  });
  try {
    const res = await call('POST', '/api/comment', { Authorization: `Bearer ${member}` }, {
      mangaId: 'm1',
      authorName: 'Akun Orang Lain',
      authorAvatar: 'https://evil.example/avatar.png',
      content: 'Komentar yang cukup panjang untuk lolos.'
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json.comment.userId, 'usr-member-9');
    assert.equal(res.json.comment.authorName, 'Budi Asli');
    assert.equal(res.json.comment.authorAvatar, null);
  } finally {
    db.restore();
  }
});

test('chapter reaction route toggles counts per chapter', async () => {
  setEnv();
  const db = mockDatabase({
    catalog: {
      manga: [{ id: 'm1', slug: 'judul', title: 'Judul', synopsis: 'Sinopsis yang cukup panjang untuk lolos validasi.', genres: [] }],
      chapters: [{ id: 'ch1', mangaId: 'm1', number: 1, pages: [] }],
      comments: [],
      users: []
    }
  });
  try {
    const res = await call('POST', '/api/chapter/reaction', {}, { chapterId: 'ch1', voterId: 'v1', reaction: 'fire' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.counts.fire, 1);
    assert.equal(res.json.userVote, 'fire');
    const again = await call('POST', '/api/chapter/reaction', {}, { chapterId: 'ch1', voterId: 'v1', reaction: 'fire' });
    assert.equal(again.json.counts.fire, 0);
    assert.equal(again.json.userVote, null);
  } finally {
    db.restore();
  }
});

test('comment accepts chapterId and stores it', async () => {
  setEnv();
  const db = mockDatabase({
    catalog: {
      manga: [{ id: 'm1', slug: 'judul', title: 'Judul', synopsis: 'Sinopsis yang cukup panjang untuk lolos validasi.', genres: [] }],
      chapters: [{ id: 'ch1', mangaId: 'm1', number: 1, pages: [] }],
      comments: [],
      users: []
    }
  });
  try {
    const res = await call('POST', '/api/comment', {}, {
      mangaId: 'm1',
      chapterId: 'ch1',
      authorName: 'Pembaca',
      content: 'Komentar untuk chapter 1 yang cukup panjang.'
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json.comment.chapterId, 'ch1');
  } finally {
    db.restore();
  }
});

test('catalog returns empty payload when database not yet initialized', async () => {
  setEnv();
  const db = mockDatabase({ initialized: false });
  try {
    const res = await call('GET', '/api/catalog');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { manga: [], chapters: [], comments: [] });
  } finally {
    db.restore();
  }
});

test('CORS allows configured blog origin even with quoted env value', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_STORAGE_CHAT_ID = '-100123';
  process.env.TOKEN_SECRET = 'test-secret-with-more-than-32-characters';
  process.env.ALLOWED_ORIGINS = '"https://nexa.example/"';
  process.env.PUBLIC_API_URL = 'https://nexa.example';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/testdb';
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
  const db = mockDatabase({
    catalog: {
      manga: [],
      chapters: [],
      comments: [],
      users: [{ id: 'usr-admin', role: 'admin', name: 'Admin', provider: 'google' }]
    }
  });
  try {
    const res = await call('GET', '/api/auth/me', { Authorization: `Bearer ${adminToken()}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.role, 'admin');
    assert.equal(res.json.user.id, 'usr-admin');
    assert.equal(res.json.user.name, 'Admin');
  } finally {
    db.restore();
  }
});

test('admin save-manga persists through Neon snapshot', async () => {
  setEnv();
  const db = mockDatabase({
    catalog: {
      manga: [],
      chapters: [],
      comments: [],
      users: [{ id: 'usr-admin', role: 'admin' }]
    }
  });
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
    assert.equal(db.state.data.manga.length, 1);
    assert.equal(db.state.data.manga[0].slug, 'judul-baru');
    assert.equal(db.state.version, 2);
  } finally {
    db.restore();
  }
});

test('concurrent modification returns 409 after retries', async () => {
  setEnv();
  const db = mockDatabase({
    catalog: {
      manga: [{
        id: 'mng-1',
        slug: 'judul-lama',
        title: 'Judul Lama',
        synopsis: 'Sinopsis yang cukup panjang untuk lolos validasi.',
        genres: ['Aksi'],
        rating: 4
      }],
      chapters: [],
      comments: [],
      users: [{ id: 'usr-admin', role: 'admin' }]
    },
    failCas: true
  });
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
    assert.equal(res.statusCode, 409);
    assert.match(res.json.error, /request lain/);
  } finally {
    db.restore();
  }
});

test('demoted admin loses access immediately', async () => {
  setEnv();
  const db = mockDatabase({
    catalog: {
      manga: [],
      chapters: [],
      comments: [],
      users: [{ id: 'usr-admin', role: 'member' }]
    }
  });
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
    assert.equal(res.statusCode, 401);
  } finally {
    db.restore();
  }
});

test('promoted member gains access immediately', async () => {
  setEnv();
  const member = createSessionToken({
    id: 'usr-member',
    role: 'member',
    name: 'Member',
    email: null,
    provider: 'google'
  });
  const db = mockDatabase({
    catalog: {
      manga: [],
      chapters: [],
      comments: [],
      users: [{ id: 'usr-member', role: 'admin', name: 'Member' }]
    }
  });
  try {
    const manga = {
      id: 'mng-1',
      slug: 'judul-baru',
      title: 'Judul Baru',
      synopsis: 'Sinopsis yang cukup panjang untuk lolos validasi.',
      genres: ['Aksi'],
      rating: 4
    };
    const res = await call('POST', '/api/admin/save-manga', { Authorization: `Bearer ${member}` }, manga);
    assert.equal(res.statusCode, 200);
  } finally {
    db.restore();
  }
});

test('deleted user session is rejected', async () => {
  setEnv();
  const db = mockDatabase({
    catalog: { manga: [], chapters: [], comments: [], users: [] }
  });
  try {
    const me = await call('GET', '/api/auth/me', { Authorization: `Bearer ${adminToken()}` });
    assert.equal(me.statusCode, 401);
    assert.match(me.json.error, /Akun tidak ditemukan/);
    const res = await call('POST', '/api/comment', { Authorization: `Bearer ${adminToken()}` }, {
      mangaId: 'm1',
      authorName: 'Admin',
      content: 'Komentar yang cukup panjang untuk lolos.'
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.json.error, /Akun tidak ditemukan/);
  } finally {
    db.restore();
  }
});

test('storage init creates snapshot once and rejects second attempt', async () => {
  setEnv();
  const db = mockDatabase({ initialized: false });
  try {
    const first = await call('POST', '/api/admin/storage/init', { Authorization: `Bearer ${adminToken()}` });
    assert.equal(first.statusCode, 201);
    assert.ok(db.state.data);
    db.state.data.users.push({ id: 'usr-admin', role: 'admin' });
    const second = await call('POST', '/api/admin/storage/init', { Authorization: `Bearer ${adminToken()}` });
    assert.equal(second.statusCode, 409);
  } finally {
    db.restore();
  }
});

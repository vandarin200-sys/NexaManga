'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/page.js');
const vercel = require('../vercel.json');

function responseHarness() {
  return {
    headers: {},
    statusCode: 0,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value; }
  };
}

function neonResult(rows, fields) {
  return Response.json({ command: 'OK', fields, rows, rowCount: rows.length });
}

function textFields(names) {
  return names.map((name) => ({ name, dataTypeID: 25 }));
}

function mockCatalog(data) {
  const realFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.endsWith('/sql')) return Response.json({ ok: false }, { status: 400 });
    const body = JSON.parse(init.body);
    const query = String(body.query || '');
    if (/CREATE TABLE IF NOT EXISTS/i.test(query) || /CREATE OR REPLACE VIEW/i.test(query)) {
      return neonResult([], []);
    }
    if (/SELECT data, version FROM nexamanga_snapshot/i.test(query)) {
      return neonResult([[JSON.stringify(data), '1']], textFields(['data', 'version']));
    }
    return Response.json({ message: 'unexpected query: ' + query }, { status: 400 });
  };
  return { restore() { global.fetch = realFetch; } };
}

const catalog = {
  manga: [{
    slug: 'judul-manga',
    title: 'Judul Manga',
    synopsis: 'Sinopsis untuk pratinjau Discord.'
  }],
  chapters: [],
  comments: [],
  users: [],
  settings: {
    siteName: 'Toko Manga',
    faviconUrl: 'https://cdn.example.com/favicon.png',
    siteNameColor: '#ff0000'
  }
};

test('page handler serves Discord-ready metadata for manga routes', async () => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/testdb';
  const db = mockCatalog(catalog);
  try {
    const res = responseHarness();
    await handler({
      method: 'GET',
      url: '/api/page?route=/manga/judul-manga',
      headers: { host: 'demo.example', 'x-forwarded-proto': 'https' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.body.includes('<title>Judul Manga — Toko Manga</title>'), true);
    assert.equal(res.body.includes('<meta property="og:title" content="Judul Manga — Toko Manga">'), true);
    assert.equal(res.body.includes('<meta property="og:description" content="Sinopsis untuk pratinjau Discord.">'), true);
    assert.equal(res.body.includes('<meta property="og:site_name" content="Toko Manga">'), true);
    assert.equal(res.body.includes('<link rel="icon" href="https://demo.example/favicon.ico">'), true);
    assert.equal(res.body.includes('<meta name="theme-color" content="#FF0000">'), true);
    assert.equal(res.body.includes('<meta name="twitter:card" content="summary">'), true);
    assert.equal(res.body.includes('<link rel="canonical" href="https://demo.example/manga/judul-manga">'), true);
  } finally {
    db.restore();
  }
});

test('page handler rejects non-GET methods', async () => {
  const res = responseHarness();
  await handler({ method: 'POST', url: '/api/page', headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
});

test('root route bypasses static index.html for server-rendered metadata', () => {
  assert.equal(vercel.routes.some((route) => route.src === '^/$' && route.dest === '/api/page?route=/'), true);
});

test('favicon.ico is rewritten to the dynamic admin favicon endpoint', () => {
  assert.equal(vercel.rewrites.some((rewrite) => rewrite.source === '/favicon.ico' && rewrite.destination === '/api/favicon.ico'), true);
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readCatalog } = require('../lib/db');
const { buildEmbed, injectEmbed } = require('../lib/embed');

const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');

function requestOrigin(req) {
  const forwarded = String((req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim();
  const protocol = /^https?:$/.test(forwarded) ? forwarded : 'https';
  const host = String((req.headers && req.headers['x-forwarded-host']) || (req.headers && req.headers.host) || 'localhost').split(',')[0].trim();
  return protocol + '://' + host;
}

function requestRoute(req, origin) {
  try {
    const url = new URL(req.url || '/', origin);
    const override = url.searchParams.get('route');
    if (override) return override;
    const route = url.pathname.replace(/^\/api\/page\/?/, '');
    return route || '/';
  } catch {
    return '/';
  }
}

async function readEmbedCatalog() {
  try {
    return await readCatalog();
  } catch {
    return { manga: [], settings: {} };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    return res.end();
  }

  const origin = requestOrigin(req);
  const catalog = await readEmbedCatalog();
  const embed = buildEmbed(catalog, requestRoute(req, origin), origin);
  const html = injectEmbed(fs.readFileSync(INDEX_PATH, 'utf8'), embed);

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(req.method === 'HEAD' ? '' : html);
};

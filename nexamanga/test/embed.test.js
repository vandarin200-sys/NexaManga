'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEmbed, injectEmbed, escapeAttr } = require('../lib/embed');

const catalog = {
  settings: {
    siteName: 'Toko Manga',
    siteTagline: 'Baca manga favoritmu.',
    logoUrl: '/logo.png',
    faviconUrl: 'https://cdn.example.com/favicon.png',
    siteNameColor: '#ff0000'
  },
  manga: [{
    slug: 'judul-manga',
    title: 'Judul Manga',
    synopsis: '  Sinopsis   manga   yang  menarik.  ',
    coverBloggerUrl: 'https://img.example/cover.jpg'
  }]
};

test('buildEmbed uses generic metadata for home with no admin settings', () => {
  const embed = buildEmbed({ manga: [], settings: {} }, '/', 'https://demo.example');
  assert.equal(embed.title, 'Archive Manga');
  assert.equal(embed.description, 'Arsip manga berbahasa Indonesia.');
  assert.equal(embed.type, 'website');
  assert.equal(embed.image, '');
  assert.equal(embed.favicon, '');
  assert.equal(embed.themeColor, '');
  assert.equal(embed.siteName, 'Archive Manga');
  assert.equal(embed.twitterCard, 'summary');
  assert.equal(embed.url, 'https://demo.example/');
});

test('buildEmbed uses manga title synopsis and cover for detail routes', () => {
  const embed = buildEmbed(catalog, '/manga/judul-manga', 'https://demo.example');
  assert.equal(embed.title, 'Judul Manga — Toko Manga');
  assert.equal(embed.description, 'Sinopsis manga yang menarik.');
  assert.equal(embed.type, 'article');
  assert.equal(embed.image, 'https://img.example/cover.jpg');
  assert.equal(embed.favicon, 'https://demo.example/favicon.ico');
  assert.equal(embed.themeColor, '#FF0000');
  assert.equal(embed.siteName, 'Toko Manga');
  assert.equal(embed.twitterCard, 'summary_large_image');
  assert.equal(embed.url, 'https://demo.example/manga/judul-manga');
});

test('buildEmbed clips long synopsis and falls back to site logo', () => {
  const data = {
    settings: { logoUrl: '/logo.png' },
    manga: [{ slug: 'panjang', title: 'Panjang', synopsis: 'x'.repeat(200) }]
  };
  const embed = buildEmbed(data, '/manga/panjang', 'https://demo.example');
  assert.equal(embed.description.length, 160);
  assert.equal(embed.description.endsWith('\u2026'), true);
  assert.equal(embed.image, 'https://demo.example/logo.png');
});

test('buildEmbed expands short hex site color for theme-color', () => {
  const embed = buildEmbed({ manga: [], settings: { siteNameColor: '#abc' } }, '/', 'https://demo.example');
  assert.equal(embed.themeColor, '#AABBCC');
});

test('injectEmbed replaces duplicate metadata and adds canonical link', () => {
  const html = '<!DOCTYPE html><html><head><title>old</title><meta name="description" content="old"><meta property="og:title" content="old"><meta property="og:title" content="dup"><meta name="theme-color" content="old"></head><body>ok</body></html>';
  const embed = buildEmbed(catalog, '/manga/judul-manga', 'https://demo.example');
  const output = injectEmbed(html, embed);
  assert.equal(output.match(/og:title/g).length, 1);
  assert.equal(output.includes('<title>Judul Manga — Toko Manga</title>'), true);
  assert.equal(output.includes('<meta property="og:title" content="Judul Manga — Toko Manga">'), true);
  assert.equal(output.includes('<meta property="og:site_name" content="Toko Manga">'), true);
  assert.equal(output.includes('<link rel="canonical" href="https://demo.example/manga/judul-manga">'), true);
  assert.equal(output.includes('<link rel="icon" href="https://demo.example/favicon.ico">'), true);
  assert.equal(output.match(/name="theme-color"/g).length, 1);
  assert.equal(output.includes('<meta name="theme-color" content="#FF0000">'), true);
  assert.equal(output.includes('<meta name="twitter:card" content="summary_large_image">'), true);
});

test('escapeAttr protects markup in metadata values', () => {
  assert.equal(escapeAttr('A "B" & <C>'), 'A &quot;B&quot; &amp; &lt;C&gt;');
});

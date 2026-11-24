'use strict';

const DEFAULT_TITLE = 'Katalog Manga';
const DEFAULT_DESCRIPTION = 'Katalog manga berbahasa Indonesia.';
const DEFAULT_THEME_COLOR = '#F7F1E6';

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value, max) {
  const text = clean(value);
  return text.length > max ? text.slice(0, max - 1).trim() + '\u2026' : text;
}

function normalizeColor(value) {
  const color = clean(value);
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return '#' + color.slice(1).split('').map((char) => char + char).join('').toUpperCase();
  }
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)) return color.toUpperCase();
  return '';
}

function absoluteUrl(value, base) {
  if (!value) return '';
  try {
    const url = new URL(String(value), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function buildEmbed(catalog, routePath, origin) {
  const settings = (catalog && catalog.settings) || {};
  const name = clean(settings.siteName);
  const descriptionBase = clean(settings.siteTagline) || DEFAULT_DESCRIPTION;
  const mangaList = (catalog && catalog.manga) || [];
  const path = clean(routePath).split('?')[0] || '/';
  const parts = path.split('/').filter(Boolean);
  let title = name || DEFAULT_TITLE;
  let description = descriptionBase;
  let image = absoluteUrl(settings.logoUrl, origin);
  const favicon = absoluteUrl(settings.faviconUrl, origin) ? absoluteUrl('/favicon.ico', origin) : '';
  const themeColor = normalizeColor(settings.siteNameColor);
  let type = 'website';

  if (parts[0] === 'manga' && parts[1]) {
    const manga = mangaList.find((item) => item && item.slug === parts[1]);
    if (manga) {
      title = clean(manga.title) + (name ? ' — ' + name : '');
      description = clip(manga.synopsis || ('Baca ' + clean(manga.title) + ' di katalog manga berbahasa Indonesia.'), 160);
      image = absoluteUrl(manga.coverBloggerUrl, origin) || image;
      type = 'article';
    }
  }

  let canonical = absoluteUrl(path, origin);
  if (!canonical) canonical = absoluteUrl('/', origin);

  return {
    title: title || DEFAULT_TITLE,
    description: description || DEFAULT_DESCRIPTION,
    image,
    favicon,
    themeColor,
    type,
    url: canonical,
    siteName: name || DEFAULT_TITLE,
    twitterCard: image ? 'summary_large_image' : 'summary'
  };
}

function escapeAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeMeta(html, attr, key) {
  const pattern = new RegExp('<meta\\s+[^>]*' + attr + '\\s*=\\s*["\\\']' + escapeRegExp(key) + '["\\\'][^>]*>', 'gi');
  return html.replace(pattern, '');
}

function removeCanonical(html) {
  return html.replace(/<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*>/gi, '');
}

function removeIconLinks(html) {
  return html.replace(/<link\s+[^>]*rel\s*=\s*["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*>/gi, '');
}

function metaTag(attr, key, value) {
  if (!value) return '';
  return '<meta ' + attr + '="' + key + '" content="' + escapeAttr(value) + '">';
}

function injectEmbed(html, embed) {
  let output = String(html || '');
  const keys = [
    ['name', 'description'],
    ['property', 'og:type'],
    ['property', 'og:title'],
    ['property', 'og:description'],
    ['property', 'og:url'],
    ['property', 'og:image'],
    ['property', 'og:site_name'],
    ['name', 'twitter:card'],
    ['name', 'twitter:title'],
    ['name', 'twitter:description'],
    ['name', 'twitter:image'],
    ['name', 'theme-color']
  ];
  keys.forEach(function (entry) { output = removeMeta(output, entry[0], entry[1]); });
  output = removeCanonical(output);
  output = removeIconLinks(output);
  output = output.replace(/<title[^>]*>[\s\S]*?<\/title\s*>/i, function () {
    return '<title>' + escapeAttr(embed.title) + '</title>';
  });

  const tags = [
    metaTag('name', 'description', embed.description),
    metaTag('property', 'og:type', embed.type),
    metaTag('property', 'og:title', embed.title),
    metaTag('property', 'og:description', embed.description),
    metaTag('property', 'og:url', embed.url),
    metaTag('property', 'og:image', embed.image),
    metaTag('property', 'og:site_name', embed.siteName),
    metaTag('name', 'twitter:card', embed.twitterCard),
    metaTag('name', 'twitter:title', embed.title),
    metaTag('name', 'twitter:description', embed.description),
    metaTag('name', 'twitter:image', embed.image),
    (embed.url ? '<link rel="canonical" href="' + escapeAttr(embed.url) + '">' : ''),
    metaTag('name', 'theme-color', embed.themeColor || DEFAULT_THEME_COLOR),
    (embed.favicon ? '<link rel="icon" href="' + escapeAttr(embed.favicon) + '">' : ''),
    (embed.favicon ? '<link rel="shortcut icon" href="' + escapeAttr(embed.favicon) + '">' : '')
  ].filter(Boolean).join('\n  ');

  if (/<head[^>]*>/i.test(output)) {
    return output.replace(/<head[^>]*>/i, function (match) {
      return match + '\n  ' + tags;
    });
  }
  if (/<\/head\s*>/i.test(output)) {
    return output.replace(/<\/head\s*>/i, function () {
      return '  ' + tags + '\n</head>';
    });
  }
  return output;
}

module.exports = { buildEmbed, injectEmbed, escapeAttr };

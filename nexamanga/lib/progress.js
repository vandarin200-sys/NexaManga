'use strict';

const LEVEL_STEP = 220;
const MAX_LEVEL = 100;
const XP_ACTIVITIES = Object.freeze(['welcome', 'comment_approved', 'manga_view', 'reaction']);
const TIERS = Object.freeze([
  { slug: 'novice', name: 'Novice', min: 1, max: 4, prestige: 0 },
  { slug: 'apprentice', name: 'Apprentice', min: 5, max: 9, prestige: 1 },
  { slug: 'bronze', name: 'Bronze', min: 10, max: 19, prestige: 2 },
  { slug: 'silver', name: 'Silver', min: 20, max: 29, prestige: 3 },
  { slug: 'gold', name: 'Gold', min: 30, max: 39, prestige: 4 },
  { slug: 'platinum', name: 'Platinum', min: 40, max: 49, prestige: 5 },
  { slug: 'emerald', name: 'Emerald', min: 50, max: 59, prestige: 6 },
  { slug: 'ruby', name: 'Ruby', min: 60, max: 69, prestige: 7 },
  { slug: 'diamond', name: 'Diamond', min: 70, max: 74, prestige: 8 },
  { slug: 'master', name: 'Master', min: 75, max: 79, prestige: 9 },
  { slug: 'radiant', name: 'Radiant', min: 80, max: Infinity, prestige: 10 }
]);
const DIVISIONS = Object.freeze(['III', 'II', 'I']);

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeUsername(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '')
    .replace(/^_+|_+$/g, '') || 'member';
}

function levelFromXp(xp) {
  return Math.min(MAX_LEVEL, Math.max(1, 1 + Math.floor(Math.max(0, numberValue(xp)) / LEVEL_STEP)));
}

function tierForLevel(level) {
  const value = Math.max(1, Math.floor(numberValue(level, 1)));
  const tier = TIERS.find((item) => value >= item.min && value <= item.max) || TIERS[TIERS.length - 1];
  const division = tier.max === Infinity
    ? ''
    : (DIVISIONS[Math.floor((value - tier.min) * 3 / (tier.max - tier.min + 1))] || '');
  return {
    slug: tier.slug,
    name: tier.name,
    min: tier.min,
    max: tier.max === Infinity ? null : tier.max,
    prestige: tier.prestige,
    division
  };
}

function progressFromXp(xp) {
  const total = Math.max(0, Math.floor(numberValue(xp)));
  const level = levelFromXp(total);
  const maxed = level >= MAX_LEVEL;
  const xpIntoLevel = maxed ? LEVEL_STEP : total % LEVEL_STEP;
  return {
    level,
    xp_into_level: xpIntoLevel,
    level_cost: LEVEL_STEP,
    percent: Math.round((xpIntoLevel / LEVEL_STEP) * 100),
    tier: tierForLevel(level)
  };
}

function rangeSince(range) {
  const now = new Date();
  if (range === 'day') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
  if (range === 'month') return new Date(now.getTime() - 30 * 86400000).toISOString();
  if (range === 'all') return new Date(0).toISOString();
  return new Date(now.getTime() - 7 * 86400000).toISOString();
}

function serializeProgress(row, rank = null, score = null) {
  if (!row) return null;
  const totalXp = Math.max(0, Math.floor(numberValue(row.total_xp !== undefined ? row.total_xp : row.xp)));
  const rangeScore = score === null ? totalXp : Math.max(0, Math.floor(numberValue(score)));
  return Object.assign({
    rank: rank === null ? null : Math.max(1, Math.floor(numberValue(rank, 1))),
    user_id: String(row.user_id || ''),
    username: String(row.username || normalizeUsername(row.name)),
    name: String(row.name || ''),
    avatar: row.avatar ? String(row.avatar) : null,
    avatar_frame: null,
    name_style: null,
    total_xp: totalXp,
    score: rangeScore,
    streak_days: Math.max(0, Math.floor(numberValue(row.streak_days)))
  }, progressFromXp(totalXp));
}

module.exports = {
  LEVEL_STEP,
  MAX_LEVEL,
  XP_ACTIVITIES,
  levelFromXp,
  normalizeUsername,
  progressFromXp,
  rangeSince,
  serializeProgress,
  tierForLevel
};

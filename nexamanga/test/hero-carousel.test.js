'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  heroNormalizeIndex,
  heroWrapCenter,
  heroWrappedOffset,
  heroVirtualTarget,
  heroCanonicalVirtual,
  heroDragProgress,
  heroDragDecision
} = require('../lib/hero-carousel');

test('heroNormalizeIndex wraps negative and overflow indexes without undefined', () => {
  assert.equal(heroNormalizeIndex(-1, 10), 9);
  assert.equal(heroNormalizeIndex(10, 10), 0);
  assert.equal(heroNormalizeIndex(-20, 3), 1);
  assert.equal(heroNormalizeIndex(undefined, 10), 0);
  assert.equal(heroNormalizeIndex(4, 0), 0);
});

test('heroWrappedOffset uses true circular distance for every count', () => {
  assert.equal(heroWrappedOffset(0, 2, 3), 1);
  assert.equal(heroWrappedOffset(0, 4, 6), 2);
  assert.equal(heroWrappedOffset(0, 9, 10), 1);
  assert.equal(heroWrappedOffset(9, 0, 10), -1);
  assert.equal(heroWrappedOffset(4, 0, 10), -6 + 10);
  assert.equal(heroWrappedOffset(1, 1, 1), 0);
  assert.equal(heroWrapCenter(-0.5, 10), 9.5);
  assert.equal(heroWrappedOffset(0, 9.5, 10), 0.5);
  assert.equal(heroWrappedOffset(1, 9.5, 10), 1.5);
  assert.equal(heroWrappedOffset(0, -0.5, 10), 0.5);
});

test('heroVirtualTarget handles clone wrap in both directions', () => {
  assert.deepEqual(heroVirtualTarget(9, 0, 'next', 10), {
    current: 9, target: 0, direction: 'next', virtual: 11, canonicalVirtual: 1, clone: true
  });
  assert.deepEqual(heroVirtualTarget(0, 9, 'prev', 10), {
    current: 0, target: 9, direction: 'prev', virtual: 0, canonicalVirtual: 10, clone: true
  });
  assert.deepEqual(heroVirtualTarget(3, 4, undefined, 10), {
    current: 3, target: 4, direction: 'next', virtual: 5, canonicalVirtual: 5, clone: false
  });
  assert.equal(heroCanonicalVirtual(0, 10), 10);
  assert.equal(heroCanonicalVirtual(11, 10), 1);
});

test('heroDragDecision advances exactly once and clamps overshoot', () => {
  assert.deepEqual(heroDragDecision(-60, 0, 48, 0, 10), { index: 1, direction: 'next' });
  assert.deepEqual(heroDragDecision(-30, 0.5, 48, 0, 10), { index: 1, direction: 'next' });
  assert.deepEqual(heroDragDecision(60, 0, 48, 0, 10), { index: 9, direction: 'prev' });
  assert.deepEqual(heroDragDecision(30, 0.5, 48, 0, 10), { index: 9, direction: 'prev' });
  assert.deepEqual(heroDragDecision(10, 0.1, 48, 0, 10), { index: 0, direction: '' });
  assert.equal(heroDragProgress(-1000, 108), 1);
  assert.equal(heroDragProgress(1000, 108), -1);
});

test('rapid circular swipes never leave stale or out-of-range indexes', () => {
  const count = 10;
  for (let start = 0; start < count; start += 1) {
    let current = start;
    let virtual = current + 1;
    for (let step = 0; step < 20; step += 1) {
      const next = heroNormalizeIndex(current + 1, count);
      const plan = heroVirtualTarget(current, next, 'next', count);
      assert.equal(plan.target, next);
      current = plan.target;
      virtual = heroCanonicalVirtual(plan.virtual, count);
      assert.ok(virtual >= 1 && virtual <= count);
      assert.equal(virtual, current + 1);
    }
    for (let step = 0; step < 20; step += 1) {
      const previous = heroNormalizeIndex(current - 1, count);
      const plan = heroVirtualTarget(current, previous, 'prev', count);
      assert.equal(plan.target, previous);
      current = plan.target;
      virtual = heroCanonicalVirtual(plan.virtual, count);
      assert.ok(virtual >= 1 && virtual <= count);
      assert.equal(virtual, current + 1);
    }
    for (let step = 0; step < 20; step += 1) {
      const direction = step % 2 === 0 ? 'next' : 'prev';
      const next = heroNormalizeIndex(current + (direction === 'next' ? 1 : -1), count);
      const plan = heroVirtualTarget(current, next, direction, count);
      current = plan.target;
      virtual = heroCanonicalVirtual(plan.virtual, count);
      assert.ok(virtual >= 1 && virtual <= count);
      assert.equal(virtual, current + 1);
    }
  }
});

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

function normalize(source) {
  return source.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

test('inline carousel helpers mirror the tested module in both frontends', () => {
  const names = ['heroNormalizeIndex', 'heroWrapCenter', 'heroWrappedOffset', 'heroVirtualTarget', 'heroCanonicalVirtual', 'heroDragProgress', 'heroDragDecision'];
  const libSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'hero-carousel.js'), 'utf8');
  const targets = [
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, '..', '..', 'nexamanga.xml')
  ];
  for (const target of targets) {
    const source = fs.readFileSync(target, 'utf8');
    assert.ok(!source.includes('var half = Math.max(4, count / 2);'), target + ' still has fixed half-range');
    for (const name of names) {
      const expected = normalize(extractFunction(libSource, name));
      const actual = normalize(extractFunction(source, name));
      assert.ok(expected, 'missing ' + name + ' in library');
      assert.equal(actual, expected, target + ' has stale ' + name);
    }
  }
});

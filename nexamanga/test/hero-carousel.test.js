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
  heroAdvance,
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
  assert.equal(heroVirtualTarget(8, 0, undefined, 10).direction, 'next');
  assert.equal(heroVirtualTarget(1, 9, undefined, 10).direction, 'prev');
  assert.deepEqual(heroVirtualTarget(8, 1, 'next', 10), {
    current: 8, target: 1, direction: 'next', virtual: 12, canonicalVirtual: 2, clone: true
  });
  assert.deepEqual(heroVirtualTarget(1, 8, 'prev', 10), {
    current: 1, target: 8, direction: 'prev', virtual: -1, canonicalVirtual: 9, clone: true
  });
});

test('heroAdvance wraps forward and backward without a terminal index', () => {
  const count = 10;
  assert.deepEqual(heroAdvance(0, 'prev', count), { index: 9, direction: 'prev' });
  assert.deepEqual(heroAdvance(9, 'next', count), { index: 0, direction: 'next' });
  assert.deepEqual(heroAdvance(-3, 'next', count), { index: 8, direction: 'next' });
  assert.deepEqual(heroAdvance(23, 'prev', count), { index: 2, direction: 'prev' });
  assert.deepEqual(heroAdvance(4, 'next', count, 7), { index: 1, direction: 'next' });
  assert.deepEqual(heroAdvance(4, '', count), { index: 4, direction: '' });
  assert.deepEqual(heroAdvance(0, 'next', 1), { index: 0, direction: '' });
});

test('heroDragDecision advances once for a short swipe without bounding the pointer pose', () => {
  assert.deepEqual(heroDragDecision(-60, 0, 48, 0, 10), { index: 1, direction: 'next', steps: 1 });
  assert.deepEqual(heroDragDecision(-30, 0.5, 48, 0, 10), { index: 1, direction: 'next', steps: 1 });
  assert.deepEqual(heroDragDecision(60, 0, 48, 0, 10), { index: 9, direction: 'prev', steps: 1 });
  assert.deepEqual(heroDragDecision(30, 0.5, 48, 0, 10), { index: 9, direction: 'prev', steps: 1 });
  assert.deepEqual(heroDragDecision(10, 0.1, 48, 0, 10), { index: 0, direction: '', steps: 0 });
  assert.equal(heroDragProgress(-1000, 108), 1000 / 108);
  assert.equal(heroDragProgress(1000, 108), -1000 / 108);
});

test('a long drag keeps counting past the card count and wraps around forever', () => {
  const threshold = 45;
  const travel = 108;
  assert.deepEqual(heroDragDecision(-95, 0, threshold, 0, 10, travel), { index: 1, direction: 'next', steps: 1 });
  assert.deepEqual(heroDragDecision(-190, 0, threshold, 0, 10, travel), { index: 2, direction: 'next', steps: 2 });
  assert.deepEqual(heroDragDecision(-310, 0, threshold, 0, 10, travel), { index: 3, direction: 'next', steps: 3 });
  assert.deepEqual(heroDragDecision(-900, 0, threshold, 0, 10, travel), { index: 8, direction: 'next', steps: 8 });
  assert.deepEqual(heroDragDecision(900, 0, threshold, 0, 10, travel), { index: 2, direction: 'prev', steps: 8 });
  assert.deepEqual(heroDragDecision(-2637, 0, threshold, 0, 10, travel), { index: 5, direction: 'next', steps: 25 });
  assert.equal(heroDragProgress(-900, travel), 900 / travel);
  assert.equal(heroDragProgress(900, travel), -900 / travel);
});

test('unlimited circular plans stay inside the clone range for every start card', () => {
  const count = 10;
  for (let from = 0; from < count; from += 1) {
    for (let steps = 1; steps <= 25; steps += 1) {
      for (const direction of ['next', 'prev']) {
        const move = heroAdvance(from, direction, count, steps);
        const plan = heroVirtualTarget(from, move.index, direction, count, steps);
        assert.equal(plan.target, move.index);
        assert.ok(
          plan.virtual >= 1 - count && plan.virtual <= count * 2,
          direction + ' ' + steps + ' from ' + from + ' virtual ' + plan.virtual
        );
        assert.equal(heroCanonicalVirtual(plan.virtual, count), move.index + 1);
      }
    }
  }
  assert.equal(heroVirtualTarget(0, 0, 'next', count, count).virtual, count + 1);
  assert.equal(heroVirtualTarget(0, 0, 'prev', count, count).virtual, 1 - count);
});

test('sequential swipes stay in sync from slide one through ten and back', () => {
  const count = 10;
  let current = 0;
  for (let step = 1; step <= 20; step += 1) {
    const move = heroAdvance(current, 'next', count, 1);
    const plan = heroVirtualTarget(current, move.index, move.direction, count);
    assert.equal(plan.target, move.index);
    assert.equal(heroCanonicalVirtual(plan.virtual, count), move.index + 1);
    current = plan.target;
  }
  assert.equal(current, 0);
  for (let step = 0; step < 20; step += 1) {
    const move = heroAdvance(current, 'prev', count, 1);
    const plan = heroVirtualTarget(current, move.index, move.direction, count);
    assert.equal(plan.target, move.index);
    assert.equal(heroCanonicalVirtual(plan.virtual, count), move.index + 1);
    current = plan.target;
  }
  assert.equal(current, 0);
  for (let step = 0; step < 20; step += 1) {
    const move = heroAdvance(current, step % 2 === 0 ? 'next' : 'prev', count, 1);
    const plan = heroVirtualTarget(current, move.index, move.direction, count);
    assert.equal(plan.direction, step % 2 === 0 ? 'next' : 'prev');
    assert.equal(heroCanonicalVirtual(plan.virtual, count), move.index + 1);
    current = plan.target;
  }
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
  const names = ['heroNormalizeIndex', 'heroWrapCenter', 'heroWrappedOffset', 'heroVirtualTarget', 'heroCanonicalVirtual', 'heroAdvance', 'heroDragProgress', 'heroDragDecision'];
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

function simulateRuntime(target) {
  const source = fs.readFileSync(target, 'utf8');
  const names = [
    'heroNormalizeIndex', 'heroWrapCenter', 'heroWrappedOffset', 'heroVirtualTarget',
    'heroCanonicalVirtual', 'heroAdvance', 'heroDragProgress', 'heroDragDecision',
    'yzHeroWrappedOffset', 'yzHeroThumbPose', 'yzHeroApplyPoses', 'bumpHeroTrackToken',
    'heroSwipeDuration', 'commitHeroState', 'finalizeHeroTrack', 'syncHeroDots', 'setHeroSlide'
  ];
  const state = {
    route: 'home', heroCount: 10, heroSlide: 0, yzHeroIndex: 0, heroTrackPosition: 1,
    heroAnimDir: '', heroAnimating: false, heroDragActive: false, heroDragOffset: 0, heroDragged: false
  };
  const thumbs = Array.from({ length: 10 }, (_, id) => {
    const attrs = { 'data-hero-card-id': String(id), 'data-center': id === 0 ? 'true' : 'false' };
    const shade = { style: {}, className: 'transition-opacity' };
    const gradient = { style: {}, className: 'yz-hero-thumb-gradient' };
    return {
      style: {}, className: 'yz-hero-thumb hover:border-white/20', attrs,
      getAttribute: (key) => attrs[key] || null,
      setAttribute(key, value) { attrs[key] = String(value); },
      querySelector: (selector) => (selector.indexOf('yz-hero-thumb-gradient') >= 0 ? gradient : shade)
    };
  });
  const dots = Array.from({ length: 10 }, (_, id) => ({
    style: {}, className: id === 0 ? 'w-6' : 'w-1.5 bg-zinc-700 hover:bg-zinc-500', attrs: {},
    getAttribute: (key) => (key === 'data-color' ? '#fff' : null),
    setAttribute(key, value) { this.attrs[key] = String(value); },
    removeAttribute() {}
  }));
  const slides = Array.from({ length: 12 }, () => ({ attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } }));
  const track = {
    dataset: {}, style: {}, offsetWidth: 1, attrs: {},
    addEventListener() {}, removeEventListener() {}, setAttribute(key, value) { this.attrs[key] = value; }
  };
  const carousel = {
    querySelector(selector) {
      if (selector.indexOf('hero-track') >= 0) return track;
      if (selector.indexOf('hero-dot') >= 0) return dots.find((dot) => dot.className.indexOf('w-6') >= 0) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.indexOf('yz-hero-thumb') >= 0) return thumbs;
      if (selector.indexOf('hero-dot') >= 0) return dots;
      return slides;
    }
  };
  const documentMock = { querySelector: (selector) => (selector.indexOf('hero-carousel') >= 0 ? carousel : null) };
  const windowMock = { getComputedStyle: () => ({ transitionDuration: '0.28s' }) };
  const runtime = new Function(
    'state', 'document', 'window', 'prefersReducedMotion', 'setTimeout', 'clearTimeout',
    names.map((name) => extractFunction(source, name)).join('\n') +
      '\nreturn { setHeroSlide, finalizeHeroTrack, heroAdvance, heroDragDecision };'
  )(state, documentMock, windowMock, () => false, () => 1, () => {});

  const assertCoherent = (label, index) => {
    assert.equal(state.heroSlide, index, label + ' slide');
    assert.equal(state.yzHeroIndex, index, label + ' mirror index');
    assert.equal(state.heroAnimating, false, label + ' animation lock');
    assert.equal(track.style.transform, 'translate3d(-' + ((index + 1) * 100) + '%, 0px, 0px)', label + ' track');
    const center = thumbs.find((thumb) => thumb.getAttribute('data-center') === 'true');
    assert.equal(center && center.getAttribute('data-hero-card-id'), String(index), label + ' center card');
    const activeDot = dots.find((dot) => dot.className.indexOf('w-6') >= 0);
    assert.equal(dots.indexOf(activeDot), index, label + ' active dot');
  };

  let index = 0;
  for (let step = 0; step < 20; step += 1) {
    const move = runtime.heroAdvance(index, 'next', state.heroCount, 1);
    runtime.setHeroSlide(move.index, move.direction);
    runtime.finalizeHeroTrack(track);
    index = move.index;
    assertCoherent(target + ' next ' + (step + 1), index);
  }
  for (let step = 0; step < 20; step += 1) {
    const move = runtime.heroAdvance(index, 'prev', state.heroCount, 1);
    runtime.setHeroSlide(move.index, move.direction);
    runtime.finalizeHeroTrack(track);
    index = move.index;
    assertCoherent(target + ' prev ' + (step + 1), index);
  }
  for (let step = 0; step < 20; step += 1) {
    const direction = step % 2 === 0 ? 'next' : 'prev';
    const move = runtime.heroAdvance(index, direction, state.heroCount, 1);
    runtime.setHeroSlide(move.index, move.direction);
    if (step % 3 === 0) runtime.setHeroSlide(state.heroSlide, '');
    runtime.finalizeHeroTrack(track);
    index = move.index;
    assertCoherent(target + ' alternating ' + (step + 1), index);
  }
  for (const swipeSteps of [3, 10, 17, 26]) {
    const decision = runtime.heroDragDecision(
      -(45 + (swipeSteps - 1) * 108), 0, 45, index, state.heroCount, 108
    );
    runtime.setHeroSlide(decision.index, decision.direction, decision.steps);
    runtime.finalizeHeroTrack(track);
    index = decision.index;
    assertCoherent(target + ' cursor drag ' + swipeSteps, index);
  }
}

test('runtime carousel stays coherent through 60 swipes and interrupted calls', () => {
  simulateRuntime(path.join(__dirname, '..', 'public', 'index.html'));
  simulateRuntime(path.join(__dirname, '..', '..', 'nexamanga.xml'));
});

test('render settles the hero track before generating slide markup', () => {
  const targets = [
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, '..', '..', 'nexamanga.xml')
  ];
  for (const target of targets) {
    const source = fs.readFileSync(target, 'utf8');
    const renderStart = source.indexOf('function render()');
    const markupStart = source.indexOf("var bodyHtml = '';", renderStart);
    const finalize = source.indexOf("finalizeHeroTrack(document.querySelector('[data-hero-track]'))", renderStart);
    assert.ok(renderStart >= 0 && markupStart > renderStart, target + ' has no render markup point');
    assert.ok(finalize > renderStart && finalize < markupStart, target + ' generates slides from a stale track position');
    assert.ok(source.includes('Number(m.rating) || 0'), target + ' shows an index-derived score instead of manga rating');
  }
});

test('both frontends keep cursor swipes from starting a native image drag', () => {
  const targets = [
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, '..', '..', 'nexamanga.xml')
  ];
  for (const target of targets) {
    const source = fs.readFileSync(target, 'utf8');
    assert.ok(
      source.includes("thumbs.addEventListener('dragstart', function (e) { e.preventDefault(); });"),
      target + ' has no cursor drag guard'
    );
    assert.ok(source.includes('-webkit-user-drag:none'), target + ' still allows native image dragging');
  }
});

test('header theme button opens the full theme list instead of toggling light and dark', () => {
  const targets = [
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, '..', '..', 'nexamanga.xml')
  ];
  for (const target of targets) {
    const source = fs.readFileSync(target, 'utf8');
    assert.ok(!source.includes('data-action="toggle-theme"'), target + ' still has the old toggle button');
    assert.ok(source.includes('data-action="toggle-header-theme"'), target + ' has no theme list trigger');
    assert.ok(source.includes('renderThemeListMenu()'), target + ' never renders the theme list');
    assert.ok(source.includes('headerThemeOpen: false'), target + ' has no theme list state');
    assert.ok(source.includes('if (!insideThemeMenu && state.headerThemeOpen) state.headerThemeOpen = false;'), target + ' cannot close the theme list');
    assert.ok(source.includes("e.key === 'Escape' && state.headerThemeOpen"), target + ' theme list has no Escape handling');
    assert.ok(source.includes('state.headerThemeOpen = false; state.theme = nextTheme;'), target + ' theme list stays open after selection');
  }
});

test('light theme is honored on every route instead of being forced dark', () => {
  const targets = [
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, '..', '..', 'nexamanga.xml')
  ];
  for (const target of targets) {
    const source = fs.readFileSync(target, 'utf8');
    assert.ok(!source.includes("setAttribute('data-theme', 'yumezone')"), target + ' still forces the yumezone theme');
    assert.ok(!source.includes('classList.add(\'dark\')'), target + ' still forces the dark class from render');
    assert.ok(source.includes('html[data-resolved-theme="light"]'), target + ' has no light theme overrides');
    assert.ok(source.includes('--yz-bg: #F7F1E6'), target + ' has no light surface tokens');
    assert.ok(source.includes("state.readerBackground = resolved === 'dark' ? '#000000' : '#F7F1E6'"), target + ' reader background ignores the resolved theme');
    assert.ok(!source.includes('min-h-screen bg-black text-[#f0f0f5]'), target + ' still hardcodes a dark public shell');
  }
  const lightCoverage = targets.map(function (target) {
    return fs.readFileSync(target, 'utf8').split('html[data-resolved-theme="light"]').length - 1;
  });
  assert.strictEqual(lightCoverage[0], lightCoverage[1], 'frontends have different light override coverage');
});

test('light theme restyles the landing catalog and the hero stage', () => {
  const targets = [
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, '..', '..', 'nexamanga.xml')
  ];
  for (const target of targets) {
    const source = fs.readFileSync(target, 'utf8');
    assert.ok(source.includes('body.kv-home-route #manga-library-catalog { background: var(--yz-surface-0)'), target + ' landing library is not light');
    assert.ok(source.includes('button[data-action="quick-genre"][data-landing="1"][data-active="true"]'), target + ' landing genre chips have no light active state');
    assert.ok(source.includes('data-active="'), target + ' landing genre chips have no active state marker');
    assert.ok(source.includes('body.kv-home-route [data-hero-carousel] { background: var(--yz-surface-0)'), target + ' hero stage is not light');
    assert.ok(!source.includes('body.kv-public-route [data-hero-carousel] { background: #0B0E17'), target + ' hero stage still has a dark light-theme override');
    assert.ok(!source.includes('[class*="bg-black/"] { background-color: var(--yz-surface-0)'), target + ' still has a broad overlay-breaking background override');
  }
});

test('light theme keeps account name and settings surfaces readable', () => {
  const targets = [
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, '..', '..', 'nexamanga.xml')
  ];
  for (const target of targets) {
    const source = fs.readFileSync(target, 'utf8');
    assert.ok(source.includes('data-account-name'), target + ' account name has no theme hook');
    assert.ok(source.includes('body.kv-account-route [data-account-name]'), target + ' account name has no light-theme color rule');
    assert.ok(source.includes('data-settings-root'), target + ' settings route has no theme hook');
    assert.ok(source.includes('[class~="bg-[#111214]"]'), target + ' settings dialog background stays dark');
    assert.ok(source.includes('[class~="placeholder-zinc-600"]'), target + ' settings placeholders stay dark');
    assert.ok(source.includes('[class~="bg-red-600"], [class~="bg-blue-500"]'), target + ' colored settings actions lose white text');
  }
});

test('settings, profile, hero, and detail theme surfaces stay clean', () => {
  const targets = [
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, '..', '..', 'nexamanga.xml')
  ];
  for (const target of targets) {
    const source = fs.readFileSync(target, 'utf8');
    assert.ok(source.includes('<h1 class="text-xl sm:text-2xl font-black tracking-tight text-white">Settings</h1>'), target + ' settings heading should not have border styling');
    assert.ok(!source.includes('uppercase tracking-wider">Settings</h1>'), target + ' settings heading should not use boxed uppercase treatment');
    assert.ok(source.includes('html[data-resolved-theme="light"] body.kv-public-route [data-settings-root] [data-action="settings-tab"].bg-zinc-800'), target + ' light settings tab rule missing');
    assert.ok(source.includes('data-profile-avatar'), target + ' profile avatar hook missing');
    assert.ok(source.includes('html[data-resolved-theme="light"] body.kv-public-route [data-profile-avatar]'), target + ' light profile avatar rule missing');
    assert.ok(!source.includes('bg-zinc-950/65 backdrop-blur-[1px]'), target + ' hero blur overlay should be removed');
    assert.ok(source.includes('data-detail-cover-glow'), target + ' detail cover glow hook missing');
    assert.ok(source.includes('body.kv-detail-route [data-detail-cover-glow]'), target + ' detail cover glow theme rule missing');
  }
});

test('anilist theme keeps hero, account name, and settings readable', () => {
  const targets = [
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, '..', '..', 'nexamanga.xml')
  ];
  for (const target of targets) {
    const source = fs.readFileSync(target, 'utf8');
    assert.ok(source.includes('--background: #0B1622 !important; --foreground: #EDF1F5 !important;'), target + ' anilist base palette not updated');
    assert.ok(source.includes('--card: #151F2E !important; --card-foreground: #EDF1F5 !important;'), target + ' anilist card palette not updated');
    assert.ok(source.includes('--primary: #3DB4F2 !important; --primary-foreground: #0B1622 !important;'), target + ' anilist accent not updated');
    assert.ok(source.includes('html[data-theme="anilist"] body.kv-home-route [data-hero-carousel] { background: #0B1622'), target + ' anilist hero background missing');
    assert.ok(source.includes('html[data-theme="anilist"] body.kv-account-route [data-account-name]'), target + ' anilist account name rule missing');
    assert.ok(source.includes('html[data-theme="anilist"] body.kv-public-route [data-settings-root]'), target + ' anilist settings rule missing');
  }
});

'use strict';

function heroNormalizeIndex(value, count) {
  var total = Math.floor(Number(count) || 0);
  if (total < 1) return 0;
  var index = Math.trunc(Number(value) || 0);
  if (!isFinite(index)) index = 0;
  return ((index % total) + total) % total;
}

function heroWrapCenter(center, count) {
  var total = Math.floor(Number(count) || 0);
  if (total < 1) return 0;
  var value = Number(center);
  if (!isFinite(value)) value = 0;
  return ((value % total) + total) % total;
}

function heroWrappedOffset(index, center, count) {
  var total = Math.floor(Number(count) || 0);
  if (total <= 1) return 0;
  var offset = heroNormalizeIndex(index, total) - heroWrapCenter(center, total);
  var half = total / 2;
  if (offset > half) offset -= total;
  else if (offset < -half) offset += total;
  return offset;
}

function heroVirtualTarget(current, target, direction, count) {
  var total = Math.floor(Number(count) || 0);
  if (total < 2) {
    return { current: 0, target: 0, direction: '', virtual: 1, canonicalVirtual: 1, clone: false };
  }
  var from = heroNormalizeIndex(current, total);
  var to = heroNormalizeIndex(target, total);
  var dir = direction === 'next' || direction === 'prev'
    ? direction
    : (to === 0 && from === total - 1 ? 'next' : to === total - 1 && from === 0 ? 'prev' : to > from ? 'next' : 'prev');
  var virtual = to + 1;
  var clone = false;
  if (dir === 'next' && from === total - 1 && to === 0) {
    virtual = total + 1;
    clone = true;
  } else if (dir === 'prev' && from === 0 && to === total - 1) {
    virtual = 0;
    clone = true;
  }
  return { current: from, target: to, direction: dir, virtual: virtual, canonicalVirtual: to + 1, clone: clone };
}

function heroCanonicalVirtual(virtual, count) {
  var value = Number(virtual);
  if (!isFinite(value)) value = 1;
  return heroNormalizeIndex(value - 1, count) + 1;
}

function heroDragProgress(delta, travel) {
  var width = Math.max(1, Number(travel) || 1);
  return Math.max(-1, Math.min(1, -(Number(delta) || 0) / width));
}

function heroDragDecision(delta, velocity, threshold, base, count) {
  var distance = Number(delta) || 0;
  var speed = Math.max(0, Number(velocity) || 0);
  var limit = Math.max(1, Number(threshold) || 48);
  var from = heroNormalizeIndex(base, count);
  if (distance <= -limit || (distance <= -24 && speed > 0.35)) {
    return { index: heroNormalizeIndex(from + 1, count), direction: 'next' };
  }
  if (distance >= limit || (distance >= 24 && speed > 0.35)) {
    return { index: heroNormalizeIndex(from - 1, count), direction: 'prev' };
  }
  return { index: from, direction: '' };
}

module.exports = {
  heroNormalizeIndex,
  heroWrapCenter,
  heroWrappedOffset,
  heroVirtualTarget,
  heroCanonicalVirtual,
  heroDragProgress,
  heroDragDecision
};

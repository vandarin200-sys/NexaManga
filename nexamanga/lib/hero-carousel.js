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

function heroVirtualTarget(current, target, direction, count, steps) {
  var total = Math.floor(Number(count) || 0);
  if (total < 2) {
    return { current: 0, target: 0, direction: '', virtual: 1, canonicalVirtual: 1, clone: false };
  }
  var from = heroNormalizeIndex(current, total);
  var to = heroNormalizeIndex(target, total);
  var forward = heroNormalizeIndex(to - from, total);
  var backward = heroNormalizeIndex(from - to, total);
  var dir = direction === 'next' || direction === 'prev'
    ? direction
    : (forward <= backward ? 'next' : 'prev');
  var span;
  if (steps !== undefined && steps !== null && Number(steps) > 0) {
    var cycle = Math.trunc(Number(steps)) % total || total;
    span = dir === 'prev' ? -cycle : cycle;
  } else {
    span = dir === 'next' ? forward : dir === 'prev' ? -backward : (forward <= backward ? forward : -backward);
  }
  var virtual = from + 1 + span;
  if (virtual < 1 - total || virtual > total * 2) virtual = to + 1;
  var clone = virtual < 1 || virtual > total;
  return { current: from, target: to, direction: dir, virtual: virtual, canonicalVirtual: to + 1, clone: clone };
}

function heroCanonicalVirtual(virtual, count) {
  var value = Number(virtual);
  if (!isFinite(value)) value = 1;
  return heroNormalizeIndex(value - 1, count) + 1;
}

function heroAdvance(index, direction, count, steps) {
  var total = Math.floor(Number(count) || 0);
  if (total < 2) return { index: 0, direction: '' };
  var from = heroNormalizeIndex(index, total);
  var sign = direction === 'next' ? 1 : direction === 'prev' ? -1 : 0;
  if (!sign) return { index: from, direction: '' };
  var amount = Math.max(1, Math.trunc(Number(steps) || 1));
  return { index: heroNormalizeIndex(from + sign * amount, total), direction: sign > 0 ? 'next' : 'prev' };
}

function heroDragProgress(delta, travel) {
  var width = Math.max(1, Number(travel) || 1);
  return -(Number(delta) || 0) / width;
}

function heroDragDecision(delta, velocity, threshold, base, count, stepTravel) {
  var distance = Number(delta) || 0;
  var speed = Math.max(0, Number(velocity) || 0);
  var limit = Math.max(1, Number(threshold) || 48);
  var from = heroNormalizeIndex(base, count);
  var magnitude = Math.abs(distance);
  var stepWidth = Math.max(limit, Number(stepTravel) || limit * 2);
  var requested = 0;
  if (magnitude >= limit) requested = 1 + Math.floor((magnitude - limit) / stepWidth);
  else if (magnitude >= 24 && speed > 0.35) requested = 1;
  if (!requested) return { index: from, direction: '', steps: 0 };
  var sign = distance < 0 ? 1 : -1;
  return {
    index: heroNormalizeIndex(from + sign * requested, count),
    direction: sign > 0 ? 'next' : 'prev',
    steps: requested
  };
}

module.exports = {
  heroNormalizeIndex,
  heroWrapCenter,
  heroWrappedOffset,
  heroVirtualTarget,
  heroCanonicalVirtual,
  heroAdvance,
  heroDragProgress,
  heroDragDecision
};

'use strict';

function config(name) {
  const rawValue = process.env[name];
  const value = typeof rawValue === 'string' && rawValue.length >= 2 &&
    ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'")))
    ? rawValue.slice(1, -1)
    : rawValue;
  if (!value) throw new Error(`Environment variable ${name} is required.`);
  return value;
}

module.exports = { config };

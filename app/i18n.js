'use strict';

/**
 * Minimal translation helper. Strings live in app/locales/<lang>.json and use
 * {name} placeholders. Missing keys fall back to English, then to the key.
 */

const LOCALES = {
  en: require('./locales/en.json'),
  tr: require('./locales/tr.json'),
};

function lookup(lang, section, key) {
  const table = LOCALES[lang] && LOCALES[lang][section];
  if (table && typeof table[key] === 'string') return table[key];
  const fallback = LOCALES.en[section];
  return fallback && typeof fallback[key] === 'string' ? fallback[key] : key;
}

/**
 * @param {string} lang
 * @param {'bubble' | 'menu'} section
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 */
function translate(lang, section, key, vars) {
  const template = lookup(lang, section, key);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

function languageOptions() {
  return Object.entries(LOCALES).map(([code, table]) => ({ code, name: table.languageName || code }));
}

module.exports = { translate, languageOptions, LOCALES };

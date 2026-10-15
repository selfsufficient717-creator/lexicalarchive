import { ApiError } from './validation.js';

// These providers need no key or billing account. User input is only a URL
// component; every request has a fixed HTTPS origin and forbids redirects.
const DICTIONARY = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const WIKTIONARY = 'https://en.wiktionary.org';
const TRANSLATION = 'https://api.mymemory.translated.net/get';
const dictionaries = new WeakMap();
const translations = new WeakMap();
const CACHE_LIMIT = 500;
const dictionaryTtl = 6 * 60 * 60 * 1000;
const translationTtl = 60 * 60 * 1000;
const LANGUAGES = new Map(Object.entries({
  english: 'en', uzbek: 'uz', russian: 'ru', spanish: 'es', french: 'fr',
  german: 'de', arabic: 'ar', turkish: 'tr', chinese: 'zh-CN', italian: 'it',
  portuguese: 'pt', korean: 'ko', japanese: 'ja', hindi: 'hi', persian: 'fa',
  ukrainian: 'uk', kazakh: 'kk', tajik: 'tg', azerbaijani: 'az', dutch: 'nl',
  polish: 'pl', swedish: 'sv', indonesian: 'id', vietnamese: 'vi',
  bengali: 'bn', urdu: 'ur', thai: 'th', greek: 'el', romanian: 'ro',
}));
for (const code of LANGUAGES.values()) LANGUAGES.set(code.toLowerCase(), code);

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

export function plainText(value, max = 2500) {
  if (typeof value !== 'string' || value.length > 100_000) return '';
  return decodeEntities(value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' '))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

const normalized = value => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[’]/g, "'").replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
function unique(values, limit = 8, max = 300) {
  const seen = new Set();
  return values.flatMap(value => {
    const text = plainText(value, max);
    if (!text || seen.has(normalized(text))) return [];
    seen.add(normalized(text));
    return [text];
  }).slice(0, limit);
}
const list = value => Array.isArray(value) ? value : [];

function cacheFor(collection, fetchImpl) {
  let cache = collection.get(fetchImpl);
  if (!cache) { cache = new Map(); collection.set(fetchImpl, cache); }
  return cache;
}
function cached(cache, key) {
  const value = cache.get(key);
  if (!value) return null;
  if (value.expires <= Date.now()) { cache.delete(key); return null; }
  return structuredClone(value.data);
}
function remember(cache, key, data, ttl) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, { data: structuredClone(data), expires: Date.now() + ttl });
}

async function fetchJson(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'LexicalTrove/2.0 (+https://selfsufficient717-creator.github.io/lexicalarchive/)' }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false, status: response.status };
    const body = await response.json();
    // A compromised or broken provider must not supply an unbounded learning card.
    if (JSON.stringify(body).length > 750_000) return { ok: false, status: 502 };
    return { ok: true, status: response.status, body };
  } catch { return { ok: false, status: 503 }; }
}

function dictionaryEntry(body, term) {
  if (!Array.isArray(body)) return null;
  for (const entry of body.slice(0, 20)) {
    if (!entry || typeof entry.word !== 'string' || normalized(entry.word) !== normalized(term)) continue;
    for (const meaning of list(entry.meanings)) {
      const definitions = list(meaning?.definitions).filter(value => plainText(value?.definition));
      if (!definitions.length) continue;
      const selected = definitions[0];
      // Relations from a whole part of speech can span senses. Only reuse them
      // for a single-definition meaning; otherwise prefer sense-level data.
      const synonyms = unique([...list(selected.synonyms), ...(definitions.length === 1 ? list(meaning.synonyms) : [])]);
      const antonyms = unique([...list(selected.antonyms), ...(definitions.length === 1 ? list(meaning.antonyms) : [])]);
      const examples = unique([selected.example], 5, 1500);
      const source = { name: 'Free Dictionary API', url: `${DICTIONARY}${encodeURIComponent(term)}` };
      if (typeof entry.license?.name === 'string') source.license = plainText(entry.license.name, 200);
      if (typeof entry.license?.url === 'string' && /^https:\/\/creativecommons\.org\//.test(entry.license.url)) source.licenseUrl = entry.license.url;
      return {
        definition: plainText(selected.definition), synonyms, antonyms, examples,
        pronunciation: plainText(entry.phonetic || list(entry.phonetics).find(value => value?.text)?.text, 500),
        partOfSpeech: plainText(meaning.partOfSpeech, 100), source,
        senses: list(entry.meanings).reduce((sum, item) => sum + list(item?.definitions).length, 0),
      };
    }
  }
  return null;
}

function wiktionarySource(term) {
  return { name: 'Wiktionary', url: `${WIKTIONARY}/wiki/${encodeURIComponent(term.replace(/\s+/g, '_'))}`, license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' };
}

function wiktionaryEntry(body, term) {
  if (!body || !Array.isArray(body.en)) return null;
  for (const part of body.en.slice(0, 30)) {
    const definitions = list(part?.definitions).filter(value => plainText(value?.definition));
    if (!definitions.length) continue;
    const selected = definitions[0];
    return {
      definition: plainText(selected.definition),
      examples: unique([...list(selected.examples), ...list(selected.parsedExamples).map(example => example?.example)], 5, 1500),
      synonyms: [], antonyms: [], pronunciation: '',
      partOfSpeech: plainText(part.partOfSpeech, 100),
      senses: body.en.reduce((sum, item) => sum + list(item?.definitions).length, 0),
      source: wiktionarySource(term),
    };
  }
  return null;
}

// The stable MediaWiki Action API supplies rendered HTML for the English
// section if the definition REST endpoint is unavailable. Parse text only;
// no provider markup is inserted into the page or executed.
function htmlTree(html) {
  const root = { tag: 'root', children: [] };
  const stack = [root];
  const voidTags = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'wbr']);
  let count = 0;
  for (const token of html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) || []) {
    if (++count > 25_000) return null;
    if (token.startsWith('<!--')) continue;
    const closing = token.match(/^<\/([a-z][\w-]*)/i);
    if (closing) {
      const tag = closing[1].toLowerCase();
      for (let index = stack.length - 1; index > 0; index--) if (stack[index].tag === tag) { stack.length = index; break; }
      continue;
    }
    const opening = token.match(/^<([a-z][\w-]*)/i);
    if (opening) {
      const node = { tag: opening[1].toLowerCase(), classes: (token.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || '').split(/\s+/), children: [] };
      stack.at(-1).children.push(node);
      if (!voidTags.has(node.tag) && !token.endsWith('/>')) stack.push(node);
    } else if (!token.startsWith('<')) stack.at(-1).children.push(token);
  }
  return root;
}

function treeText(node, omitBlocks = false) {
  if (typeof node === 'string') return node;
  if (['script', 'style', 'sup', 'table'].includes(node.tag) || (omitBlocks && ['ol', 'ul', 'dl'].includes(node.tag))) return '';
  return node.children.map(child => treeText(child, omitBlocks)).join(' ');
}

function actionEntry(html, term) {
  if (typeof html !== 'string' || html.length > 500_000) return null;
  const tree = htmlTree(html);
  if (!tree) return null;
  const definitions = [];
  const visit = (node, parent, withinDefinition = false) => {
    if (typeof node === 'string') return;
    if (node.tag === 'li' && parent?.tag === 'ol' && !withinDefinition) {
      const definition = plainText(treeText(node, true));
      if (definition) {
        const examples = [];
        const findExamples = child => {
          if (typeof child === 'string') return;
          if (child.classes?.includes('e-example') || child.classes?.includes('e-quotation')) {
            examples.push(treeText(child));
            return;
          }
          child.children.forEach(findExamples);
        };
        node.children.forEach(findExamples);
        definitions.push({ definition, examples: unique(examples, 5, 1500) });
      }
      withinDefinition = true;
    }
    node.children.forEach(child => visit(child, node, withinDefinition));
  };
  visit(tree);
  if (!definitions.length) return null;
  return { ...definitions[0], synonyms: [], antonyms: [], pronunciation: '', partOfSpeech: '', senses: definitions.length, source: wiktionarySource(term) };
}

function actionUrl(term, fields) {
  const url = new URL('/w/api.php', WIKTIONARY);
  url.search = new URLSearchParams({ action: 'parse', page: term.replace(/\s+/g, '_'), format: 'json', ...fields });
  return url.href;
}

async function lookup(fetchImpl, term) {
  const dictionary = await fetchJson(fetchImpl, `${DICTIONARY}${encodeURIComponent(term)}`);
  const first = dictionary.ok && dictionaryEntry(dictionary.body, term);
  if (first) return first;
  const wiki = await fetchJson(fetchImpl, `${WIKTIONARY}/api/rest_v1/page/definition/${encodeURIComponent(term.replace(/\s+/g, '_'))}`);
  const second = wiki.ok && wiktionaryEntry(wiki.body, term);
  if (second) return second;
  const sections = await fetchJson(fetchImpl, actionUrl(term, { prop: 'sections' }));
  const english = sections.ok && list(sections.body?.parse?.sections).find(section => plainText(section.line) === 'English' && /^\d+$/.test(String(section.index)));
  if (english) {
    const parsed = await fetchJson(fetchImpl, actionUrl(term, { prop: 'text', section: String(english.index), disableeditsection: '1' }));
    const third = parsed.ok && actionEntry(parsed.body?.parse?.text?.['*'], term);
    if (third) return third;
  }
  const missing = (dictionary.status === 404 && wiki.status === 404) || sections.body?.error?.code === 'missingtitle';
  if (missing || (sections.ok && !english)) throw new ApiError(404, 'dictionary_not_found', 'No English dictionary entry was found for that exact word or phrase. You can add it manually with the meaning and context you found.');
  throw new ApiError(502, 'dictionary_unavailable', 'The free dictionaries are temporarily unavailable. Please try again later or add this item manually.');
}

async function translate(fetchImpl, term, language) {
  const target = LANGUAGES.get(language.trim().toLowerCase());
  if (target === 'en') return { translation: '', translationNote: 'The definition is already in English; choose another language for a translation.' };
  if (!target) return { translation: '', translationNote: 'This translation language is not supported by the free lookup. You can add your own translation.' };
  if (Buffer.byteLength(term, 'utf8') > 500) return { translation: '', translationNote: 'This phrase exceeds the free translation service’s 500-byte request limit. You can add your own translation.' };
  const cache = cacheFor(translations, fetchImpl);
  const key = `${normalized(term)}:${target}`;
  const previous = cached(cache, key);
  if (previous) return previous;
  const url = new URL(TRANSLATION);
  url.search = new URLSearchParams({ q: term, langpair: `en|${target}` });
  const response = await fetchJson(fetchImpl, url.href);
  const body = response.body;
  if (!response.ok || Number(body?.responseStatus) !== 200 || body?.quotaFinished === true || body?.quotaFinished === 'true') {
    return { translation: '', translationNote: 'Free translation is unavailable or its daily quota has been reached. The English meaning and practice still work; you can add your own translation.' };
  }
  const translation = plainText(body?.responseData?.translatedText, 1500);
  if (!translation) return { translation: '', translationNote: 'The free service did not return a translation. You can add your own translation.' };
  const result = { translation, translationNote: 'Free machine translation may miss the intended sense. Check it against the English definition.', translationSource: { name: 'MyMemory', url: 'https://mymemory.translated.net/' } };
  remember(cache, key, result, translationTtl);
  return result;
}

function escaped(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function termPattern(term) {
  // Whole lexical expressions only: “art” must not become a gap in “party”.
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped(term).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
}
function exercisesFor(term, entry, context) {
  const exercises = [];
  const add = (type, question, answer, explanation) => exercises.push({ type, question: question.slice(0, 4500), options: [], answer: answer.slice(0, 500), explanation: explanation.slice(0, 1500) });
  for (const relation of ['synonym', 'antonym']) {
    const values = entry[`${relation}s`].filter(value => normalized(value) !== normalized(term));
    if (values.length) {
      add(relation, `Give a ${relation} of “${term}” listed on your learning card.`, values[0], `Listed ${relation}s: ${values.join(', ')}. Other valid answers may exist; this exercise accepts the listed answers.`);
      exercises.at(-1).acceptedAnswers = values;
    }
  }
  const pattern = termPattern(term);
  const example = entry.examples.find(sentence => pattern.test(sentence));
  if (example) add('gap', `Source: ${entry.source.name}. Complete the example with your lexical item:\n${example.replace(pattern, '_____')}`, term, entry.definition);
  if (context && context.split(/\s+/).length >= 80 && pattern.test(context)) {
    add('gap', `Source: your pasted passage. Complete it with your lexical item:\n${context.replace(pattern, '_____')}`, term, 'This is the passage you supplied, with one occurrence of your lexical item removed. Its language and facts have not been verified.');
  }
  return exercises;
}

function contextExcerpt(context, term) {
  if (context.length <= 1500) return context;
  const index = termPattern(term).exec(context)?.index || 0;
  const start = Math.max(0, index - 300);
  const end = Math.min(context.length, start + 1450);
  return `${start ? '… ' : ''}${context.slice(start, end)}${end < context.length ? ' …' : ''}`;
}

export async function createLexicon(_config, fetchImpl, request) {
  if (typeof request?.text !== 'string' || !request.text.trim() || request.text.length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.text)) throw new ApiError(400, 'invalid_request', 'Enter an English word or phrase of at most 300 characters.');
  const term = request.text.trim().replace(/\s+/g, ' ');
  const language = typeof request.language === 'string' && request.language.trim() ? request.language.trim().slice(0, 80) : 'English';
  const context = typeof request.context === 'string' ? request.context.trim().slice(0, 2500) : '';
  const cache = cacheFor(dictionaries, fetchImpl);
  const key = normalized(term);
  let entry = cached(cache, key);
  if (!entry) { entry = await lookup(fetchImpl, term); remember(cache, key, entry, dictionaryTtl); }
  const translation = await translate(fetchImpl, term, language);
  const examples = [...entry.examples];
  const examplesSource = examples.map(() => entry.source.name);
  if (!examples.length && context && termPattern(term).test(context)) {
    examples.push(contextExcerpt(context, term));
    examplesSource.push('Your pasted context (not checked by a dictionary)');
  }
  const relationNote = entry.antonyms.length ? 'Dictionary antonyms depend on the sense and context.' : 'The source does not list an antonym for this sense. No opposite has been invented.';
  return {
    term, method: 'dictionary', kind: /\s/.test(term) ? (/\bidiom(?:atic)?\b/i.test(entry.definition) ? 'idiom' : 'phrase') : 'word',
    pronunciation: entry.pronunciation, definition: entry.definition, ...translation, language,
    synonyms: entry.synonyms, antonyms: entry.antonyms, antonymNote: relationNote,
    examples, examplesSource,
    examplesNote: entry.examples.length ? 'These examples are quoted from the dictionary source.' : context && examples.length ? 'This is your supplied context, not an independently verified example.' : 'The dictionary did not provide an example for this sense. Add the sentence or passage where you found it.',
    usageNote: `${entry.partOfSpeech ? `${entry.partOfSpeech}. ` : ''}Dictionary wording is shown without AI rewriting.${entry.senses > 1 ? ` This entry has ${entry.senses} senses; the first is shown. Your context has not been automatically interpreted.` : ''}`,
    speakingPrompt: `Describe a real or imagined situation in which “${term}” would be useful. Explain what happened and why this expression fits. Speak for 60–120 seconds and use it naturally.`,
    writingPrompt: `Write 120–200 words about a real or imagined situation in which “${term}” would be useful. Explain your ideas clearly and use this expression naturally.`,
    exercises: exercisesFor(term, entry, context), source: entry.source,
  };
}

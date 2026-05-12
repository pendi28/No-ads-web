'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const AdmZip = require('adm-zip');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

const SUBDL_LANG_MAP = {
  id: 'IN', in: 'IN', ind: 'IN',
  en: 'EN', eng: 'EN',
  ms: 'MS', may: 'MS',
  ko: 'KO', kor: 'KO',
  ja: 'JA', jpn: 'JA',
  zh: 'ZH', chi: 'ZH',
  ar: 'AR', ara: 'AR',
  es: 'ES', spa: 'ES',
  fr: 'FR', fra: 'FR',
  de: 'DE', ger: 'DE',
  pt: 'PT', por: 'PT',
  ru: 'RU', rus: 'RU',
  tr: 'TR', tur: 'TR',
  hi: 'HI', hin: 'HI',
  th: 'TH', tha: 'TH',
  vi: 'VI', vie: 'VI',
};

const SUBDL_DISPLAY = {
  IN: 'Indonesia', EN: 'English', MS: 'Melayu', KO: 'Korean',
  JA: 'Japanese', ZH: 'Chinese', AR: 'Arabic', ES: 'Spanish',
  FR: 'French', DE: 'German', PT: 'Portuguese', RU: 'Russian',
  TR: 'Turkish', HI: 'Hindi', TH: 'Thai', VI: 'Vietnamese',
};

// ── WASM singleton ────────────────────────────────────────────────────────────
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
  })();
  return bootPromise;
}

// ── Download buffer dari URL (dengan redirect) ────────────────────────────────
function downloadBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(downloadBuffer(loc.startsWith('http') ? loc : new URL(loc, url).href, redirects + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), status: res.statusCode, ct: res.headers['content-type'] || '' }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Ekstrak subtitle dari zip SubDL ──────────────────────────────────────────
async function extractSubtitleFromZip(zipUrl) {
  try {
    const { buf, status } = await downloadBuffer(zipUrl);
    if (status !== 200) return null;

    const zip = new AdmZip(buf);
    const entries = zip.getEntries();

    // Cari file .srt atau .vtt di dalam zip
    const subEntry = entries.find(e => /\.(srt|vtt)$/i.test(e.entryName) && !e.isDirectory);
    if (!subEntry) return null;

    let text = subEntry.getData().toString('utf8');

    // Konversi SRT ke VTT jika perlu
    if (!/^\uFEFF?WEBVTT/.test(text)) {
      text = text.replace(/^\uFEFF/, '').replace(/\r+/g, '');
      text = text.replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
      text = 'WEBVTT\n\n' + text.trim() + '\n';
    }

    return text;
  } catch {
    return null;
  }
}

// ── SubDL: ambil subtitle berdasarkan TMDB ID ─────────────────────────────────
async function getSubtitlesFromSubDL(tmdbId, season, episode, preferLang) {
  const apiKey = process.env.SUBDL_API_KEY;
  if (!apiKey) return [];

  const subdlLang = SUBDL_LANG_MAP[preferLang] || 'IN';
  const langParam = subdlLang === 'EN' ? 'EN' : `${subdlLang},EN`;

  let url = `https://api.subdl.com/api/v1/subtitles?api_key=${apiKey}&tmdb_id=${tmdbId}&languages=${langParam}&subs_per_page=5`;
  if (season) {
    url += `&season_number=${season}&episode_number=${episode || 1}&type=tv`;
  } else {
    url += `&type=movie`;
  }

  try {
    const { buf } = await downloadBuffer(url);
    const data = JSON.parse(buf.toString('utf8'));
    if (!data.status || !Array.isArray(data.subtitles)) return [];

    // Deduplikasi per bahasa, ambil 1 per bahasa
    const seen = new Set();
    const result = [];
    for (const sub of data.subtitles) {
      if (!sub.url) continue;
      const code = (sub.lang || '').toUpperCase();
      if (seen.has(code)) continue;
      seen.add(code);
      const isoLang = Object.keys(SUBDL_LANG_MAP).find(k => SUBDL_LANG_MAP[k] === code) || code.toLowerCase();

      // Simpan URL zip asli — akan diproses saat di-proxy
      result.push({
        url: 'https://dl.subdl.com' + sub.url,
        lang: isoLang,
        label: SUBDL_DISPLAY[code] || sub.lang || code,
        isZip: true
      });
    }
    return result;
  } catch {
    return [];
  }
}

// ── Stream URL + subtitle resolver ───────────────────────────────────────────
async function getStream(id, season, episode, preferLang) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();

  const playlist = data?.stream?.playlist;
  if (!playlist) throw new Error('No playlist in response');

  const rawSubs =
    data?.stream?.subtitles ||
    data?.stream?.tracks ||
    data?.subtitles ||
    data?.tracks ||
    [];

  let subtitles = Array.isArray(rawSubs)
    ? rawSubs
        .filter(s => s && (s.url || s.file || s.src || s.link))
        .map(s => ({
          url:   s.url   || s.file || s.src  || s.link  || '',
          lang:  s.lang  || s.language || s.srclang || s.languageCode || s.iso || '',
          label: s.label || s.name  || s.title || s.display || ''
        }))
    : [];

  // Fallback ke SubDL jika vidlink tidak punya subtitle
  if (subtitles.length === 0) {
    subtitles = await getSubtitlesFromSubDL(id, season, episode, preferLang);
  }

  return { url: playlist, subtitles };
}

// ── HLS upstream fetcher dengan redirect ─────────────────────────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, redirects + 1));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function rewriteM3u8(body, url) {
  const base = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin = new URL(url).origin;
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : t.startsWith('/') ? origin + t : baseDir + t;
    return '/api?url=' + encodeURIComponent(abs);
  }).join('\n');
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // Proxy mode: /api?url=...
  if (q.url) {
    const url = decodeURIComponent(q.url);
    const isSubDlZip = url.includes('dl.subdl.com') && url.endsWith('.zip');

    // SubDL zip: ekstrak subtitle langsung dan kembalikan sebagai VTT
    if (isSubDlZip) {
      try {
        const vttText = await extractSubtitleFromZip(url);
        if (vttText) {
          res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
          return res.end(vttText);
        }
      } catch {}
      res.statusCode = 502;
      return res.end('Gagal mengekstrak subtitle');
    }

    try {
      const upstream = await fetchUpstream(url);
      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);

      if (isM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(rewriteM3u8(body, url));
      } else {
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        res.statusCode = upstream.statusCode;
        upstream.pipe(res);
      }
    } catch (err) {
      res.statusCode = 502;
      res.end(err.message);
    }
    return;
  }

  // Stream lookup: /api?id=550 atau /api?id=456&s=1&e=2
  if (!q.id) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'missing id' }));
  }

  res.setHeader('Content-Type', 'application/json');
  try {
    const preferLang = (q.ds_lang || 'id').toLowerCase();
    const { url, subtitles } = await getStream(q.id, q.s, q.e, preferLang);
    res.end(JSON.stringify({ url, subtitle: subtitles }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};

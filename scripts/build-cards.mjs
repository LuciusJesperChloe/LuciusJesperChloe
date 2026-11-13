#!/usr/bin/env node
// Builds the SVG cards shown in the profile README from GitHub's own API.
// No dependencies: needs Node 18+ (built-in fetch). Run from the repository root.
//
//   GITHUB_TOKEN=... node scripts/build-cards.mjs
//
// The workflow passes the built-in GITHUB_TOKEN; without one (local preview)
// the REST calls are simply unauthenticated.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const config = JSON.parse(await readFile('profile.config.json', 'utf8'));
const LOGIN = config.login;
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUT = 'assets';

// ---------- theme: dark, monochrome; colour only for languages ----------
const T = {
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif",
  card: '#0a0a0a',
  border: '#1f1f1f',
  text: '#ededed',
  muted: '#a1a1a1',
  faint: '#6b6b6b',
};

// GitHub linguist colours for common languages; anything else is grey.
const LANG_COLORS = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', HTML: '#e34c26', CSS: '#663399',
  Python: '#3572A5', R: '#198CE7', Java: '#b07219', Kotlin: '#A97BFF', Go: '#00ADD8',
  Rust: '#dea584', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600', Shell: '#89e051',
  Swift: '#F05138', Dart: '#00B4AB', PHP: '#4F5D95', Ruby: '#701516', SCSS: '#c6538c',
  Vue: '#41b883', Svelte: '#ff3e00', 'Jupyter Notebook': '#DA5B0B', SQL: '#e38c00',
  PLpgSQL: '#336790', Dockerfile: '#384d54', Makefile: '#427819', Assembly: '#6E4C13',
};
const langColor = (name) => LANG_COLORS[name] || '#8b949e';

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function compact(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

// Rough text width for the system sans font, good enough for chip layout.
const textWidth = (s, size) => [...String(s)].reduce((w, ch) => w + (/[A-Z0-9#+]/.test(ch) ? 0.64 : /[il.,:'| ]/.test(ch) ? 0.3 : 0.54), 0) * size;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

// `padBottom` adds transparent space under a card so stacked images don't touch.
function svg(width, height, title, body, padBottom = 0) {
  const h = height + padBottom;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" role="img" aria-labelledby="t">
<title id="t">${esc(title)}</title>
<style>text{font-family:${T.font}}</style>
${body}
</svg>
`;
}

const panel = (x, y, w, h) => `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="10" fill="${T.card}" stroke="${T.border}"/>`;

// ---------- GitHub API ----------
async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'profile-cards',
      ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }),
    },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ownedRepos() {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await rest(`/users/${LOGIN}/repos?type=owner&per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

// ---------- cards ----------
const W = 880;
const pad = 28;

function bannerCard(user, now) {
  const H = 132;
  const meta = [...config.tags, ...(user.hireable ? ['Open to work'] : [])].join('  ·  ');
  return svg(W, H, `${config.welcomeTitle}. ${config.welcomeSubtitle}.`, `${panel(0, 0, W, H)}
<text x="${pad}" y="50" font-size="24" font-weight="600" fill="${T.text}">${esc(config.welcomeTitle)}</text>
<text x="${pad}" y="78" font-size="15" fill="${T.muted}">${esc(config.welcomeSubtitle)}</text>
<line x1="${pad}" y1="96" x2="${W - pad}" y2="96" stroke="${T.border}"/>
<text x="${pad}" y="117" font-size="13" fill="${T.faint}">${esc(meta)}</text>
<text x="${W - pad}" y="117" font-size="13" fill="${T.faint}" text-anchor="end">Updated ${esc(fmtDate(now))}</text>`);
}

function kpiCard(stats) {
  const H = 108, cw = W / 4;
  const items = [
    [compact(stats.repos), 'Repositories'],
    [compact(stats.stars), 'Stars'],
    [compact(stats.followers), 'Followers'],
    [String(stats.years), stats.years === 1 ? 'Year on GitHub' : 'Years on GitHub'],
  ];
  const body = items.map(([value, label], i) => {
    const x = i * cw + cw / 2;
    const divider = i ? `<line x1="${i * cw}" y1="24" x2="${i * cw}" y2="${H - 24}" stroke="${T.border}"/>` : '';
    return `${divider}<text x="${x}" y="58" font-size="30" font-weight="600" fill="${T.text}" text-anchor="middle">${esc(value)}</text>
<text x="${x}" y="82" font-size="13" fill="${T.muted}" text-anchor="middle">${label}</text>`;
  }).join('\n');
  const title = `${stats.repos} repositories, ${stats.stars} stars, ${stats.followers} followers, ${stats.years} years on GitHub`;
  return svg(W, H, title, `${panel(0, 0, W, H)}\n${body}`);
}

function languagesCard(langs) {
  const total = langs.reduce((s, l) => s + l.bytes, 0) || 1;
  const pct = (b) => { const p = (b / total) * 100; return p >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`; };
  const kb = total / 1024;
  const size = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
  // Stacked bar; slivers under 0.5% are folded into "Other" so the bar stays readable.
  const shown = langs.filter((l) => l.bytes / total >= 0.005);
  const other = total - shown.reduce((s, l) => s + l.bytes, 0);
  const parts = [...shown.map((l) => ({ ...l, color: langColor(l.name) })), ...(other > 0 ? [{ name: 'Other', bytes: other, color: '#525252' }] : [])];
  const barW = W - pad * 2, gap = 2;
  let x = pad;
  const bar = parts.map((p, i) => {
    const w = Math.max((p.bytes / total) * barW - (i < parts.length - 1 ? gap : 0), 2);
    const s = `<rect x="${x.toFixed(1)}" y="56" width="${w.toFixed(1)}" height="8" fill="${p.color}"/>`;
    x += w + gap;
    return s;
  }).join('');
  // Legend in equal columns (up to six per row) so it lines up under the bar.
  const perRow = Math.min(parts.length, 6), colW = barW / perRow;
  const legend = parts.map((p, i) => {
    const lx = pad + (i % perRow) * colW, y = 96 + Math.floor(i / perRow) * 24;
    return `<circle cx="${lx + 4}" cy="${y - 4.5}" r="4" fill="${p.color}"/><text x="${lx + 14}" y="${y}" font-size="13" fill="${T.text}">${esc(p.name)} <tspan fill="${T.faint}">${pct(p.bytes)}</tspan></text>`;
  }).join('\n');
  const ly = 96 + Math.floor((parts.length - 1) / perRow) * 24;
  const H = ly + 26;
  const title = `Languages: ${parts.map((p) => `${p.name} ${pct(p.bytes)}`).join(', ')}`;
  return svg(W, H, title, `${panel(0, 0, W, H)}
<defs><clipPath id="bar"><rect x="${pad}" y="56" width="${barW}" height="8" rx="4"/></clipPath></defs>
<text x="${pad}" y="38" font-size="13" fill="${T.muted}">Languages</text>
<text x="${W - pad}" y="38" font-size="13" fill="${T.faint}" text-anchor="end">${size} across public repositories</text>
<g clip-path="url(#bar)">${bar}</g>
${legend}`);
}

// ---------- main ----------
const now = new Date();
const user = await rest(`/users/${LOGIN}`);
const repos = (await ownedRepos()).filter((r) => !r.private && !config.excludeRepos.includes(r.name));
const sources = repos.filter((r) => !r.fork);

const langBytes = {};
for (const r of sources.filter((r) => !r.archived)) {
  for (const [name, bytes] of Object.entries(await rest(`/repos/${LOGIN}/${r.name}/languages`))) {
    langBytes[name] = (langBytes[name] || 0) + bytes;
  }
}
const langs = Object.entries(langBytes).map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes);

const created = new Date(user.created_at);
const years = Math.floor((now - created) / (365.2425 * 24 * 3600 * 1000));
const stats = {
  repos: user.public_repos,
  stars: sources.reduce((s, r) => s + r.stargazers_count, 0),
  followers: user.followers,
  years,
};

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/banner.svg`, bannerCard(user, now));
await writeFile(`${OUT}/kpis.svg`, kpiCard(stats));
await writeFile(`${OUT}/languages.svg`, languagesCard(langs));

// Point the README at each card with a content hash (?v=...), so a changed card gets a
// new URL and browsers and GitHub's cache show it straight away. Unchanged cards keep
// their URL, so this never creates a commit on its own.
let readme = await readFile('README.md', 'utf8');
for (const name of ['banner', 'kpis', 'languages']) {
  const hash = createHash('sha256').update(await readFile(`${OUT}/${name}.svg`)).digest('hex').slice(0, 10);
  readme = readme.replace(new RegExp(`assets/${name}\\.svg(\\?v=[0-9a-f]+)?`, 'g'), `assets/${name}.svg?v=${hash}`);
}
await writeFile('README.md', readme);
console.log(JSON.stringify({ ...stats, languages: langs.length }));

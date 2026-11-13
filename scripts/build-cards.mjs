#!/usr/bin/env node
// Builds the SVG cards shown in the profile README from GitHub's own API.
// No dependencies: needs Node 18+ (built-in fetch). Run from the repository root.
//
//   GITHUB_TOKEN=... node scripts/build-cards.mjs
//
// The workflow passes the built-in GITHUB_TOKEN; without one (local preview)
// the REST calls are simply unauthenticated.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const config = JSON.parse(await readFile('profile.config.json', 'utf8'));
const LOGIN = config.login;
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUT = 'assets';

// ---------- theme (dark, after the reference design) ----------
const T = {
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif",
  card: '#0a0a0a',
  border: '#262626',
  text: '#fafafa',
  muted: '#a3a3a3',
  faint: '#737373',
  accent: '#4ade80',
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

const panel = (x, y, w, h) => `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="12" fill="${T.card}" stroke="${T.border}"/>`;

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
function bannerCard(user, now) {
  const W = 880, H = 168;
  const tags = [...config.tags, ...(user.hireable ? ['Open to work'] : [])];
  let x = 32;
  const chips = tags.map((t) => {
    const w = textWidth(t, 13) + 26;
    const s = `<rect x="${x}" y="114" width="${w}" height="28" rx="14" fill="none" stroke="#3f3f46"/>
<text x="${x + w / 2}" y="132.5" font-size="13" fill="#d4d4d8" text-anchor="middle">${esc(t)}</text>`;
    x += w + 8;
    return s;
  }).join('\n');
  return svg(W, H, `${config.welcomeTitle}. ${config.welcomeSubtitle}.`, `${panel(0, 0, W, H)}
<text x="32" y="56" font-size="26" font-weight="600" fill="${T.text}">${esc(config.welcomeTitle)}</text>
<text x="32" y="88" font-size="16" fill="${T.muted}">${esc(config.welcomeSubtitle)}</text>
${chips}
<circle cx="${W - 32 - textWidth(`Updated ${fmtDate(now)}`, 13) - 12}" cy="51" r="4" fill="${T.accent}"><animate attributeName="opacity" values="1;.25;1" dur="2.4s" repeatCount="indefinite"/></circle>
<text x="${W - 32}" y="56" font-size="13" fill="${T.faint}" text-anchor="end">Updated <tspan fill="${T.accent}">${esc(fmtDate(now))}</tspan></text>`);
}

const ICONS = {
  repos: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  stars: '<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  followers: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="16.5" cy="7.5" r="3"/><path d="M17 13.6c2.7.4 4.5 2.6 4.5 5.4"/>',
  years: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

function kpiCard(stats) {
  const W = 880, H = 156, gap = 16, cw = (W - gap * 3) / 4;
  const items = [
    ['repos', compact(stats.repos), 'TOTAL REPOS'],
    ['stars', compact(stats.stars), 'ALL STARS'],
    ['followers', compact(stats.followers), 'FOLLOWERS'],
    ['years', String(stats.years), stats.years === 1 ? 'YEAR ACTIVE' : 'YEARS ACTIVE'],
  ];
  const body = items.map(([icon, value, label], i) => {
    const x = i * (cw + gap), cx = x + cw / 2;
    return `<g>${panel(x, 0, cw, H)}
<g transform="translate(${cx - 12} 26)" fill="none" stroke="${T.muted}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</g>
<text x="${cx}" y="98" font-size="40" font-weight="700" fill="${T.text}" text-anchor="middle">${esc(value)}</text>
<text x="${cx}" y="128" font-size="13" letter-spacing="2" fill="${T.muted}" text-anchor="middle">${label}</text></g>`;
  }).join('\n');
  const title = `${stats.repos} total repos, ${stats.stars} stars, ${stats.followers} followers, ${stats.years} years active`;
  return svg(W, H, title, body);
}

function techCard(langs, extras) {
  const W = 880, H = 260, gap = 16, pw = (W - gap) / 2;
  const total = langs.reduce((s, l) => s + l.bytes, 0) || 1;
  // Left: technology chips.
  const names = [...langs.map((l) => l.name), ...extras.filter((e) => !langs.some((l) => l.name === e))];
  let x = 24, y = 68;
  const chips = names.map((n) => {
    const w = textWidth(n, 14) + 40;
    if (x + w > pw - 24) { x = 24; y += 46; }
    const c = langColor(n);
    const s = `<rect x="${x}" y="${y}" width="${w}" height="34" rx="17" fill="${c}" fill-opacity=".14" stroke="${c}" stroke-opacity=".45"/>
<circle cx="${x + 17}" cy="${y + 17}" r="4" fill="${c}"/>
<text x="${x + 28}" y="${y + 22}" font-size="14" fill="#e5e5e5">${esc(n)}</text>`;
    x += w + 10;
    return s;
  }).join('\n');
  // Right: donut + legend of the top five.
  const ox = pw + gap, cx = ox + 108, cy = 118, r = 70, circ = 2 * Math.PI * r;
  let offset = 0;
  const segs = langs.map((l) => {
    const len = (l.bytes / total) * circ;
    const s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${langColor(l.name)}" stroke-width="22" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += len;
    return s;
  }).join('\n');
  const pct = (b) => { const p = (b / total) * 100; return p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`; };
  const legend = langs.slice(0, 5).map((l, i) => `<circle cx="${ox + 222}" cy="${50 + i * 36}" r="6" fill="${langColor(l.name)}"/>
<text x="${ox + 238}" y="${55 + i * 36}" font-size="15" fill="${T.text}">${esc(l.name)}</text>
<text x="${ox + pw - 24}" y="${55 + i * 36}" font-size="15" fill="${T.muted}" text-anchor="end">${pct(l.bytes)}</text>`).join('\n');
  const kb = total / 1024;
  const size = kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb.toFixed(1)}KB`;
  const title = `Languages: ${langs.slice(0, 5).map((l) => `${l.name} ${pct(l.bytes)}`).join(', ')}`;
  return svg(W, H, title, `${panel(0, 0, pw, H)}
<text x="24" y="42" font-size="13" letter-spacing="2" fill="${T.muted}">CORE TECHNOLOGIES</text>
${chips}
${panel(ox, 0, pw, H)}
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#262626" stroke-width="22"/>
${segs}
<text x="${cx}" y="${cy + 5}" font-size="15" fill="${T.muted}" text-anchor="middle">${langs.length} lang${langs.length === 1 ? '' : 's'}</text>
${legend}
<text x="${ox + 24}" y="${H - 22}" font-size="13" fill="${T.faint}">Based on ${size} of code in public repos</text>`);
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
await writeFile(`${OUT}/tech-stack.svg`, techCard(langs, config.extraTechnologies));
console.log(JSON.stringify({ ...stats, languages: langs.length }));

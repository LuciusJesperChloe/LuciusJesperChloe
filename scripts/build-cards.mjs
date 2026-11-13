#!/usr/bin/env node
// Builds the SVG cards shown in the profile README from GitHub's own API.
// No dependencies: needs Node 18+ (built-in fetch). Run from the repository root.
//
//   GITHUB_TOKEN=... node scripts/build-cards.mjs
//
// With a token (the workflow passes the built-in GITHUB_TOKEN) the contribution
// calendar comes from the GraphQL API. Without one (local preview) it falls back
// to the public contributions page, and REST calls are unauthenticated.

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
  heat: ['#16241a', '#1e4a2a', '#2c7a3d', '#45ad56', '#6fe27a'],
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

function truncate(s, size, max) {
  if (textWidth(s, size) <= max) return s;
  let out = s;
  while (out && textWidth(`${out}…`, size) > max) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

function wrap(s, size, max, lines) {
  const words = String(s).split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (textWidth(next, size) <= max) { line = next; continue; }
    if (line) out.push(line);
    line = w;
    if (out.length === lines) break;
  }
  if (out.length < lines && line) out.push(line);
  const used = out.join(' ').split(/\s+/).filter(Boolean).length;
  if (used < words.length && out.length) out[out.length - 1] = truncate(`${out[out.length - 1]} …`, size, max);
  return out.slice(0, lines).map((l) => truncate(l, size, max));
}

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

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function calendarFromGraphQL() {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{
    totalContributions weeks{contributionDays{date weekday contributionCount contributionLevel}}}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-cards' },
    body: JSON.stringify({ query, variables: { login: LOGIN } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL failed: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  const cal = json.data.user.contributionsCollection.contributionCalendar;
  return {
    total: cal.totalContributions,
    days: cal.weeks.flatMap((w) => w.contributionDays).map((d) => ({
      date: d.date, count: d.contributionCount, level: LEVELS[d.contributionLevel] ?? 0,
    })),
  };
}

// Local-preview fallback: the public calendar fragment GitHub serves to profile pages.
async function calendarFromPublicPage() {
  const res = await fetch(`https://github.com/users/${LOGIN}/contributions`, { headers: { 'User-Agent': 'profile-cards' } });
  if (!res.ok) throw new Error(`contributions page failed: ${res.status}`);
  const html = await res.text();
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const counts = {};
  for (const m of html.matchAll(/<tool-tip\b([^>]*)>([^<]*)</g)) {
    const a = attrs(m[1]);
    const n = /^(\d[\d,]*) contribution/.exec(m[2].trim());
    counts[a.for] = n ? Number(n[1].replace(/,/g, '')) : 0;
  }
  const days = [...html.matchAll(/<td\b[^>]*data-date="[^"]*"[^>]*>/g)].map((m) => {
    const a = attrs(m[0]);
    return { date: a['data-date'], count: counts[a.id] ?? 0, level: Number(a['data-level'] ?? 0) };
  }).sort((x, y) => x.date.localeCompare(y.date));
  return { total: days.reduce((s, d) => s + d.count, 0), days };
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
  fork: '<circle cx="6" cy="5" r="2.2"/><circle cx="18" cy="5" r="2.2"/><circle cx="12" cy="19" r="2.2"/><path d="M6 7.2v1.8a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.2M12 12v4.8"/>',
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

function heatmapCard(cal) {
  const W = 880, H = 214;
  // Group days into Sunday-start weeks, keeping the last 53 columns.
  const weeks = [];
  for (const d of cal.days) {
    const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    if (!weeks.length || dow === 0) weeks.push([]);
    weeks[weeks.length - 1][dow] = d;
  }
  const cols = weeks.slice(-53);
  const left = 64, top = 52, step = (W - left - 28) / cols.length, size = step - 3.2;
  let lastLabelX = -100;
  const months = [];
  cols.forEach((week, i) => {
    const first = week.find(Boolean);
    if (!first) return;
    const d = new Date(`${first.date}T00:00:00Z`);
    const prev = i > 0 ? cols[i - 1].find(Boolean) : null;
    const changed = !prev || new Date(`${prev.date}T00:00:00Z`).getUTCMonth() !== d.getUTCMonth();
    const x = left + i * step;
    if (changed && x - lastLabelX >= 34 && i < cols.length - 1) {
      months.push(`<text x="${x}" y="${top - 12}" font-size="12" fill="${T.faint}">${MONTHS[d.getUTCMonth()]}</text>`);
      lastLabelX = x;
    }
  });
  const cells = cols.flatMap((week, i) => week.map((d, dow) => d && `<rect x="${(left + i * step).toFixed(1)}" y="${(top + dow * step).toFixed(1)}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" rx="3" fill="${T.heat[d.level]}"><title>${d.count} on ${d.date}</title></rect>`)).filter(Boolean).join('\n');
  const days = [['Mon', 1], ['Wed', 3], ['Fri', 5]].map(([n, r]) => `<text x="${left - 12}" y="${top + r * step + size - 2}" font-size="12" fill="${T.faint}" text-anchor="end">${n}</text>`).join('');
  const legendX = W - 28 - 5 * 15 - 40;
  const legend = T.heat.map((c, i) => `<rect x="${legendX + i * 15}" y="${H - 34}" width="11" height="11" rx="2.5" fill="${c}"/>`).join('');
  return svg(W, H, `${cal.total} contributions in the last year`, `${panel(0, 0, W, H)}
${months.join('\n')}
${days}
${cells}
<text x="28" y="${H - 24}" font-size="13" fill="${T.faint}">Last 52 weeks of activity · <tspan fill="${T.text}" font-weight="600">${esc(compact(cal.total))}</tspan> contributions in the last year</text>
<text x="${legendX - 8}" y="${H - 24}" font-size="12" fill="${T.faint}" text-anchor="end">Less</text>${legend}
<text x="${legendX + 5 * 15 + 2}" y="${H - 24}" font-size="12" fill="${T.faint}">More</text>`);
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

function projectCard(repo) {
  const W = 432, H = 150;
  const desc = wrap(repo.description || 'No description yet.', 14, W - 48, 2);
  const lang = repo.language;
  const updated = new Date(repo.pushed_at);
  let x = 24;
  const meta = [];
  if (lang) {
    meta.push(`<circle cx="${x + 6}" cy="${H - 29}" r="6" fill="${langColor(lang)}"/><text x="${x + 18}" y="${H - 24}" font-size="13" fill="${T.muted}">${esc(lang)}</text>`);
    x += textWidth(lang, 13) + 36;
  }
  meta.push(`<g transform="translate(${x} ${H - 37}) scale(.66)" fill="none" stroke="${T.muted}" stroke-width="2" stroke-linejoin="round">${ICONS.stars}</g><text x="${x + 20}" y="${H - 24}" font-size="13" fill="${T.muted}">${compact(repo.stargazers_count)}</text>`);
  x += 20 + textWidth(compact(repo.stargazers_count), 13) + 18;
  meta.push(`<g transform="translate(${x} ${H - 37}) scale(.66)" fill="none" stroke="${T.muted}" stroke-width="2" stroke-linecap="round">${ICONS.fork}</g><text x="${x + 20}" y="${H - 24}" font-size="13" fill="${T.muted}">${compact(repo.forks_count)}</text>`);
  meta.push(`<text x="${W - 24}" y="${H - 24}" font-size="12" fill="${T.faint}" text-anchor="end">Updated ${MONTHS[updated.getUTCMonth()]} ${updated.getUTCFullYear()}</text>`);
  return svg(W, H, `${repo.name}: ${repo.description || 'no description'}. ${repo.stargazers_count} stars.`, `${panel(0, 0, W, H)}
<g transform="translate(24 21) scale(.75)" fill="none" stroke="${T.accent}" stroke-width="2" stroke-linejoin="round"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/></g>
<text x="50" y="37" font-size="17" font-weight="600" fill="${T.text}">${esc(truncate(repo.name, 17, W - 80))}</text>
${desc.map((l, i) => `<text x="24" y="${70 + i * 21}" font-size="14" fill="${T.muted}">${esc(l)}</text>`).join('\n')}
${meta.join('\n')}`, 12);
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

const cal = TOKEN ? await calendarFromGraphQL() : await calendarFromPublicPage();

const notable = [...sources]
  .filter((r) => !r.archived)
  .sort((a, b) => b.stargazers_count - a.stargazers_count
    || Number(Boolean(b.description || b.language)) - Number(Boolean(a.description || a.language))
    || b.pushed_at.localeCompare(a.pushed_at))
  .slice(0, config.notableProjects);

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/banner.svg`, bannerCard(user, now));
await writeFile(`${OUT}/kpis.svg`, kpiCard(stats));
await writeFile(`${OUT}/contributions.svg`, heatmapCard(cal));
await writeFile(`${OUT}/tech-stack.svg`, techCard(langs, config.extraTechnologies));
for (let i = 0; i < config.notableProjects; i++) {
  const r = notable[i];
  // Fixed file names keep the README stable; unused slots get an empty card.
  await writeFile(`${OUT}/project-${i + 1}.svg`, r ? projectCard(r) : svg(432, 150, 'More projects coming soon', `${panel(0, 0, 432, 150)}<text x="216" y="80" font-size="14" fill="${T.faint}" text-anchor="middle">More projects coming soon</text>`, 12));
}
// The project order can change, so the README's linked block is rewritten to match.
const readme = await readFile('README.md', 'utf8');
const links = Array.from({ length: config.notableProjects }, (_, i) => {
  const r = notable[i];
  const img = `<img src="${OUT}/project-${i + 1}.svg" width="49%" alt="${esc(r ? r.name : 'More projects coming soon')}" />`;
  return r ? `<a href="${esc(r.html_url)}">${img}</a>` : img;
}).join('\n');
const block = /(<!-- projects:start -->)[\s\S]*?(<!-- projects:end -->)/;
if (!block.test(readme)) throw new Error('README.md is missing the <!-- projects:start --> / <!-- projects:end --> markers');
await writeFile('README.md', readme.replace(block, `$1\n<p align="center">\n${links}\n</p>\n$2`));

console.log(JSON.stringify({ ...stats, contributions: cal.total, languages: langs.length, notable: notable.map((r) => r.name) }));

#!/usr/bin/env node
// `pnpm site:report`: the site's daily report for a team chat (docs/marketing.md "Daily report"):
// yesterday in Umami (visitors, views, top pages, sources, events) and the last 7 days with data
// in Search Console. Run daily by .github/workflows/site-report.yml.
// Umami (self-hosted): UMAMI_URL, UMAMI_WEBSITE_ID, UMAMI_USER, UMAMI_PASSWORD (a view-only user).
// Search Console: GSC_SITE_URL, GSC_CREDENTIALS (as `pnpm seo:report`).
// Telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (the bot must be in that chat or channel).
// Each part is used only when its variables are set; without the Telegram pair it prints the report
// (outside CI only).
import { pathToFileURL } from 'node:url';
import { query, requests } from './seo-report.mjs';

/** Yesterday as a UTC day: [start, end] in ms and its date. */
export function yesterday(now = new Date()) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 1;
  const start = end + 1 - 86_400_000;
  return { start, end, date: new Date(start).toISOString().slice(0, 10) };
}

const delta = (now, before) => {
  const d = now - before;
  return d === 0 ? '' : ` (${d > 0 ? '+' : '−'}${Math.abs(d)})`;
};
const list = (rows, empty = '  none') =>
  rows?.length ? rows.map((r) => `  ${r.x || '(direct)'}: ${r.y}`) : [empty];

/** The message. `umami`: {stats, path, referrer, event}; `gsc`: {req, res}; either may be absent. */
export function format({ site, date, umami, gsc }) {
  const lines = [`${site}: ${date} (UTC)`];
  if (umami) {
    const s = umami.stats;
    const c = s.comparison ?? {};
    const bounce = s.visits ? Math.round((s.bounces / s.visits) * 100) : 0;
    lines.push(
      '',
      `Visitors ${s.visitors}${delta(s.visitors, c.visitors ?? s.visitors)}, views ${s.pageviews}${delta(s.pageviews, c.pageviews ?? s.pageviews)}, bounce ${bounce}% (vs the day before)`,
      'Top pages:',
      ...list(umami.path),
      'Sources:',
      ...list(umami.referrer),
      'Events:',
      ...list(umami.event),
    );
  }
  if (gsc) {
    const t = gsc.res.totals.rows?.[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    lines.push(
      '',
      `Google, ${gsc.req.totals.startDate} .. ${gsc.req.totals.endDate}: clicks ${t.clicks}, impressions ${t.impressions}, CTR ${(t.ctr * 100).toFixed(1)}%, position ${t.position.toFixed(1)}`,
      'Top queries:',
      ...(gsc.res.queries.rows?.length
        ? gsc.res.queries.rows
            .slice(0, 5)
            .map(
              (r) =>
                `  ${r.keys[0]}: ${r.clicks} clicks, ${r.impressions} impr, pos ${r.position.toFixed(1)}`,
            )
        : ['  none yet']),
    );
  }
  return lines.join('\n');
}

async function umami(env, day) {
  const base = env.UMAMI_URL.replace(/\/$/, '');
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: env.UMAMI_USER, password: env.UMAMI_PASSWORD }),
  });
  if (!login.ok) throw new Error(`umami login: HTTP ${login.status}`);
  const auth = { authorization: `Bearer ${(await login.json()).token}` };
  const get = async (path) => {
    const r = await fetch(`${base}/api/websites/${env.UMAMI_WEBSITE_ID}/${path}`, {
      headers: auth,
    });
    if (!r.ok) throw new Error(`umami ${path.split('?')[0]}: HTTP ${r.status}`);
    return r.json();
  };
  const q = `startAt=${day.start}&endAt=${day.end}`;
  const out = { stats: await get(`stats?${q}`) };
  for (const type of ['path', 'referrer', 'event'])
    out[type] = await get(`metrics?${q}&type=${type}&limit=5`);
  return out;
}

async function main(env = process.env) {
  const day = yesterday();
  const site =
    env.SITE_URL?.replace(/^https?:\/\//, '').replace(/\/$/, '') || env.GSC_SITE_URL || 'site';
  const parts = { site, date: day.date };
  if (env.UMAMI_URL && env.UMAMI_WEBSITE_ID && env.UMAMI_USER && env.UMAMI_PASSWORD)
    parts.umami = await umami(env, day);
  if (env.GSC_SITE_URL && env.GSC_CREDENTIALS) {
    const req = requests(7);
    parts.gsc = { req, res: await query(env.GSC_SITE_URL, env.GSC_CREDENTIALS, req) };
  }
  if (!parts.umami && !parts.gsc)
    return console.log('site:report: neither Umami nor Search Console is configured');
  const text = format(parts);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)
    // A public repository's Actions logs are public: CI never prints the numbers.
    return console.log(env.CI ? 'site:report: Telegram is not configured, nothing sent' : text);
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      link_preview_options: { is_disabled: true },
    }),
  });
  if (!r.ok) throw new Error(`telegram: HTTP ${r.status} ${(await r.json()).description ?? ''}`);
  console.log(`site:report: sent the report for ${day.date}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`site:report: ${e.message}`);
    process.exit(1);
  });
}

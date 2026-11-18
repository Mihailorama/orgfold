import assert from 'node:assert/strict';
import { test } from 'node:test';
import { format, yesterday } from './site-report.mjs';

test('yesterday is the previous UTC day', () => {
  const d = yesterday(new Date('2026-11-18T08:30:00Z'));
  assert.equal(d.date, '2026-11-17');
  assert.equal(new Date(d.start).toISOString(), '2026-11-17T00:00:00.000Z');
  assert.equal(new Date(d.end).toISOString(), '2026-11-17T23:59:59.999Z');
});

test('the report shows Umami with day-over-day changes and Search Console totals', () => {
  const text = format({
    site: 'example.com',
    date: '2026-11-17',
    umami: {
      stats: {
        visitors: 12,
        pageviews: 30,
        visits: 10,
        bounces: 4,
        comparison: { visitors: 9, pageviews: 31 },
      },
      path: [{ x: '/', y: 20 }],
      referrer: [{ x: '', y: 7 }],
      event: [],
    },
    gsc: {
      req: { totals: { startDate: '2026-11-08', endDate: '2026-11-14' } },
      res: {
        totals: { rows: [{ clicks: 3, impressions: 120, ctr: 0.025, position: 18.44 }] },
        queries: { rows: [{ keys: ['saas starter'], clicks: 2, impressions: 40, position: 9.1 }] },
      },
    },
  });
  assert.match(text, /Visitors 12 \(\+3\), views 30 \(−1\), bounce 40%/);
  assert.match(text, / {2}\/: 20\n/);
  assert.match(text, / {2}\(direct\): 7/);
  assert.match(text, /Events:\n {2}none/);
  assert.match(text, /clicks 3, impressions 120, CTR 2\.5%, position 18\.4/);
  assert.match(text, / {2}saas starter: 2 clicks, 40 impr, pos 9\.1/);
});

test('a part that is not configured is left out', () => {
  const text = format({
    site: 'example.com',
    date: '2026-11-17',
    umami: undefined,
    gsc: undefined,
  });
  assert.equal(text, 'example.com: 2026-11-17 (UTC)');
});

import { readFileSync } from 'node:fs';
import { stackPlans } from '@app/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { db } from '../db.ts';
import { env } from '../env.ts';
import { REAUTH_MAX_AGE_SECONDS } from '../mfa.ts';
import { s3Reachable } from '../s3.ts';
import { startStackPlan } from '../temporal.ts';
import { httpError } from '../tenant.ts';
import {
  auditPlatform,
  ErrorBody,
  errorHandler,
  Id,
  iso,
  requireOperator,
} from './admin-common.ts';

/**
 * The company's stack in the operator console (docs/admin.md "Stack"): every component of
 * config/components.json with how it runs here and whether it answers now. Read only: changes
 * go through `pnpm run infra` on the admin's machine, which also writes STACK_MODES.
 */

type Catalog = {
  components: {
    id: string;
    title: string;
    tier: string;
    group?: string;
    description: string;
    modes: string[];
    available?: boolean;
    install?: { ramMiB?: number; site?: string };
    requires?: Record<string, string[]>;
  }[];
};
const catalog = (
  JSON.parse(
    readFileSync(new URL('../../../../config/components.json', import.meta.url), 'utf8'),
  ) as Catalog
).components.filter((c) => c.available !== false);

const Mode = z.enum(['install', 'connect', 'skip']);
const Status = z.enum(['up', 'down', 'unchecked']);
const Component = z.object({
  id: z.string(),
  title: z.string(),
  group: z.enum(['app', 'base', 'product', 'tools']),
  description: z.string(),
  modes: z.array(Mode),
  mode: Mode.nullable(),
  url: z.string().nullable(),
  ramMiB: z.number().nullable(),
  requires: z.record(z.string(), z.array(z.string())),
  status: Status,
});
const Stack = z.object({
  profile: z.object({ name: z.string(), address: z.string(), mailFrom: z.string().nullable() }),
  reported: z.boolean(),
  checkedAt: z.string(),
  components: z.array(Component),
});
export type StackComponent = z.infer<typeof Component>;

const Plan = z.object({
  id: z.string(),
  request: z.string(),
  status: z.enum(['drafting', 'ready', 'failed', 'off', 'approved', 'applied']),
  reply: z.string().nullable(),
  actions: z.array(z.object({ component: z.string(), mode: Mode })),
  /** Made for the stack as it is now; false = it changed since, the plan cannot be approved. */
  current: z.boolean(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  appliedAt: z.string().nullable(),
});
type PlanRow = typeof stackPlans.$inferSelect;
const toPlan = (p: PlanRow): z.infer<typeof Plan> => ({
  id: p.id,
  request: p.request,
  status: p.status as z.infer<typeof Plan>['status'],
  reply: p.reply,
  actions: (p.actions ?? []) as z.infer<typeof Plan>['actions'],
  current: p.stackVersion === stackVersion(),
  createdAt: iso(p.createdAt) ?? '',
  approvedAt: iso(p.approvedAt),
  appliedAt: iso(p.appliedAt),
});
/** The stack a plan is made for: STACK_MODES itself (scripts/infra.mjs compares it at apply). */
const stackVersion = () => env.STACK_MODES ?? '';

/** STACK_MODES=postgres:install,smtp:connect,... (written by scripts/infra.mjs). */
export function parseModes(raw: string | undefined) {
  const modes = new Map<string, z.infer<typeof Mode>>();
  for (const pair of (raw ?? '').split(',')) {
    const [id, mode] = pair.trim().split(':');
    const m = Mode.safeParse(mode);
    if (id && m.success) modes.set(id, m.data);
  }
  return modes;
}

/** Up when the probe settles within 3 s (a blackholed endpoint must not hang the page). */
const ok = (p: Promise<unknown>) =>
  Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000).unref()),
  ]).then(
    () => 'up' as const,
    () => 'down' as const,
  );

/** A public site answers (anything below 500, a sign-in redirect included). */
const site = (url: string) =>
  ok(
    fetch(url, { redirect: 'manual' }).then((r) => {
      if (r.status >= 500) throw new Error(String(r.status));
    }),
  );

function check(redis: Redis, id: string, mode: string | null, url: string | null) {
  if (mode === 'skip' || mode === null) return Promise.resolve('unchecked' as const);
  if (id === 'core') return ok(Promise.all([db.execute(sql`select 1`), redis.ping()]));
  if (id === 'postgres') return ok(db.execute(sql`select 1`));
  if (id === 's3') return ok(s3Reachable());
  if (url) return site(url);
  return Promise.resolve('unchecked' as const);
}

export const adminStackRoutes: FastifyPluginAsyncZod<{ redis: Redis }> = async (app, { redis }) => {
  app.setErrorHandler(errorHandler);
  app.get(
    '/stack',
    {
      preHandler: requireOperator,
      schema: { tags: ['admin'], hide: true, response: { 200: Stack } },
    },
    async () => {
      const modes = parseModes(env.STACK_MODES);
      const components = await Promise.all(
        catalog.map(async (c) => {
          const mode = modes.get(c.id) ?? null;
          // "Open" only for tools people use in a browser; S3's site is an API endpoint.
          const key = mode === 'install' && c.id !== 's3' ? c.install?.site : undefined;
          const url = (key && z.url().safeParse(process.env[key]).data) || null;
          return {
            id: c.id,
            title: c.title,
            group:
              c.id === 'core'
                ? ('app' as const)
                : c.group === 'base' || c.group === 'product'
                  ? c.group
                  : ('tools' as const),
            // Doc pointers help at setup, not here: "(Vaultwarden; docs/secrets.md)" -> "(Vaultwarden)".
            description: c.description
              .replace(/;\s*docs\/[\w./-]+/g, '')
              .replace(/\s*\(docs\/[\w./-]+\)/g, ''),
            modes: c.modes as z.infer<typeof Mode>[],
            mode,
            url,
            ramMiB: c.install?.ramMiB ?? null,
            requires: c.requires ?? {},
            status: await check(redis, c.id, mode, url),
          };
        }),
      );
      return {
        profile: {
          name: env.APP_NAME,
          address: new URL(env.BETTER_AUTH_URL).origin,
          mailFrom: env.MAIL_FROM ?? null,
        },
        reported: modes.size > 0,
        checkedAt: new Date().toISOString(),
        components,
      };
    },
  );

  // "Plan a change" (docs/admin.md): the agent turns a request into catalog actions; nothing on
  // the servers changes here. The admin approves with a recent sign-in (email code + 2FA), and
  // `pnpm run infra -- apply <id>` on their machine runs it once, as approved.
  app.get(
    '/stack/plans',
    {
      preHandler: requireOperator,
      schema: { tags: ['admin'], hide: true, response: { 200: z.array(Plan) } },
    },
    async () =>
      (await db.select().from(stackPlans).orderBy(desc(stackPlans.createdAt)).limit(20)).map(
        toPlan,
      ),
  );
  app.post(
    '/stack/plans',
    {
      preHandler: requireOperator,
      schema: {
        tags: ['admin'],
        hide: true,
        body: z.object({ request: z.string().trim().min(3).max(2000) }),
        response: { 201: Plan, 409: ErrorBody },
      },
    },
    async (req, reply) => {
      if (!stackVersion()) {
        throw httpError(409, 'this server has not reported its components yet (Stack page)');
      }
      const [row] = await db
        .insert(stackPlans)
        .values({
          request: req.body.request,
          stackVersion: stackVersion(),
          createdBy: req.operator.id,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      await startStackPlan({ planId: row.id });
      return reply.code(201).send(toPlan(row));
    },
  );
  app.post(
    '/stack/plans/:id/approve',
    {
      preHandler: requireOperator,
      schema: {
        tags: ['admin'],
        hide: true,
        params: Id,
        response: { 200: Plan, 401: ErrorBody, 404: ErrorBody, 409: ErrorBody },
      },
    },
    async (req) => {
      if (Date.now() - req.operator.signedInAt > REAUTH_MAX_AGE_SECONDS * 1000) {
        throw httpError(401, 'approving needs a recent sign-in: sign in again, then approve');
      }
      const [plan] = await db.select().from(stackPlans).where(eq(stackPlans.id, req.params.id));
      if (!plan) throw httpError(404, 'no such plan');
      if (plan.stackVersion !== stackVersion()) {
        throw httpError(409, 'the stack changed since this plan was made: ask again');
      }
      if (plan.status !== 'ready' || !plan.actions?.length) {
        throw httpError(409, 'only a ready plan with actions can be approved');
      }
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(stackPlans)
          .set({ status: 'approved', approvedBy: req.operator.id, approvedAt: new Date() })
          .where(and(eq(stackPlans.id, plan.id), eq(stackPlans.status, 'ready')))
          .returning();
        if (!row) throw httpError(409, 'only a ready plan with actions can be approved');
        await auditPlatform(tx, req, 'stack_plan.approved', row.id);
        return toPlan(row);
      });
    },
  );
};

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
import { encryptSecret } from '../webhook-secret.ts';
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
    connect?: {
      key: string;
      prompt: string;
      secret?: boolean;
      default?: string;
      validate?: string;
    }[];
  }[];
};
const catalog = (
  JSON.parse(
    readFileSync(new URL('../../../../config/components.json', import.meta.url), 'utf8'),
  ) as Catalog
).components.filter((c) => c.available !== false);

const Mode = z.enum(['install', 'connect', 'skip']);

/**
 * The address and keys a `connect` asks for, entered on the page (the chat's connect card, as in
 * Lovable or v0) instead of at `infra apply`. Not for the model's own fields (`@apiKey`, AI_*):
 * those depend on each other and are connected on "Connect a model".
 */
const connectFields = (id: string) => {
  const fields = catalog.find((c) => c.id === id)?.connect ?? [];
  return fields.some((f) => f.key.startsWith('@') || f.key.startsWith('AI_')) ? [] : fields;
};
type Entered = NonNullable<typeof stackPlans.$inferSelect.connect>;
const Field = z.object({
  key: z.string(),
  label: z.string(),
  secret: z.boolean(),
  default: z.string().nullable(),
  /** Entered already: the plain value, or a secret's last 4 characters. */
  entered: z.string().nullable(),
});
const Action = z.object({ component: z.string(), mode: Mode, fields: z.array(Field) });
const toActions = (actions: { component: string; mode: string }[], entered: Entered) =>
  actions.map((a) => ({
    component: a.component,
    mode: a.mode as z.infer<typeof Mode>,
    fields:
      a.mode === 'connect'
        ? connectFields(a.component).map((f) => {
            const e = entered[a.component]?.[f.key];
            return {
              key: f.key,
              label: f.prompt,
              secret: Boolean(f.secret),
              default: f.default ?? null,
              entered: (f.secret ? e?.hint && `…${e.hint}` : e?.value) || null,
            };
          })
        : [],
  }));

/**
 * Keys never go to the agent (its request is the model's input): a request that looks like it
 * carries one is refused, and the page points to the connect card. Known key shapes only.
 */
const KEY_LIKE =
  /\b(sk-[\w-]{16,}|sk_(live|test)_\w{10,}|(ghp|gho|github_pat)_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.)|\b[a-zA-Z][\w+.-]{1,15}:\/\/[^\s/:@]{1,256}:[^\s/@]{1,256}@/;
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
  actions: z.array(Action),
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
  actions: toActions(p.actions ?? [], p.connect ?? {}),
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
        // A request for the agent, or one catalog action picked on the page (no agent).
        body: z.union([
          z.object({ request: z.string().trim().min(3).max(2000) }),
          z.object({ component: z.string(), mode: Mode }),
        ]),
        response: { 201: Plan, 400: ErrorBody, 409: ErrorBody },
      },
    },
    async (req, reply) => {
      if (!stackVersion()) {
        throw httpError(409, 'this server has not reported its components yet (Stack page)');
      }
      const base = { stackVersion: stackVersion(), createdBy: req.operator.id };
      if ('component' in req.body) {
        const { component, mode } = req.body;
        const c = catalog.find((x) => x.id === component);
        if (!c || c.tier === 'core' || !c.modes.includes(mode)) {
          throw httpError(400, 'not an action of the catalog');
        }
        const [row] = await db
          .insert(stackPlans)
          .values({
            ...base,
            request: `${mode === 'install' ? 'Install' : mode === 'connect' ? 'Connect' : 'Remove'} ${c.title}`,
            status: 'ready',
            actions: [{ component, mode }],
          })
          .returning();
        if (!row) throw new Error('insert returned no row');
        return reply.code(201).send(toPlan(row));
      }
      if (KEY_LIKE.test(req.body.request)) {
        throw httpError(
          400,
          "this looks like a key or password, and requests go to the agent: leave it out, and enter it in the plan's connect card",
        );
      }
      const [row] = await db
        .insert(stackPlans)
        .values({ ...base, request: req.body.request })
        .returning();
      if (!row) throw new Error('insert returned no row');
      try {
        await startStackPlan({ planId: row.id });
      } catch (err) {
        // Not left "drafting" forever (the page polls while a plan drafts).
        await db
          .update(stackPlans)
          .set({ status: 'failed', reply: 'Could not start the planning agent. Try again later.' })
          .where(eq(stackPlans.id, row.id));
        throw err;
      }
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

  // The connect card: what a `connect` action needs, entered here so apply does not ask for it.
  // Secrets are encrypted at once and never shown again (only their last 4 characters).
  app.put(
    '/stack/plans/:id/connect/:component',
    {
      preHandler: requireOperator,
      schema: {
        tags: ['admin'],
        hide: true,
        params: Id.extend({ component: z.string() }),
        body: z.object({ values: z.record(z.string(), z.string().trim().min(1).max(4096)) }),
        response: { 200: Plan, 400: ErrorBody, 404: ErrorBody, 409: ErrorBody },
      },
    },
    async (req) => {
      const { id, component } = req.params;
      return db.transaction(async (tx) => {
        const [plan] = await tx
          .select()
          .from(stackPlans)
          .where(eq(stackPlans.id, id))
          .for('update');
        if (!plan) throw httpError(404, 'no such plan');
        if (!['ready', 'approved'].includes(plan.status)) {
          throw httpError(409, 'only a plan that has not run yet takes values');
        }
        const fields = plan.actions?.some((a) => a.component === component && a.mode === 'connect')
          ? connectFields(component)
          : [];
        if (!fields.length) throw httpError(400, 'this plan does not connect that component');
        const mine = { ...plan.connect?.[component] };
        for (const [key, v] of Object.entries(req.body.values)) {
          const f = fields.find((x) => x.key === key);
          if (!f) throw httpError(400, `unknown field ${key}`);
          if (f.validate && !new RegExp(f.validate).test(v)) throw httpError(400, f.prompt);
          if (v.includes('$') || /[\r\n]/.test(v))
            throw httpError(400, `${key}: no $ or line breaks`);
          mine[key] = f.secret
            ? {
                cipher: encryptSecret(v, `stack-plan/${id}/${component}/${key}`),
                hint: v.slice(-4),
              }
            : { value: v };
        }
        const [row] = await tx
          .update(stackPlans)
          .set({ connect: { ...plan.connect, [component]: mine } })
          .where(eq(stackPlans.id, id))
          .returning();
        if (!row) throw new Error('update returned no row');
        await auditPlatform(tx, req, 'stack_plan.connect_entered', id);
        return toPlan(row);
      });
    },
  );
};

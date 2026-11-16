import { readFileSync } from 'node:fs';
import { platformAi } from '@app/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '../db.ts';
import { env } from '../env.ts';
import { REAUTH_MAX_AGE_SECONDS } from '../mfa.ts';
import { httpError } from '../tenant.ts';
import { encryptSecret } from '../webhook-secret.ts';
import { auditPlatform, ErrorBody, errorHandler, iso, requireOperator } from './admin-common.ts';

/**
 * "Connect a model" (docs/admin.md): the first step of the operator console, the way an agent's
 * setup starts. The operator picks a subscription (Claude: the token `claude setup-token` prints;
 * ChatGPT: a device code Codex shows, entered in their browser) or an API key, then the model. The
 * platform's agents think with it (the stack agent first). Subscription logins stay inside llm-cli
 * (LLM_CLI_URL); an API key is encrypted at once and only the worker decrypts it. Changes need a
 * recent sign-in with the second factor and leave an `operator.ai.*` audit row.
 */
type Registry = {
  providers: Record<string, { kind: string; cli?: string }>;
  contours: Record<string, { provider: string; model: string; purposes: string[] }[]>;
};
const registry = JSON.parse(
  readFileSync(new URL('../../../../config/ai-models.json', import.meta.url), 'utf8'),
) as Registry;
const LABEL: Record<string, string> = {
  codex_cli: 'ChatGPT subscription',
  claude_cli: 'Claude subscription (Pro or Max)',
  anthropic: 'Anthropic API key',
  openai: 'OpenAI API key',
  gemini: 'Google Gemini API key',
  openrouter: 'OpenRouter API key',
};
const LOGIN_OF: Record<string, 'claude' | 'codex'> = { claude_cli: 'claude', codex_cli: 'codex' };
/** What the operator can pick: offered providers whose models this contour lets plan the stack. */
function options() {
  const rows = (registry.contours[env.AI_CONTOUR] ?? []).filter(
    (r) => LABEL[r.provider] && r.purposes.includes('stack.plan'),
  );
  return Object.keys(LABEL).flatMap((provider) => {
    const models = rows.filter((r) => r.provider === provider).map((r) => r.model);
    if (!models.length) return [];
    const kind = registry.providers[provider]?.kind === 'cli' ? 'subscription' : 'key';
    return [{ provider, label: LABEL[provider]!, kind: kind as 'subscription' | 'key', models }];
  });
}

/** llm-cli's sign-in endpoints (services/llm-cli/src/server.ts); null when it is not running. */
async function llmCli(path: string, init: { method: string; body?: unknown } = { method: 'GET' }) {
  if (!env.LLM_CLI_URL || !env.LLM_CLI_TOKEN) return null;
  const res = await fetch(`${env.LLM_CLI_URL}${path}`, {
    method: init.method,
    headers: { authorization: `Bearer ${env.LLM_CLI_TOKEN}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(40_000),
  }).catch(() => null);
  if (!res) return null;
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (body.error as { message?: string } | undefined)?.message ?? 'llm-cli refused it';
    throw httpError(res.status === 400 ? 400 : 502, msg);
  }
  return body;
}

const Device = z.object({
  state: z.enum(['pending', 'done', 'failed']),
  url: z.string().optional(),
  code: z.string().optional(),
});
const Logins = z.object({ claude: z.boolean(), codex: z.boolean(), device: Device.nullable() });
const Ai = z.object({
  connected: z
    .object({
      provider: z.string(),
      model: z.string(),
      label: z.string(),
      keyHint: z.string().nullable(),
      updatedAt: z.string(),
    })
    .nullable(),
  options: z.array(
    z.object({
      provider: z.string(),
      label: z.string(),
      kind: z.enum(['subscription', 'key']),
      models: z.array(z.string()),
    }),
  ),
  /** Subscription sign-ins in llm-cli; null = llm-cli is not running (no subscriptions). */
  logins: Logins.nullable(),
});

const fresh = (signedInAt: number) => {
  if (Date.now() - signedInAt > REAUTH_MAX_AGE_SECONDS * 1000) {
    throw httpError(401, 'connecting a model needs a recent sign-in: sign in again, then connect');
  }
};

export const adminAiRoutes: FastifyPluginAsyncZod = async (app) => {
  app.setErrorHandler(errorHandler);

  app.get(
    '/ai',
    { preHandler: requireOperator, schema: { tags: ['admin'], hide: true, response: { 200: Ai } } },
    async () => {
      const [row] = await db.select().from(platformAi).where(eq(platformAi.id, 'default'));
      return {
        connected: row
          ? {
              provider: row.provider,
              model: row.model,
              label: LABEL[row.provider] ?? row.provider,
              keyHint: row.apiKeyHint,
              updatedAt: iso(row.updatedAt) ?? '',
            }
          : null,
        options: options(),
        logins: Logins.nullable().parse((await llmCli('/logins').catch(() => null)) ?? null),
      };
    },
  );

  app.put(
    '/ai',
    {
      preHandler: requireOperator,
      schema: {
        tags: ['admin'],
        hide: true,
        body: z.object({
          provider: z.string(),
          model: z.string(),
          apiKey: z.string().trim().min(8).max(4096).optional(),
        }),
        response: { 200: z.object({ ok: z.literal(true) }), 400: ErrorBody, 401: ErrorBody },
      },
    },
    async (req) => {
      fresh(req.operator.signedInAt);
      const { provider, model, apiKey } = req.body;
      const option = options().find((o) => o.provider === provider);
      if (!option?.models.includes(model)) throw httpError(400, 'not a model offered here');
      const [row] = await db.select().from(platformAi).where(eq(platformAi.id, 'default'));
      let key: { apiKey: string | null; apiKeyHint: string | null } = {
        apiKey: null,
        apiKeyHint: null,
      };
      if (option.kind === 'subscription') {
        if (apiKey) throw httpError(400, 'a subscription has no API key: sign in instead');
        const logins = await llmCli('/logins');
        if (!logins?.[LOGIN_OF[provider]!])
          throw httpError(400, 'sign in to the subscription first');
      } else if (apiKey) {
        key = { apiKey: encryptSecret(apiKey, 'platform/default'), apiKeyHint: apiKey.slice(-4) };
      } else if (row?.provider === provider && row.apiKey) {
        key = { apiKey: row.apiKey, apiKeyHint: row.apiKeyHint }; // same vendor: keep its key
      } else throw httpError(400, 'enter the API key');
      const values = {
        provider,
        model,
        ...key,
        connectedBy: req.operator.id,
        updatedAt: new Date(),
      };
      await db.transaction(async (tx) => {
        await tx
          .insert(platformAi)
          .values({ id: 'default', ...values })
          .onConflictDoUpdate({ target: platformAi.id, set: values });
        await auditPlatform(tx, req, 'ai.connected', `${provider}/${model}`);
      });
      return { ok: true as const };
    },
  );

  app.delete(
    '/ai',
    {
      preHandler: requireOperator,
      schema: {
        tags: ['admin'],
        hide: true,
        response: { 200: z.object({ ok: z.literal(true) }), 401: ErrorBody },
      },
    },
    async (req) => {
      fresh(req.operator.signedInAt);
      await db.transaction(async (tx) => {
        await tx.delete(platformAi).where(eq(platformAi.id, 'default'));
        await auditPlatform(tx, req, 'ai.disconnected', 'default');
      });
      return { ok: true as const };
    },
  );

  // Subscription sign-ins: llm-cli runs them and keeps the login; nothing secret comes back here.
  app.put(
    '/ai/logins/claude',
    {
      preHandler: requireOperator,
      schema: {
        tags: ['admin'],
        hide: true,
        body: z.object({ token: z.string().trim().min(20).max(512) }),
        response: { 200: z.object({ ok: z.literal(true) }), 400: ErrorBody, 401: ErrorBody },
      },
    },
    async (req) => {
      fresh(req.operator.signedInAt);
      if (!(await llmCli('/logins/claude', { method: 'PUT', body: { token: req.body.token } }))) {
        throw httpError(400, 'subscriptions need llm-cli: pnpm run infra installs it');
      }
      await db.transaction((tx) => auditPlatform(tx, req, 'ai.signed_in', 'claude'));
      return { ok: true as const };
    },
  );
  app.post(
    '/ai/logins/codex',
    {
      preHandler: requireOperator,
      schema: {
        tags: ['admin'],
        hide: true,
        response: { 200: Device, 400: ErrorBody, 401: ErrorBody },
      },
    },
    async (req) => {
      fresh(req.operator.signedInAt);
      const device = await llmCli('/logins/codex', { method: 'POST' });
      if (!device) throw httpError(400, 'subscriptions need llm-cli: pnpm run infra installs it');
      await db.transaction((tx) => auditPlatform(tx, req, 'ai.sign_in_started', 'codex'));
      return Device.parse(device);
    },
  );
};

// `pnpm run infra -- apply <id>` reads an approved plan through this over SSH (docs/admin.md
// "Plan a change"): `docker compose exec -T api node apps/api/src/stack-plan.ts get|applied <id>`.
// SSH to the server is the authorization; the server never applies a plan itself.
import { stackPlans } from '@app/db';
import { and, eq } from 'drizzle-orm';
import { db, pool } from './db.ts';
import { openSecret } from './webhook-secret.ts';

const [cmd, id] = process.argv.slice(2);
if (!id || !/^[0-9a-f-]{36}$/.test(id) || !['get', 'applied'].includes(cmd ?? '')) {
  process.stderr.write('usage: stack-plan.ts get|applied <plan id>\n');
  process.exit(2);
}
const [plan] =
  cmd === 'get'
    ? await db.select().from(stackPlans).where(eq(stackPlans.id, id))
    : await db
        .update(stackPlans)
        .set({ status: 'applied', appliedAt: new Date(), connect: null }) // values: used, gone
        .where(and(eq(stackPlans.id, id), eq(stackPlans.status, 'approved')))
        .returning();
await pool.end();
if (!plan) {
  process.stderr.write(cmd === 'get' ? 'no such plan\n' : 'plan is not approved\n');
  process.exit(1);
}
// What the operator entered in the connect cards, secrets decrypted for apply's env (sops, stdin).
const connect = Object.fromEntries(
  Object.entries((cmd === 'get' && plan.connect) || {}).map(([component, fields]) => [
    component,
    Object.fromEntries(
      Object.entries(fields).map(([key, f]) => [
        key,
        f.cipher ? openSecret(f.cipher, `stack-plan/${id}/${component}/${key}`) : f.value,
      ]),
    ),
  ]),
);
process.stdout.write(
  `${JSON.stringify({ status: plan.status, actions: plan.actions, stackVersion: plan.stackVersion, connect })}\n`,
);

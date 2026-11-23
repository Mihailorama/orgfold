// node --test 'scripts/*.test.mjs' (part of pnpm check:ts). `pnpm run infra` without a server:
// catalog check, answers validation, env rendering, the plan (dry-run) and that no value leaks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkComponents } from './check-components.mjs';
import {
  catalog,
  checkPlan,
  command,
  expandField,
  freshEnvError,
  option,
  plan,
  render,
  rotateErrors,
  summary,
  takeEntered,
  validateAnswers,
} from './infra.mjs';

const answers = () => ({
  env: 'production',
  project: 'app',
  server: { host: '203.0.113.10', admin: 'root', user: 'deploy' },
  domain: 'app.example.com',
  tls: 'ops@example.com',
  images: { repo: 'ghcr.io/mihailorama/orgfold', version: 'v1.0.0' },
  components: {
    postgres: { mode: 'install' },
    s3: { mode: 'install' },
    smtp: { mode: 'connect', MAIL_FROM: 'Workspace <no-reply@example.com>' },
    analytics: { mode: 'connect', POSTHOG_KEY: 'phc_example' },
    llm: {
      mode: 'connect',
      AI_CONTOUR: 'eu',
      AI_PROJECT_SUMMARY_PROVIDER: 'anthropic',
      AI_PROJECT_SUMMARY_MODEL: 'claude-haiku-5-5',
    },
    vault: { mode: 'skip' },
  },
});
const secrets = {
  SMTP_URL: 'smtp://local-dev-user:local-dev-pass@smtp.example.com:587',
  ANTHROPIC_API_KEY: 'local-dev-anthropic-key',
};

test('the catalog covers every prod profile and example.env key', () => {
  const profiles = [
    'db',
    's3',
    'vault',
    'analytics',
    'ops',
    'pii',
    'llm-cli',
    'booking',
    'crm',
    'gate',
    'openhands',
    'bolt',
    'hermes',
    'allure',
    'reportportal',
    'openseo',
    'docmost',
  ];
  const ok = checkComponents(catalog, profiles, ['DATABASE_URL']);
  assert.deepEqual(ok, []);
  const bad = checkComponents(catalog, [...profiles, 'newthing'], ['DATABASE_URL', 'NEW_KEY']);
  assert.deepEqual(bad.slice(-2), [
    'compose.prod.yaml profile newthing: no component',
    'deploy/env/example.env NEW_KEY: no component',
  ]);
  const broken = [{ id: 'x', tier: 'core', description: 'x', modes: ['install'], install: {} }];
  assert.match(checkComponents(broken, [], []).join(), /install needs ramMiB/);
  const offer = {
    name: 'X',
    url: 'https://example.com/pricing',
    free: '1 GB',
    checked: '2026-11-17',
  };
  const offers = (o, modes = ['connect']) => [
    { id: 'x', title: 'X', tier: 'optional', description: 'x', modes, offers: [o] },
  ];
  assert.deepEqual(checkComponents(offers(offer), [], []), []);
  assert.match(checkComponents(offers(offer, ['install']), [], []).join(), /without a connect/);
  assert.match(checkComponents(offers({ ...offer, checked: 'soon' }), [], []).join(), /checked/);
});

test('answers: valid ones pass, secrets and wrong choices are refused', () => {
  assert.deepEqual(validateAnswers(answers()), []);
  const a = answers();
  a.components.smtp.SMTP_URL = 'smtp://x@y';
  a.components.vault = { mode: 'install' };
  a.components.postgres.mode = 'connect';
  a.components.llm.AI_PROJECT_SUMMARY_MODEL = 'gpt-0';
  a.components.nope = { mode: 'skip' };
  a.components.booking = { mode: 'install' };
  delete a.components.s3;
  a.tls = 'not an email';
  const errors = validateAnswers(a).join('\n');
  for (const re of [
    /smtp\.SMTP_URL: a secret, never in answers \(use INFRA_SMTP_URL\)/,
    /vault: install needs postgres install/,
    /postgres\.TEMPORAL_DB_HOST: missing/,
    /llm\.AI_PROJECT_SUMMARY_MODEL: one of claude-haiku-5-5, claude-sonnet-5-5/,
    /components\.nope: unknown/,
    /booking: not available yet/,
    /components\.s3: install\|connect/,
    /tls: e-mail or internal/,
  ]) {
    assert.match(errors, re);
  }
  // Mail is the only way in (sign-in codes): it cannot be skipped or left out.
  const noMail = answers();
  noMail.components.smtp = { mode: 'skip' };
  assert.match(
    validateAnswers(noMail).join('\n'),
    /smtp: now required, it cannot be skip: run pnpm run infra -- add smtp/,
  );
  delete noMail.components.smtp;
  assert.match(validateAnswers(noMail).join('\n'), /components\.smtp/);
});

test('render: secrets generated once, kept, rotated on request; derived values follow', () => {
  const first = render(answers(), {}, { secrets });
  const { env } = first;
  assert.deepEqual(first.missing, []);
  assert.equal(env.COMPOSE_PROFILES, 'db,s3,llm-cli');
  // the console's stack page reads how each component runs; every available one is listed
  assert.match(
    env.STACK_MODES,
    /^core:install,postgres:install,s3:install,smtp:connect,.*crm:skip,wiki:skip$/,
  );
  assert.equal(env.DEPLOY_HOST, 'deploy@203.0.113.10');
  assert.match(env.BETTER_AUTH_SECRET, /^[0-9a-f]{64}$/);
  assert.match(env.WEBHOOK_ENCRYPTION_KEYS, /^k1:[0-9a-f]{64}$/);
  assert.equal(
    env.MIGRATION_DATABASE_URL,
    `postgres://postgres:${env.POSTGRES_PASSWORD}@postgres:5432/app`,
  );
  assert.equal(env.TEMPORAL_DB_PASSWORD, env.POSTGRES_PASSWORD);
  assert.equal(env.S3_PUBLIC_ENDPOINT, 'https://s3.app.example.com');
  assert.equal(env.POSTHOG_HOST, 'https://eu.i.posthog.com'); // default
  assert.equal(env.ANTHROPIC_API_KEY, secrets.ANTHROPIC_API_KEY); // @apiKey -> provider's key
  assert.ok(first.generated.includes('DATABASE_URL') && !first.generated.includes('S3_REGION'));

  const current = { ...env, SENTRY_DSN: 'https://k@sentry.example.com/1' };
  const again = render(answers(), current, { rotate: ['BETTER_AUTH_SECRET'] });
  assert.equal(again.env.POSTGRES_PASSWORD, env.POSTGRES_PASSWORD); // kept
  assert.equal(again.env.SMTP_URL, secrets.SMTP_URL); // connect secret kept from the env file
  assert.notEqual(again.env.BETTER_AUTH_SECRET, env.BETTER_AUTH_SECRET); // rotated
  assert.equal(again.env.SENTRY_DSN, current.SENTRY_DSN); // not owned by a component: untouched

  const a = answers();
  a.components.analytics = { mode: 'skip' };
  const skipped = render(a, current);
  assert.equal(skipped.env.POSTHOG_KEY, undefined); // skipped component: its keys go
  assert.deepEqual(render(answers(), {}).missing, ['SMTP_URL', 'ANTHROPIC_API_KEY']);
  assert.deepEqual(
    render(answers(), {}, { secrets: { ...secrets, SMTP_URL: 'smtp://a$b@x' } }).invalid,
    ['SMTP_URL'],
  );
});

test('plan (dry run): key names only, no value, exact text', () => {
  const printed = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...m) => printed.push(m.join(' '));
  try {
    const a = answers();
    const current = render(a, {}, { secrets }).env;
    a.components.analytics = { mode: 'install' };
    a.components.vault = { mode: 'install' };
    const out = render(a, { ...current, POSTHOG_KEY: 'phc_old' }, { rotate: ['S3_ACCESS_KEY_ID'] });
    const text = plan({ a, current, next: out.env, ...out, serverMiB: 3900 });
    assert.equal(
      text,
      `Plan for production: deploy@203.0.113.10, https://app.example.com, ghcr.io/mihailorama/orgfold v1.0.0
  components: core install, postgres install, s3 install, smtp connect, analytics install, llm connect, vault install, gate skip, openhands skip, bolt skip, hermes skip, allure skip, reportportal skip, openseo skip, crm skip, wiki skip
  profiles: + analytics, + vault
  env keys: ~ S3_ACCESS_KEY_ID (generated), + UMAMI_PUBLIC_URL, + UMAMI_DB_PASSWORD (generated), + UMAMI_APP_SECRET (generated), + UMAMI_ADMIN_PASSWORD (generated), + ANALYTICS_ORIGINS, + VAULT_PUBLIC_URL, + VAULT_DB_PASSWORD (generated), + VAULT_DATABASE_URL, + SSO_VAULTWARDEN_SECRET (generated), + SSO_VAULTWARDEN_REDIRECT_URIS, ~ STACK_MODES, - POSTHOG_HOST, - POSTHOG_KEY
  RAM budget (mem_limit): 5.5 GiB of 3.8 GiB on the server
  NOTE: the limits add up to more than 90 % of the server. It starts, but under load or with
  more components later a bigger server is recommended: resize it at your provider (data stays),
  or run heavy components on a second server and connect them.`,
    );
    for (const value of [...out.generated.map((k) => out.env[k]), ...Object.values(secrets)]) {
      assert.ok(!text.includes(value) && !printed.join('\n').includes(value), 'a value leaked');
    }
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(printed, []);
});

test('@apiKey follows the env names of config/ai-models.json', () => {
  const { providers } = JSON.parse(
    readFileSync(new URL('../config/ai-models.json', import.meta.url)),
  );
  const f = { key: '@apiKey', prompt: 'key', secret: true };
  for (const [id, p] of Object.entries(providers)) {
    if (p.kind === 'cli') continue;
    const keys = expandField(f, { AI_PROJECT_SUMMARY_PROVIDER: id }).map((x) => x.key);
    assert.deepEqual(keys, [p.baseUrlEnv, p.apiKeyEnv].filter(Boolean), id);
  }
  // A subscription asks for its login instead; llm-cli reads it from the file in its config.
  const login = (id) => expandField(f, { AI_PROJECT_SUMMARY_PROVIDER: id });
  assert.deepEqual(
    login('claude_cli').map((x) => [x.key, x.secret, x.login]),
    [['LLM_CLI_CLAUDE_TOKEN', true, 'claude']],
  );
  assert.deepEqual(
    login('codex_cli').map((x) => x.key),
    ['LLM_CLI_CODEX_AUTH'],
  );
  assert.deepEqual(login('gemini_cli'), []);
  const config = readFileSync(new URL('../infra/llm-cli/config.json', import.meta.url), 'utf8');
  for (const file of ['claude-1.token', 'codex-1.auth.json'])
    assert.ok(config.includes(file), file);
});

test('llm-cli always runs for the console sign-ins; a model set here runs the stack agent', () => {
  const env = render(answers(), {}, { secrets }).env;
  assert.equal(env.AI_STACK_PLAN_PROVIDER, 'anthropic');
  assert.equal(env.AI_STACK_PLAN_MODEL, 'claude-haiku-5-5');
  assert.ok(env.COMPOSE_PROFILES.split(',').includes('llm-cli'));
  assert.match(env.IMAGE_LLM_CLI, /^app-llm-cli:[0-9a-f]{12}$/);
  assert.match(env.LLM_CLI_TOKEN, /^[0-9a-f]{64}$/);

  const a = answers();
  a.components.llm.AI_PROJECT_SUMMARY_PROVIDER = 'claude_cli';
  a.operators = 'ops@example.com';
  assert.deepEqual(validateAnswers(a), []);
  const sub = render(a, {}, { secrets: { ...secrets, LLM_CLI_CLAUDE_TOKEN: 'local-dev-token' } });
  assert.deepEqual(sub.missing, []);
  assert.equal(sub.env.AI_STACK_PLAN_PROVIDER, 'claude_cli');
  assert.equal(sub.env.LLM_CLI_CLAUDE_TOKEN, 'local-dev-token');
  assert.equal(sub.env.OPERATOR_EMAILS, 'ops@example.com');
  // kept on a re-run; without a model here only the CLI's login and the agent's model go
  assert.equal(render(a, sub.env, {}).env.LLM_CLI_TOKEN, sub.env.LLM_CLI_TOKEN);
  a.components.llm = { mode: 'skip' };
  const off = render(a, sub.env, {}).env;
  for (const k of ['LLM_CLI_CLAUDE_TOKEN', 'AI_STACK_PLAN_MODEL', 'AI_PROJECT_SUMMARY_MODEL'])
    assert.equal(off[k], undefined, k);
  assert.equal(off.LLM_CLI_TOKEN, sub.env.LLM_CLI_TOKEN);
  assert.ok(off.COMPOSE_PROFILES.split(',').includes('llm-cli'));
  assert.equal(off.AI_CONTOUR, 'eu'); // the console's model needs a contour
  assert.deepEqual(validateAnswers({ ...a, operators: 'not-an-email' }), [
    'operators: e-mail addresses, comma-separated',
  ]);
});

test("bootstrap keeps every SSH port open: the client's, sshd -T, ListenAddress, ssh.socket", () => {
  const ports = (vars) => {
    const script = readFileSync(new URL('../deploy/setup/bootstrap.sh', import.meta.url), 'utf8');
    const head = Object.entries({ STEP: 'ports', ...vars })
      .map(([k, v]) => `${k}='${v}'`)
      .join('\n');
    return spawnSync('sh', ['-s'], { input: `${head}\n${script}`, encoding: 'utf8' }).stdout.trim();
  };
  const dump = 'port 22\nlistenaddress [::]:2200\nlistenaddress 0.0.0.0:22\npermitrootlogin no';
  const sock = 'Listen=[::]:2022 (Stream)';
  assert.equal(
    ports({ CLIENT_SSH_PORT: '2222', SSHD_DUMP: dump, SOCKET_LISTEN: sock }),
    '22 2022 2200 2222',
  );
  assert.equal(ports({ CLIENT_SSH_PORT: '2222', SSHD_DUMP: '', SOCKET_LISTEN: '' }), '2222');
  assert.equal(ports({ CLIENT_SSH_PORT: '', SSHD_DUMP: '', SOCKET_LISTEN: '' }), ''); // ufw stays off
});

test('a missing env file never mints new live secrets', () => {
  const at = { envExists: false, envFile: 'deploy/env/production.enc.env' };
  assert.equal(freshEnvError({ ...at, savedAnswers: false, serverHasEnv: false }), undefined); // first run
  assert.match(
    freshEnvError({ ...at, savedAnswers: true, serverHasEnv: false }),
    /answers exist.*Restore/s,
  );
  assert.match(
    freshEnvError({ ...at, savedAnswers: false, serverHasEnv: true }),
    /server already runs/,
  );
  assert.equal(
    freshEnvError({ ...at, envExists: true, savedAnswers: true, serverHasEnv: true }),
    undefined,
  );
});

test('--rotate only what the server re-applies', () => {
  assert.deepEqual(rotateErrors(['BETTER_AUTH_SECRET', 'DATABASE_URL', 'VAULT_DB_PASSWORD']), []);
  const errors = rotateErrors([
    'POSTGRES_PASSWORD',
    'UMAMI_ADMIN_PASSWORD',
    'WEBHOOK_ENCRYPTION_KEYS',
  ]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /--rotate POSTGRES_PASSWORD: nothing re-applies it/);
});

test('an absent flag has no value: verify without --org bills no organization', () => {
  assert.equal(option(['demo', 'verify'], '--org'), undefined);
  assert.equal(option(['verify', '--org', 'org_1'], '--org'), 'org_1');
});

test('the subcommand counts wherever it stands: a misplaced plan stays a dry run', () => {
  const none = { only: undefined, planId: undefined };
  assert.deepEqual(command(['staging', 'plan']), { cmd: 'plan', ...none, words: ['staging'] });
  assert.deepEqual(command(['plan', 'staging']), { cmd: 'plan', ...none, words: ['staging'] });
  assert.deepEqual(command(['staging', 'add', 'vault']), {
    cmd: 'add',
    only: 'vault',
    planId: undefined,
    words: ['staging'],
  });
  assert.deepEqual(command(['add', 'vault']), {
    cmd: 'add',
    only: 'vault',
    planId: undefined,
    words: [],
  });
  assert.deepEqual(command(['apply', 'p1', 'staging']), {
    cmd: 'apply',
    only: undefined,
    planId: 'p1',
    words: ['staging'],
  });
  assert.deepEqual(command(['staging']), { cmd: 'setup', ...none, words: ['staging'] });
});

test('a plan from the Stack page runs only approved, for the same stack, catalog actions', () => {
  const modes = 'core:install,crm:skip';
  const plan = (o) => ({
    status: 'approved',
    stackVersion: modes,
    actions: [{ component: 'crm', mode: 'install' }],
    ...o,
  });
  assert.deepEqual(checkPlan(plan(), modes), { crm: 'install' });
  assert.match(checkPlan(plan({ status: 'ready' }), modes), /approve it on the Stack page/);
  assert.match(checkPlan(plan({ status: 'applied' }), modes), /ran already/);
  assert.match(checkPlan(plan(), 'core:install,crm:connect'), /stack changed/);
  // An apply that failed after writing the env: the same plan resumes.
  assert.deepEqual(checkPlan(plan(), 'crm:install,core:install'), { crm: 'install' });
  for (const action of [
    { component: 'core', mode: 'skip' },
    { component: 'postgres', mode: 'connect' }, // the base changes only through infra itself
    { component: 'langfuse', mode: 'install' }, // not available yet
    { component: 'smtp', mode: 'skip' }, // not one of its modes
    { component: 'nope', mode: 'install' },
  ]) {
    assert.match(checkPlan(plan({ actions: [action] }), modes), /outside the catalog/);
  }
  assert.match(checkPlan(plan({ actions: [] }), modes), /no actions/);
});

test("values from the Stack page's connect card: secrets stay out of the answers", () => {
  const a = answers();
  a.components.crm = { mode: 'connect', TWENTY_API_URL: 'https://old.example.com' };
  const secrets = {};
  const entered = {
    crm: { TWENTY_API_URL: 'https://crm.example.com', TWENTY_API_KEY: 'local-dev-key' },
    analytics: { POSTHOG_KEY: 'phc_x' }, // not connected by this plan: ignored
  };
  takeEntered(a, secrets, entered);
  assert.equal(a.components.crm.TWENTY_API_URL, 'https://crm.example.com');
  assert.equal(a.components.crm.TWENTY_API_KEY, undefined);
  assert.deepEqual(secrets, { TWENTY_API_KEY: 'local-dev-key' });
  assert.deepEqual(validateAnswers(a), []);
  const passed = { TWENTY_API_KEY: 'from-env' }; // INFRA_TWENTY_API_KEY wins
  takeEntered(a, passed, entered);
  assert.equal(passed.TWENTY_API_KEY, 'from-env');
});

test('the receipt lists what is installed with addresses, then connected and skipped', () => {
  const a = answers();
  const env = render(a, {}, {}).env;
  const text = summary(a, env, 'v1.0.0');
  assert.match(
    text,
    /^Installed on the server:\n {2}core .*: https:\/\/app\.example\.com \(v1\.0\.0\)/,
  );
  assert.match(text, /\n {2}s3 .*: https:\/\/s3\.app\.example\.com/);
  for (const c of catalog.filter((c) => c.available !== false))
    assert.ok(text.includes(`  ${c.id} `), c.id);
  // What setup left out is listed with the command that adds it later.
  assert.match(text, /\nNot added yet \(pnpm run infra -- add <component>\):\n(.*\n)* {2}vault /);
});

test('a re-run with nothing changed renders the same env, key order included', () => {
  const first = render(answers(), {}, { secrets }).env;
  const again = render(answers(), first, { secrets }).env;
  assert.deepEqual(Object.entries(again), Object.entries(first));
});

test('a hand-set APP_NAME stays until the answers name the product', () => {
  const a = answers();
  assert.equal(render(a, { APP_NAME: 'Acme' }).env.APP_NAME, 'Acme');
  a.product = { name: 'Orbit' };
  assert.equal(render(a, { APP_NAME: 'Acme' }).env.APP_NAME, 'Orbit');
});

test('a setting made by hand for a component (its keys) survives a re-run while it is on', () => {
  const a = answers();
  a.components.vault = { mode: 'install' };
  const kept = render(a, {
    VAULT_ADMIN_TOKEN: 'argon2-hash',
    VAULT_ADMIN_IPS: '192.0.2.10/32',
  }).env;
  assert.equal(kept.VAULT_ADMIN_TOKEN, 'argon2-hash');
  assert.equal(kept.VAULT_ADMIN_IPS, '192.0.2.10/32');
  a.components.vault = { mode: 'skip' };
  assert.equal(render(a, { VAULT_ADMIN_TOKEN: 'argon2-hash' }).env.VAULT_ADMIN_TOKEN, undefined);
});

test('the default images are the ones release.yml publishes (ghcr.io/<this repository>)', () => {
  // The repo was renamed saas-agent-starter -> orgfold after v0.2.0: release.yml pushes to
  // ghcr.io/${GITHUB_REPOSITORY}, so a stale default silently installed the old release.
  const repo = 'ghcr.io/mihailorama/orgfold';
  for (const f of ['scripts/infra.mjs', 'scripts/deploy.mjs']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, new RegExp(`UPSTREAM(_REPO)? = '${repo}'`), f);
  }
});

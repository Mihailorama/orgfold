#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// One-command infrastructure setup (docs/setup.md, ADR 0032). Components: config/components.json.
//   pnpm run infra [-- <env>]                    questions, then bootstrap, deploy, verify
//   pnpm run infra -- plan [<env>]               (or --dry-run) what would change; changes nothing
//   pnpm run infra -- add <component> [<env>]    ask about one component, then apply
//   pnpm run infra -- verify [<env>] [--org <id>]  health probe + each component's check
// Options: --answers <file> (default deploy/setup/<env>.answers.json; <env> default production),
// --yes (no questions: connect secrets from INFRA_<KEY> variables, or KEY=value lines on stdin
// with --secrets-stdin), --rotate <KEY> (repeatable: regenerate a generated secret).
// The answers file holds choices, hosts and URLs, never a secret. Secrets go only into
// deploy/env/<env>.enc.env (DEPLOY_ENV_FILE), piped into sops on stdin. Nothing prints a value:
// plans show key names. SSH: your ssh config and agent (DEPLOY_SSH_CONFIG: another config file).
import { latestRelease } from './registry.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
export const catalog = JSON.parse(read('config/components.json')).components;
const byId = Object.fromEntries(catalog.map((c) => [c.id, c]));
const models = JSON.parse(read('config/ai-models.json'));
const UPSTREAM = 'ghcr.io/mihailorama/orgfold'; // until a fork has its own release (the repo was saas-agent-starter up to v0.2.0)
const SOPS_PLACEHOLDER = 'age1replace-with-your-public-key';
const LABEL = {
  install: 'install on the server',
  connect: 'connect an existing one',
  skip: 'skip',
};

const die = (msg) => {
  console.error(`infra: ${msg}`);
  process.exit(1);
};
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

export function parseDotenv(text) {
  return Object.fromEntries(
    text.split('\n').flatMap((l) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
      return m ? [[m[1], m[2]]] : [];
    }),
  );
}
const toDotenv = (env) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');

/**
 * Subscriptions a model can run on (llm-cli, docs/llm-providers.md): the secret that holds the
 * login and the file llm-cli reads it from (infra/llm-cli/config.json). Logins happen on this
 * machine, like any agent's setup: `claude setup-token`, `codex login --device-auth`.
 */
const LOGINS = {
  claude: {
    key: 'LLM_CLI_CLAUDE_TOKEN',
    file: 'claude-1.token',
    prompt: 'Paste the token claude setup-token printed',
  },
  codex: { key: 'LLM_CLI_CODEX_AUTH', file: 'codex-1.auth.json' },
};
const PROVIDER_LABEL = {
  claude_cli: 'Claude subscription (Pro or Max)',
  codex_cli: 'ChatGPT subscription (Codex)',
  anthropic: 'Anthropic API key',
  openai: 'OpenAI API key',
  gemini: 'Google Gemini API key',
  openrouter: 'OpenRouter API key (many vendors)',
};
/** Files the llm-cli image is built from, on the server: it holds vendor CLIs, never published. */
const LLM_CLI_FILES = [
  'services/llm-cli/Dockerfile',
  ...readdirSync(join(ROOT, 'services/llm-cli/src')).map((f) => `services/llm-cli/src/${f}`),
  'infra/llm-cli/config.json',
];
const llmCliTag = (project) =>
  `${project}-llm-cli:${createHash('sha256')
    .update(LLM_CLI_FILES.map(read).join('\0'))
    .digest('hex')
    .slice(0, 12)}`;

export const modeOf = (a, c) =>
  c.modes.length === 1 ? c.modes[0] : (a.components?.[c.id]?.mode ?? 'skip');

/** Allowed values of the LLM fields, from config/ai-models.json (API providers only). */
function choices(key, ca) {
  if (key === 'AI_CONTOUR') return Object.keys(models.contours);
  const rows = (models.contours[ca.AI_CONTOUR] ?? []).filter((r) => {
    const p = models.providers[r.provider];
    return r.purposes.includes('project.summary') && p && (p.kind !== 'cli' || p.cli in LOGINS);
  });
  if (key === 'AI_PROJECT_SUMMARY_PROVIDER') return [...new Set(rows.map((r) => r.provider))];
  if (key === 'AI_PROJECT_SUMMARY_MODEL')
    return rows.filter((r) => r.provider === ca.AI_PROJECT_SUMMARY_PROVIDER).map((r) => r.model);
}

/** A connect field; `@apiKey` becomes the chosen provider's <ID>_API_KEY (and <ID>_BASE_URL),
 * the naming config/ai-models.json follows (scripts/infra.test.mjs checks it), or for a
 * subscription its login (LOGINS). */
export function expandField(f, ca) {
  if (f.key !== '@apiKey') return [f];
  const id = String(ca.AI_PROJECT_SUMMARY_PROVIDER ?? '');
  const p = models.providers[id] ?? {};
  if (p.kind === 'cli') {
    const l = LOGINS[p.cli];
    return l
      ? [{ key: l.key, prompt: l.prompt ?? `${p.cli} login`, secret: true, login: p.cli }]
      : [];
  }
  const env = id.toUpperCase();
  return [
    ...(p.baseUrlEnv
      ? [{ key: `${env}_BASE_URL`, prompt: 'Base URL of the endpoint', validate: '^https?://' }]
      : []),
    ...('apiKeyEnv' in p ? [{ ...f, key: `${env}_API_KEY` }] : []),
  ];
}
const fields = (c, ca) => (c.connect ?? []).flatMap((f) => expandField(f, ca ?? {}));

export function validateAnswers(a) {
  const errors = [];
  const need = (ok, msg) => ok || errors.push(msg);
  const name = /^[a-z_][a-z0-9_-]*$/;
  need(/^[a-z0-9][a-z0-9-]*$/.test(a.env ?? ''), 'env: lowercase letters, digits and dashes');
  need(/^[\w.-]+$/.test(a.server?.host ?? ''), 'server.host: an IP, host name or ssh alias');
  need(name.test(a.server?.admin ?? ''), 'server.admin: root, or a user with passwordless sudo');
  need(name.test(a.server?.user ?? ''), 'server.user: name of the deploy user');
  need(name.test(a.project ?? ''), 'project: compose project name');
  need(/^([a-z0-9-]+\.)*[a-z0-9-]+$/i.test(a.domain ?? ''), 'domain: e.g. app.example.com');
  need(a.tls === 'internal' || /^[^@\s]+@[^@\s]+$/.test(a.tls ?? ''), 'tls: e-mail or internal');
  need(/^[a-z0-9][\w.:/-]*$/.test(a.images?.repo ?? ''), 'images.repo: registry/owner/name');
  need(
    a.operators === undefined || /^[^@\s,]+@[^@\s,]+(,[^@\s,]+@[^@\s,]+)*$/.test(a.operators),
    'operators: e-mail addresses, comma-separated',
  );
  need(/^\w[\w.-]*$/.test(a.images?.version ?? ''), 'images.version: a release tag, e.g. v1.0.0');
  for (const c of catalog) {
    const ca = a.components?.[c.id];
    if (!ca) {
      // Required: a core choice (install or connect), or a connect-only component (mail).
      const required =
        (c.tier === 'core' && c.modes.length > 1) ||
        (c.modes.length === 1 && c.modes[0] === 'connect');
      need(!required, `components.${c.id}: ${c.modes.join('|')}`);
      continue;
    }
    const at = `components.${c.id}`;
    if (!c.modes.includes(ca.mode)) {
      errors.push(
        c.modes.length === 1 && c.modes[0] === 'connect'
          ? `${at}: now required, it cannot be ${ca.mode}: run pnpm run infra -- add ${c.id}`
          : `${at}.mode: one of ${c.modes.join(', ')}`,
      );
      continue;
    }
    need(ca.mode === 'skip' || c.available !== false, `${at}: not available yet (docs/TODO.md)`);
    for (const r of c.requires?.[ca.mode] ?? []) {
      const [id, mode] = r.split(':');
      need(modeOf(a, byId[id]) === mode, `${at}: ${ca.mode} needs ${id} ${mode}`);
    }
    for (const f of fields(c, ca)) {
      const v = ca[f.key];
      if (f.secret) {
        need(v === undefined, `${at}.${f.key}: a secret, never in answers (use INFRA_${f.key})`);
      } else if (ca.mode === 'connect') {
        need(v !== undefined || f.default !== undefined, `${at}.${f.key}: missing (${f.prompt})`);
        if (v === undefined) continue;
        const allowed = choices(f.key, ca);
        need(!allowed || allowed.includes(v), `${at}.${f.key}: one of ${allowed?.join(', ')}`);
        need(!f.validate || new RegExp(f.validate).test(v), `${at}.${f.key}: ${f.prompt}`);
      }
    }
  }
  for (const id of Object.keys(a.components ?? {}))
    need(byId[id], `components.${id}: unknown (config/components.json)`);
  return errors;
}

/** The env file for the answers. Generated secrets are kept from `current` unless rotated. */
export function render(a, current = {}, { rotate = [], secrets = {}, previous } = {}) {
  const vars = {
    ...a.server,
    domain: a.domain,
    project: a.project,
    repo: a.images.repo,
    tls: a.tls,
  };
  const env = {};
  const generated = [];
  const missing = [];
  const invalid = [];
  const expand = (t) =>
    t.replace(/\{(?:hex:(\d+)|(\w+))\}/g, (_, n, k) =>
      n ? randomBytes(Number(n)).toString('hex') : (vars[k] ?? env[k] ?? ''),
    );
  const owned = new Set();
  const profiles = [];
  for (const c of catalog) {
    const mode = modeOf(a, c);
    for (const k of [...Object.keys(c.install?.env ?? {}), ...(c.keys ?? [])]) owned.add(k);
    const ca = a.components?.[c.id] ?? {};
    for (const f of fields(c, ca)) owned.add(f.key);
    if (mode === 'install' && c.install) {
      if (c.install.profile) profiles.push(c.install.profile);
      // A value generated while this component was installed survives re-runs.
      const keep = !previous || modeOf(previous, c) === 'install';
      for (const [k, t] of Object.entries(c.install.env ?? {})) {
        if (!t.includes('{hex:')) env[k] = expand(t);
        else {
          generated.push(k);
          env[k] = keep && current[k] && !rotate.includes(k) ? current[k] : expand(t);
        }
      }
    }
    // Settings of the component set by hand (`keys`, e.g. VAULT_ADMIN_TOKEN) stay while it is on.
    if (mode !== 'skip') for (const k of c.keys ?? []) if (k in current) env[k] = current[k];
    if (mode !== 'connect') continue;
    for (const f of fields(c, ca)) {
      if (f.answerOnly) continue;
      const v = f.secret
        ? (secrets[f.key] ?? current[f.key])
        : (ca[f.key] ?? (f.default === undefined ? undefined : expand(f.default)));
      if (v === undefined) missing.push(f.key);
      else if (f.validate && !new RegExp(f.validate).test(v)) invalid.push(f.key);
      else env[f.key] = v;
    }
  }
  // A model set here (`add llm`, --yes) also runs the stack console's agent, when the registry
  // allows it there. Usually the operator connects it in the console instead (docs/admin.md).
  owned.add('AI_STACK_PLAN_PROVIDER').add('AI_STACK_PLAN_MODEL');
  for (const l of Object.values(LOGINS)) owned.add(l.key);
  const llm = a.components?.llm ?? {};
  if (modeOf(a, byId.llm) === 'connect') {
    const [provider, model] = [llm.AI_PROJECT_SUMMARY_PROVIDER, llm.AI_PROJECT_SUMMARY_MODEL];
    const row = (models.contours[llm.AI_CONTOUR] ?? []).find(
      (r) => r.provider === provider && r.model === model,
    );
    if (row?.purposes.includes('stack.plan')) {
      env.AI_STACK_PLAN_PROVIDER = provider;
      env.AI_STACK_PLAN_MODEL = model;
    }
  }
  // llm-cli always runs: the console's first step signs in to a Claude or ChatGPT subscription
  // there (its image holds vendor CLIs, so it is built on the server, never published).
  profiles.push('llm-cli');
  generated.push('LLM_CLI_TOKEN');
  const keepToken = current.LLM_CLI_TOKEN && !rotate.includes('LLM_CLI_TOKEN');
  env.LLM_CLI_TOKEN = keepToken ? current.LLM_CLI_TOKEN : randomBytes(32).toString('hex');
  env.IMAGE_LLM_CLI = llmCliTag(a.project);
  // The worker refuses every model without a contour; the console's choice needs one too.
  env.AI_CONTOUR ||= Object.keys(models.contours)[0];
  // The operator console's admins (docs/admin.md), asked at setup.
  if (a.operators) {
    owned.add('OPERATOR_EMAILS');
    env.OPERATOR_EMAILS = a.operators;
  }
  // Computed here, last: a value kept from `keys` must not move it (a re-run rewrites nothing).
  delete env.COMPOSE_PROFILES;
  env.COMPOSE_PROFILES = profiles.join(',');
  // How each component runs, for the console's stack page (routes/admin-stack.ts); no secrets.
  delete env.STACK_MODES;
  env.STACK_MODES = catalog
    .filter((c) => c.available !== false)
    .map((c) => `${c.id}:${modeOf(a, c)}`)
    .join(',');
  // The answers own APP_NAME only once they name the product; a hand-set one stays until then.
  if (a.product?.name) {
    owned.add('APP_NAME');
    env.APP_NAME = a.product.name;
  }
  // Keys no component owns (added by hand with `sops edit`) stay as they are.
  for (const [k, v] of Object.entries(current)) if (!owned.has(k)) env[k] = v;
  // compose interpolates `$` in .env, and one line holds one value
  for (const [k, v] of Object.entries(env)) if (/[$\n\r]/.test(v)) invalid.push(k);
  return { env, generated, missing, invalid };
}

/** --rotate only for keys something re-applies (install.rotate in config/components.json). */
export function rotateErrors(keys) {
  const ok = catalog.flatMap((c) => c.install?.rotate ?? []);
  return keys
    .filter((k) => !ok.includes(k))
    .map(
      (k) =>
        `--rotate ${k}: nothing re-applies it on the server (rotatable: ${ok.join(', ')}; docs/setup.md)`,
    );
}

/** A missing env file while state exists elsewhere must not mint new live secrets. */
export function freshEnvError({ envExists, savedAnswers, serverHasEnv, envFile }) {
  if (envExists || !(savedAnswers || serverHasEnv)) return undefined;
  const where = serverHasEnv ? 'the server already runs this environment' : 'its answers exist';
  return `${envFile} is missing but ${where}. A new one would replace the live secrets (database
  passwords, auth secret). Restore it from git or a backup (and the age key), or rebuild it from the
  vault item, then run again.`;
}

const ramOf = (a) =>
  catalog.reduce((sum, c) => sum + (modeOf(a, c) === 'install' ? (c.install?.ramMiB ?? 0) : 0), 0) +
  byId['llm-cli'].install.ramMiB; // always on: subscription sign-ins (render)

/** The plan: profiles and env KEY NAMES added (+), changed (~), removed (-), and RAM. */
export function plan({ a, current, next, generated, missing = [], serverMiB, release }) {
  const diff = (before, after) => [
    ...Object.keys(after).flatMap((k) =>
      !(k in before) ? [`+ ${k}`] : before[k] !== after[k] ? [`~ ${k}`] : [],
    ),
    ...Object.keys(before)
      .filter((k) => !(k in after))
      .map((k) => `- ${k}`),
  ];
  const list = (v) => (v ?? '').split(',').filter(Boolean);
  const [was, now] = [list(current.COMPOSE_PROFILES), list(next.COMPOSE_PROFILES)];
  const profiles = [
    ...now.filter((p) => !was.includes(p)).map((p) => `+ ${p}`),
    ...was.filter((p) => !now.includes(p)).map((p) => `- ${p}`),
  ];
  const keys = diff(current, next).map((l) =>
    generated.includes(l.slice(2)) && l[0] !== '-' ? `${l} (generated)` : l,
  );
  const gib = (m) => `${(m / 1024).toFixed(1)} GiB`;
  const ram = ramOf(a);
  const lines = [
    `Plan for ${a.env}: ${a.server.user}@${a.server.host}, https://${a.domain}, ${a.images.repo} ${release ?? a.images.version}${a.images.version === 'latest' ? ' (latest)' : ''}`,
    `  components: ${catalog
      .filter((c) => c.available !== false)
      .map((c) => `${c.id} ${modeOf(a, c)}`)
      .join(', ')}`,
    `  profiles: ${profiles.join(', ') || 'no change'}`,
    `  env keys: ${keys.filter((l) => !l.endsWith('COMPOSE_PROFILES')).join(', ') || 'no change'}`,
    ...(missing.length
      ? [`  missing secrets: ${missing.map((k) => `INFRA_${k}`).join(', ')}`]
      : []),
    `  RAM budget (mem_limit): ${gib(ram)}${serverMiB ? ` of ${gib(serverMiB)} on the server` : ', server RAM unknown'}`,
  ];
  // Limits are ceilings (idle use is about a third, docs/STACK.md), so this advises, never stops.
  if (serverMiB && ram > serverMiB * 0.9)
    lines.push(
      '  NOTE: the limits add up to more than 90 % of the server. It starts, but under load or with',
      '  more components later a bigger server is recommended: resize it at your provider (data stays),',
      '  or run heavy components on a second server and connect them.',
    );
  return lines.join('\n');
}

// --- side effects: sops, ssh, dns -------------------------------------------------------------

const sshArgs = () => (process.env.DEPLOY_SSH_CONFIG ? ['-F', process.env.DEPLOY_SSH_CONFIG] : []);
function ssh(dest, command, { input, capture = false, timeout = 10 } = {}) {
  const out = capture ? 'pipe' : 'inherit';
  return spawnSync(
    'ssh',
    [...sshArgs(), '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeout}`, dest, command],
    { input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', out, out] },
  );
}

function decrypt(file) {
  if (!existsSync(file)) return {};
  const r = spawnSync(
    'sops',
    ['decrypt', '--input-type', 'dotenv', '--output-type', 'dotenv', file],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  if (r.status !== 0) die(`cannot decrypt ${file} (age key: SOPS_AGE_KEY_FILE)`);
  return parseDotenv(r.stdout);
}

function encrypt(file, env) {
  const to = process.env.SOPS_AGE_RECIPIENTS; // else the creation rule in .sops.yaml
  const keys = ['--filename-override', file, ...(to ? ['--age', to] : [])];
  const args = [
    ...(to ? ['--config', '/dev/null'] : []), // global flag: before the subcommand
    'encrypt',
    ...keys,
    ...['--input-type', 'dotenv', '--output-type', 'dotenv'],
  ];
  const r = spawnSync('sops', args, {
    // no file: sops reads stdin
    input: toDotenv(env),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (r.status !== 0) die('sops encrypt failed');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, r.stdout);
}

function preflight(interactive) {
  for (const [tool, flag] of [
    ['ssh', '-V'],
    ['sops', '--version'],
    ['age-keygen', '--version'],
  ]) {
    if (spawnSync(tool, [flag], { stdio: 'ignore' }).error) {
      die(`${tool} not found: brew install ${tool === 'ssh' ? 'openssh' : tool.split('-')[0]}`);
    }
  }
  const fallback = join(homedir(), '.config/sops/age/keys.txt'); // sops' path on Linux, not macOS
  if (!process.env.SOPS_AGE_KEY_FILE && existsSync(fallback))
    process.env.SOPS_AGE_KEY_FILE = fallback;
  if (process.env.SOPS_AGE_RECIPIENTS || !read('.sops.yaml').includes(SOPS_PLACEHOLDER)) return;
  if (!interactive)
    die(
      '.sops.yaml has no age public key yet: run `pnpm run infra` once, or set SOPS_AGE_RECIPIENTS',
    );
  const keyFile = process.env.SOPS_AGE_KEY_FILE ?? fallback;
  if (!existsSync(keyFile)) {
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    execFileSync('age-keygen', ['-o', keyFile], { stdio: 'ignore' });
  }
  const pub = execFileSync('age-keygen', ['-y', keyFile], { encoding: 'utf8' }).trim();
  writeFileSync(join(ROOT, '.sops.yaml'), read('.sops.yaml').replace(SOPS_PLACEHOLDER, pub));
  process.env.SOPS_AGE_KEY_FILE = keyFile;
  console.log(`\n  Your age key: ${keyFile} (public ${pub}, now in .sops.yaml).
  BACK IT UP NOW (password manager or offline): without it nobody can decrypt deploy/env/,
  and every secret of this environment is lost. Add export SOPS_AGE_KEY_FILE=${keyFile}
  to your shell profile.\n`);
}

const sshG = (host) =>
  spawnSync('ssh', [...sshArgs(), '-G', host], { encoding: 'utf8' }).stdout ?? '';

/** Addresses of a host as ssh would reach it (aliases resolved by `ssh -G`). */
async function addresses(host) {
  const name = /^hostname (.+)$/m.exec(sshG(host))?.[1] ?? host;
  return (await lookup(name, { all: true }).catch(() => [])).map((x) => x.address);
}

async function checkDns(a, env) {
  const server = await addresses(a.server.host);
  const sites = catalog
    .filter((c) => modeOf(a, c) === 'install' && c.install?.site)
    .map((c) => new URL(env[c.install.site]).hostname);
  const wrong = [];
  for (const name of [a.domain, ...sites]) {
    const got = await addresses(name);
    if (!got.some((x) => server.includes(x)))
      wrong.push(`${name} -> ${got.join(' ') || 'nothing'}`);
  }
  if (!wrong.length) return;
  const msg = `DNS does not point at the server (${server.join(' ')}): ${wrong.join('; ')}`;
  if (a.tls === 'internal') console.warn(`  warning: ${msg}`);
  else die(`${msg}. Add A/AAAA records, wait for them to resolve, run again.`);
}

function bootstrap(a, env, interactive) {
  const admin = `${a.server.admin}@${a.server.host}`;
  const deploy = env.DEPLOY_HOST;
  const port = /^port (\d+)$/m.exec(sshG(a.server.host))?.[1] ?? '';
  const step = (name) => {
    const sh = a.server.admin === 'root' ? 'sh -s' : 'sudo -n sh -s';
    const vars = `STEP=${name}\nDEPLOY_USER=${q(a.server.user)}\nDEPLOY_PATH=${q(env.DEPLOY_PATH)}\nCLIENT_SSH_PORT=${q(port)}\n`;
    const r = ssh(admin, sh, { input: vars + read('deploy/setup/bootstrap.sh') });
    if (r.status !== 0) die(`bootstrap (${name}) failed on ${admin}; fix it and run again`);
  };
  const probe = ssh(admin, 'true', { capture: true });
  if (probe.status !== 0) {
    if (/Host key verification failed|IDENTIFICATION HAS CHANGED/.test(probe.stderr ?? '')) {
      die(`${a.server.host}: unknown or changed host key. Compare its fingerprint with the one your
  provider shows, then \`ssh ${admin}\` once and accept it. Host keys are never skipped.`);
    }
    if (!interactive) die(`no key login as ${admin}: run ssh-copy-id ${admin} once`);
    console.log(`No key login as ${admin} yet. ssh-copy-id installs your public key; OpenSSH asks
for the password itself (this tool never reads or stores it).`);
    if (spawnSync('ssh-copy-id', [...sshArgs(), admin], { stdio: 'inherit' }).status !== 0) {
      die('ssh-copy-id failed (no key yet? ssh-keygen -t ed25519)');
    }
  }
  console.log(`bootstrap ${admin}`);
  step('base');
  // Password login goes off only once the deploy user's key login works.
  if (ssh(deploy, 'docker info --format "  docker {{.ServerVersion}} as $(id -un)"').status !== 0) {
    die(`no key login as ${deploy} with Docker access; password login left on`);
  }
  step('harden'); // checks the effective sshd config itself (sshd -T)
}

function serverMiB(env) {
  const r = ssh(env.DEPLOY_HOST, "awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo", {
    capture: true,
    timeout: 5,
  });
  return r.status === 0 ? Number(r.stdout.trim()) : undefined;
}

/** Subscriptions: build the llm-cli image on the server (check-then-act) and put the logins
 * where it reads them, owned by its user, mode 600. Values travel on stdin only. */
function llmCli(env) {
  const tag = env.IMAGE_LLM_CLI;
  const on = (cmd, opts) => ssh(env.DEPLOY_HOST, `cd ${q(env.DEPLOY_PATH)} && ${cmd}`, opts);
  if (on(`docker image inspect ${q(tag)} >/dev/null 2>&1`, { capture: true }).status !== 0) {
    console.log(`  building ${tag} on the server (vendor CLIs from npm, never published)`);
    const tar = spawnSync('tar', ['-c', '-C', ROOT, ...LLM_CLI_FILES], { maxBuffer: 1 << 28 });
    if (tar.status !== 0) die('tar of services/llm-cli failed');
    const r = on(`docker build -q -t ${q(tag)} -f services/llm-cli/Dockerfile -`, {
      input: tar.stdout,
    });
    if (r.status !== 0) die('building llm-cli on the server failed; run again');
  }
  on('mkdir -p llm-cli-secrets');
  for (const l of Object.values(LOGINS)) {
    const value = env[l.key];
    const file = `/s/${l.file}`;
    const script = value ? `umask 077; cat > ${file}; chown node:node /s ${file}` : `rm -f ${file}`;
    const r = on(
      `docker run --rm -i --user 0 --entrypoint sh -v "$PWD/llm-cli-secrets:/s" ${q(tag)} -c ${q(script)}`,
      {
        input:
          l.key === 'LLM_CLI_CODEX_AUTH' && value ? Buffer.from(value, 'base64') : (value ?? ''),
        capture: true,
      },
    );
    if (r.status !== 0) die(`llm-cli: could not write ${l.file} on the server`);
  }
}

/** A subscription login on this machine, as each vendor's CLI does it (pinned like the image). */
function login(cli) {
  const version = (arg) =>
    new RegExp(`ARG ${arg}=(\\S+)`).exec(read('services/llm-cli/Dockerfile'))?.[1];
  const run = (bin, pkg, args, env) => {
    const local = spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;
    const [cmd, argv] = local ? [bin, args] : ['npx', ['-y', pkg, ...args]];
    return spawnSync(cmd, argv, { stdio: 'inherit', env: { ...process.env, ...env } }).status;
  };
  if (cli === 'claude') {
    console.log('Claude opens a sign-in page, then prints a token. Copy it, paste it below.');
    run('claude', `@anthropic-ai/claude-code@${version('CLAUDE_CODE_VERSION')}`, ['setup-token']);
    return undefined; // the token is pasted at the prompt that follows
  }
  // Codex: a device-code sign-in into a throwaway CODEX_HOME, so your own login is untouched.
  const home = mkdtempSync(join(tmpdir(), 'codex-login-'));
  try {
    const status = run(
      'codex',
      `@openai/codex@${version('CODEX_VERSION')}`,
      ['login', '--device-auth'],
      {
        CODEX_HOME: home,
      },
    );
    if (status !== 0 || !existsSync(join(home, 'auth.json'))) die('codex login did not finish');
    return readFileSync(join(home, 'auth.json')).toString('base64');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function verify(a, env, { org, mail }) {
  const at = (cmd) => ssh(env.DEPLOY_HOST, `cd ${q(env.DEPLOY_PATH)} && ${cmd}`, { capture: true });
  const port = env.HTTPS_PORT ?? '443';
  const ca = env.CADDY_TLS === 'internal' ? '--cacert .caddy-root.crt' : '';
  const checks = [
    [
      'health',
      `curl -fsS -o /dev/null --max-time 10 ${ca} --resolve ${q(`${a.domain}:${port}:127.0.0.1`)} https://${a.domain}:${port}/api/auth/ok`,
    ],
  ];
  for (const c of catalog) {
    const mode = modeOf(a, c);
    const cmd =
      typeof c.verify === 'string' ? (mode === 'skip' ? null : c.verify) : c.verify?.[mode];
    if (!cmd) continue;
    if (c.id === 'smtp' && !mail)
      console.log('  skipped smtp       no test mail (--mail sends one)');
    else checks.push([c.id, c.id === 'llm' && org ? `${cmd} ${q(org)}` : cmd]);
  }
  let failed = 0;
  for (const [id, cmd] of checks) {
    const r = at(cmd);
    const last = `${r.stdout}${r.stderr}`.trim().split('\n').at(-1)?.slice(0, 160) ?? '';
    const state = r.status === 0 ? 'ok' : r.status === 3 ? 'skipped' : 'FAILED';
    if (state === 'FAILED') failed++;
    console.log(
      `  ${state.padEnd(7)} ${id.padEnd(10)} ${state === 'ok' && id !== 'health' ? '' : last}`,
    );
  }
  if (failed) die(`${failed} check(s) failed`);
}

export const fingerprint = (v) => createHash('sha256').update(v).digest('hex').slice(0, 16);

/** Generated values not yet in the vault item app/<env>; a.vaultPushed keeps fingerprints only. */
function vaultPush(a, env, generated) {
  a.vaultPushed ??= {};
  const pending = generated.filter((k) => a.vaultPushed[k] !== fingerprint(env[k]));
  if (!pending.length) return;
  if (spawnSync('node', ['scripts/vault.mjs', 'status'], { stdio: 'ignore' }).status !== 0) {
    console.log(`  vault: not unlocked (node scripts/vault.mjs unlock); ${pending.length} values
  not saved there yet, the next run saves them`);
    return;
  }
  for (const k of pending) {
    const cmd = a.vaultPushed[k] ? 'replace' : 'put';
    const r = spawnSync('node', ['scripts/vault.mjs', cmd, `app/${a.env}`, k], {
      input: env[k],
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (r.status === 0) a.vaultPushed[k] = fingerprint(env[k]);
  }
}

async function ask(a, current, secrets, only, fixed) {
  const p = await import('@clack/prompts');
  const ok = (v) => {
    if (!p.isCancel(v)) return v;
    p.cancel('Nothing changed.');
    process.exit(1);
  };
  const check = (re) => (v) =>
    re && !new RegExp(re).test(v ?? '') ? 'does not look right' : undefined;
  const text = async (message, initialValue, re) =>
    ok(await p.text({ message, initialValue, validate: check(re) }));
  p.intro(`Infrastructure for ${a.env}`);
  // Setup asks only the base (product, server, domain, mail, where data lives); every other
  // component comes later through `add <component>` (the action the stack console calls).
  const askable = catalog.filter(
    (c) => c.available !== false && (c.modes.length > 1 || c.modes[0] === 'connect'),
  );
  const component = async (c) => {
    a.components[c.id] ??= {};
    const ca = a.components[c.id];
    const options = c.modes.map((m) => ({ value: m, label: c.labels?.[m] ?? LABEL[m] }));
    const initialValue = ca.mode ?? c.modes[0];
    const message = c.ask ? `${c.ask} (${c.description})` : `${c.id}: ${c.description}`;
    if (c.modes.length === 1 || fixed?.[c.id]) {
      p.log.step(message);
      ca.mode = fixed?.[c.id] ?? c.modes[0];
    } else ca.mode = ok(await p.select({ message, options, initialValue }));
    if (ca.mode !== 'connect') return;
    if (c.offers?.length) p.log.info(offersText(c.offers));
    for (const f of (c.connect ?? []).flatMap((f) => expandField(f, ca))) {
      if (!f.secret) {
        const list = choices(f.key, ca);
        const label = (value) => ({ value, label: PROVIDER_LABEL[value] ?? value });
        const initial = ca[f.key] ?? f.default?.replace(/\{(\w+)\}/g, (_, k) => ca[k] ?? '');
        ca[f.key] = list
          ? ok(
              await p.select({
                message: f.prompt,
                options: list.map(label),
                initialValue: list.includes(ca[f.key]) ? ca[f.key] : list[0],
              }),
            )
          : await text(f.prompt, initial, f.validate);
      } else if (
        secrets[f.key] === undefined &&
        (!current[f.key] || !ok(await p.confirm({ message: `Keep the current ${f.key}?` })))
      ) {
        secrets[f.key] =
          (f.login && login(f.login)) ??
          ok(await p.password({ message: f.prompt, validate: check(f.validate) }));
      }
    }
  };
  if (!only && !fixed) {
    a.product ??= {};
    a.product.name = await text(
      'What is the product called?',
      a.product.name ?? current.APP_NAME ?? 'Workspace',
      '^[^$\\n]+$',
    );
    a.product.description = await text(
      'Describe it in a sentence or two (landing page, search results)',
      a.product.description ?? '',
    );
    a.operators = await text(
      'Your e-mail: you sign in to the operator console with it (comma-separate more)',
      a.operators ?? current.OPERATOR_EMAILS ?? '',
      '^[^@\\s,]+@[^@\\s,]+(,[^@\\s,]+@[^@\\s,]+)*$',
    );
  }
  if (only) await component(byId[only]);
  else if (fixed) for (const id of Object.keys(fixed)) await component(byId[id]);
  else {
    a.server.host = await text('Server: IP, host name or ssh alias', a.server.host, '^[\\w.-]+$');
    a.server.admin = await text('Admin user (root, or passwordless sudo)', a.server.admin);
    a.domain = await text(
      'Address of the app (its DNS record points at the server), e.g. app.example.com',
      a.domain,
    );
    a.tls = await text('E-mail for Let\'s Encrypt ("internal": own CA)', a.tls, '@|^internal$');
    for (const c of askable.filter((c) => c.group === 'base')) await component(c);
  }
  return () => p.confirm({ message: 'Apply this plan?' }).then((v) => v === true);
}

/**
 * The subcommand wherever it stands: `plan staging` and `staging plan` are the same dry run (a
 * misplaced `plan` must never become a setup that applies). `add` takes the next word (the
 * component), `apply` too (the plan id from the Stack page).
 */
export function command(words) {
  const rest = [...words];
  const i = rest.findIndex((w) => ['plan', 'add', 'verify', 'apply'].includes(w));
  const cmd = i < 0 ? 'setup' : rest.splice(i, 1)[0];
  const only = cmd === 'add' ? rest.splice(i, 1)[0] : undefined;
  const planId = cmd === 'apply' ? rest.splice(i, 1)[0] : undefined;
  return { cmd, only, planId, words: rest };
}

/** The value after a flag, or undefined when the flag is absent (never another argument). */
export const option = (argv, name) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;

const modesOf = (s) => Object.fromEntries((s ?? '').split(',').map((p) => p.split(':')));
const sameModes = (x, y) =>
  Object.keys({ ...x, ...y }).every((id) => (x[id] ?? 'skip') === (y[id] ?? 'skip'));

/**
 * A plan from the Stack page (docs/admin.md "Plan a change") as component -> mode, or an error:
 * it must be approved, made for the stack as it is now (STACK_MODES; or as the plan leaves it,
 * when an earlier apply of it failed after writing the env), and only catalog actions outside
 * the base (the database, S3 and mail change only through `pnpm run infra`).
 */
export function checkPlan(plan, stackModes) {
  if (plan.status !== 'approved') {
    return `the plan is ${plan.status}: ${plan.status === 'applied' ? 'it ran already' : 'approve it on the Stack page first'}`;
  }
  const made = modesOf(plan.stackVersion);
  const after = { ...made };
  for (const { component, mode } of plan.actions ?? []) after[component] = mode;
  const now = modesOf(stackModes);
  if (!plan.stackVersion || !(sameModes(made, now) || sameModes(after, now))) {
    return 'the stack changed since this plan was made: ask again on the Stack page';
  }
  const fixed = {};
  for (const { component, mode } of plan.actions ?? []) {
    const c = byId[component];
    if (!c || c.tier === 'core' || c.available === false || !c.modes.includes(mode)) {
      return `the plan has an action outside the catalog: ${component} ${mode}`;
    }
    fixed[component] = mode;
  }
  return Object.keys(fixed).length ? fixed : 'the plan has no actions';
}

/** "No account yet?" for the wizard: services with a free or cheap tier (components.json `offers`). */
export const offersText = (offers) =>
  [
    'No account yet? These start free or cheap:',
    ...offers.map((o) => `  ${o.name}: ${o.free} (${o.url}, checked ${o.checked})`),
  ].join('\n');

/**
 * Values entered in the Stack page's connect cards: secrets join the run's secrets (never the
 * answers file), plain values replace saved answers. INFRA_<KEY> and --secrets-stdin still win.
 */
export function takeEntered(a, secrets, entered) {
  for (const [id, values] of Object.entries(entered ?? {})) {
    const c = byId[id];
    if (!c || a.components[id]?.mode !== 'connect') continue;
    for (const f of fields(c, a.components[id])) {
      const v = values[f.key];
      if (v === undefined) continue;
      if (f.secret) secrets[f.key] ??= v;
      else a.components[id][f.key] = v;
    }
  }
}

/** Reads a plan from the server's database through the API container (SSH is the authorization). */
function stackPlan(env, id, verb) {
  const r = ssh(
    env.DEPLOY_HOST,
    `cd ${q(env.DEPLOY_PATH)} && docker compose exec -T api node apps/api/src/stack-plan.ts ${verb} ${q(id)}`,
    { capture: true },
  );
  if (r.status !== 0) die(`plan ${id}: ${(r.stderr || r.stdout).trim() || 'could not read it'}`);
  return JSON.parse(r.stdout);
}

async function main() {
  process.chdir(ROOT);
  const argv = process.argv.slice(2).filter((x) => x !== '--');
  const VALUED = ['--answers', '--rotate', '--org'];
  const opt = (n) => option(argv, n);
  const rotate = argv.flatMap((x, i) => (x === '--rotate' ? [argv[i + 1]] : []));
  const { cmd, only, planId, words } = command(
    argv.filter((x, i) => !x.startsWith('--') && !VALUED.includes(argv[i - 1])),
  );
  const dry = cmd === 'plan' || argv.includes('--dry-run');
  const interactive = !argv.includes('--yes') && cmd !== 'verify' && !dry;
  const envName = words[0] ?? 'production';
  const file = argv.includes('--answers')
    ? opt('--answers')
    : `deploy/setup/${envName}.answers.json`;
  if (cmd === 'apply' && !/^[0-9a-f-]{36}$/.test(planId ?? '')) {
    die('usage: pnpm run infra -- apply <plan id from the Stack page> [environment]');
  }
  if (only && !byId[only]) die(`unknown component ${only} (config/components.json)`);
  if (only && byId[only].available === false) die(`${only} cannot be added yet (docs/TODO.md)`);

  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  if (!saved && (!interactive || only || planId))
    die(`${file} not found: run pnpm run infra first`);
  const a = structuredClone(saved) ?? {
    env: envName,
    project: 'app',
    server: { host: '', admin: 'root', user: 'deploy' },
    domain: '',
    tls: '',
    // Always the newest release, looked up at each run; a fixed tag only by editing the answers.
    images: { repo: UPSTREAM, version: 'latest' },
    components: {},
  };
  // An answers file may leave the images out: the newest upstream release (docs/setup.md).
  a.images = { repo: UPSTREAM, version: 'latest', ...a.images };
  const envFile = process.env.DEPLOY_ENV_FILE ?? `deploy/env/${a.env}.enc.env`;
  preflight(interactive);
  if (!existsSync(envFile)) {
    const remote = saved && `${saved.server.user}@${saved.server.host}`;
    const env = `/opt/${saved?.project}/.env`;
    const serverHasEnv =
      Boolean(remote) &&
      ssh(remote, `test -f ${q(env)}`, { capture: true, timeout: 5 }).status === 0;
    const savedAnswers = Boolean(saved) && !argv.includes('--answers');
    const err = freshEnvError({ envExists: false, savedAnswers, serverHasEnv, envFile });
    if (err) die(err);
  }
  const current = decrypt(envFile);
  if (cmd === 'verify')
    return verify(a, current, { org: opt('--org'), mail: argv.includes('--mail') });

  const secrets = argv.includes('--secrets-stdin') ? parseDotenv(readFileSync(0, 'utf8')) : {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('INFRA_')) continue;
    secrets[k.slice(6)] = v;
    delete process.env[k]; // no child process (ssh, sops, deploy) needs them
  }
  let fixed;
  if (planId) {
    const got = stackPlan(current, planId, 'get');
    fixed = checkPlan(got, current.STACK_MODES);
    if (typeof fixed === 'string') die(`plan ${planId}: ${fixed}`);
    for (const [id, mode] of Object.entries(fixed)) {
      a.components[id] ??= {};
      a.components[id].mode = mode;
    }
    takeEntered(a, secrets, got.connect);
  }
  const confirm = interactive ? await ask(a, current, secrets, only, fixed) : undefined;
  const errors = validateAnswers(a);
  if (errors.length) die(`${file}:\n  ${errors.join('\n  ')}`);
  const out = render(a, current, { rotate, secrets, previous: saved });
  const rotateErr = rotateErrors(rotate);
  if (rotateErr.length) die(rotateErr.join('\n'));
  if (out.invalid.length) die(`invalid value (format, or contains $): ${out.invalid.join(', ')}`);
  await checkDns(a, out.env);
  const release =
    a.images.version === 'latest'
      ? await latestRelease(a.images.repo).catch((err) => die(err.message))
      : a.images.version;
  console.log(plan({ a, current, next: out.env, ...out, serverMiB: serverMiB(out.env), release }));
  if (dry) return;
  if (out.missing.length)
    die(`missing secrets: ${out.missing.map((k) => `INFRA_${k}`).join(', ')}`);
  if (confirm && !(await confirm())) process.exit(1);

  if (interactive || planId) writeFileSync(file, `${JSON.stringify(a, null, 2)}\n`);
  if (toDotenv(current) !== toDotenv(out.env)) encrypt(envFile, out.env);
  bootstrap(a, out.env, interactive);
  if (out.env.COMPOSE_PROFILES.split(',').includes('llm-cli')) llmCli(out.env);
  const backups = (out.env.COMPOSE_FILE ?? '').includes('compose.backup.yaml');
  if (!backups) console.warn('  warning: no backups configured (docs/backups.md): --skip-backup');
  const deploy = spawnSync(
    'node',
    ['scripts/deploy.mjs', a.env, '--version', release, ...(backups ? [] : ['--skip-backup'])],
    { stdio: 'inherit', env: { ...process.env, DEPLOY_ENV_FILE: envFile } },
  );
  if (deploy.status !== 0) die('deploy failed: fix the cause and run the same command again');
  for (const c of catalog.filter((c) => modeOf(a, c) === 'install' && c.install?.after)) {
    const r = ssh(out.env.DEPLOY_HOST, `cd ${q(out.env.DEPLOY_PATH)} && sh -s`, {
      input: read(c.install.after),
    });
    if (r.status !== 0) die(`${c.id}: ${c.install.after} failed`);
  }
  if (interactive && modeOf(a, byId.vault) !== 'skip') {
    vaultPush(a, out.env, out.generated);
    writeFileSync(file, `${JSON.stringify(a, null, 2)}\n`);
  }
  if (planId) stackPlan(out.env, planId, 'applied');
  console.log('verify');
  const mailChanged = ['SMTP_URL', 'MAIL_FROM'].some((k) => current[k] !== out.env[k]);
  verify(a, out.env, { org: opt('--org'), mail: mailChanged || argv.includes('--mail') });
  console.log(`\n${summary(a, out.env, release)}`);
  console.log(`\nDone: https://${a.domain}. Commit ${file} and ${envFile} (values are encrypted).`);
}

/** What the run left on the server, connected and skipped, with addresses: the run's receipt. */
export function summary(a, env, release) {
  const by = { install: [], connect: [], skip: [] };
  for (const c of catalog.filter((c) => c.available !== false)) {
    const where = c.id === 'core' ? `https://${a.domain} (${release})` : env[c.install?.site];
    by[modeOf(a, c)]?.push(`  ${c.id.padEnd(10)} ${c.description}${where ? `: ${where}` : ''}`);
  }
  return [
    'Installed on the server:',
    ...by.install,
    ...(by.connect.length ? ['Connected:', ...by.connect] : []),
    ...(by.skip.length ? ['Not added yet (pnpm run infra -- add <component>):', ...by.skip] : []),
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

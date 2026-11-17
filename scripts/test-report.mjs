#!/usr/bin/env node
// Sends one test run's JUnit XML to the test report servers (docs/test-reports.md):
//   node scripts/test-report.mjs [dir]      (dir: TEST_RESULTS_DIR or ./test-results)
// Allure (profile allure):        ALLURE_URL, ALLURE_CI_PASSWORD, ALLURE_PROJECT (default "default")
// ReportPortal (any, or profile): REPORTPORTAL_URL, REPORTPORTAL_API_KEY, REPORTPORTAL_PROJECT
// Each server is used only when its variables are set; with none set it does nothing. The runners
// write the XML when TEST_RESULTS_DIR is set (vitest configs, playwright.config.ts, PYTEST_ADDOPTS).
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Many JUnit files -> one <testsuites> document, so one run is one launch/report. `docs` are
// [fileName, xml] pairs; cases outside any <testsuite> (node --test writes them so) get one named
// after the file, since ReportPortal's import rejects a bare case.
export function mergeJunit(docs) {
  const suites = docs.map(([file, xml]) => {
    const body = xml
      .replace(/<\?xml[^>]*\?>/, '')
      .replace(/<\/?testsuites\b[^>]*>/g, '')
      .trim();
    return body.startsWith('<testsuite')
      ? body
      : `<testsuite name="${file}">\n${body}\n</testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join('\n')}\n</testsuites>\n`;
}

// A run's name in both tools: the CI's run, else the local time.
export function runName(env) {
  if (env.GITHUB_RUN_NUMBER)
    return `${env.GITHUB_WORKFLOW ?? 'CI'} #${env.GITHUB_RUN_NUMBER} ${env.GITHUB_REF_NAME ?? ''}`.trim();
  if (env.CI_PIPELINE_IID)
    return `Pipeline #${env.CI_PIPELINE_IID} ${env.CI_COMMIT_REF_NAME ?? ''}`.trim();
  return `local ${new Date().toISOString()}`;
}

async function ok(res, what) {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function allure(env, xml, name) {
  const base = `${env.ALLURE_URL.replace(/\/$/, '')}/allure-docker-service`;
  const project = env.ALLURE_PROJECT || 'default';
  const login = await ok(
    await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ci', password: env.ALLURE_CI_PASSWORD }),
    }),
    'allure login',
  );
  const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrf = cookies.find((c) => c.startsWith('csrf_access_token='))?.split('=')[1] ?? '';
  const headers = { cookie: cookies.join('; '), 'X-CSRF-TOKEN': csrf };
  const q = `project_id=${encodeURIComponent(project)}`;
  // Results of the previous run would merge into this report; history stays.
  await fetch(`${base}/clean-results?${q}`, { headers });
  await ok(
    await fetch(`${base}/send-results?${q}&force_project_creation=true`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        results: [{ file_name: 'junit.xml', content_base64: Buffer.from(xml).toString('base64') }],
      }),
    }),
    'allure send-results',
  );
  const from = env.GITHUB_RUN_ID
    ? `&execution_from=${encodeURIComponent(`${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`)}`
    : '';
  const gen = await ok(
    await fetch(`${base}/generate-report?${q}&execution_name=${encodeURIComponent(name)}${from}`, {
      headers,
    }),
    'allure generate-report',
  );
  // The server does not know it sits behind HTTPS: keep its path, use the address we were given.
  const url = (await gen.json()).data?.report_url ?? '';
  return url.replace(/^https?:\/\/[^/]+\/allure-docker-service/, base);
}

// The import is ReportPortal's JUnit plugin (1.1.2 on our install: deploy/setup/reportportal-setup.sh).
async function reportportal(env, xml, name) {
  const base = env.REPORTPORTAL_URL.replace(/\/$/, '');
  const project = encodeURIComponent(env.REPORTPORTAL_PROJECT);
  const form = new FormData();
  form.append('file', new Blob([xml], { type: 'text/xml' }), 'junit.xml');
  form.append('launchImportRq', new Blob([JSON.stringify({ name })], { type: 'application/json' }));
  const res = await ok(
    await fetch(`${base}/api/v1/plugin/${project}/junit/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.REPORTPORTAL_API_KEY}` },
      body: form,
    }),
    'reportportal import',
  );
  const { id } = await res.json();
  return `${base}/ui/#${env.REPORTPORTAL_PROJECT}/launches/all (launch ${id})`;
}

async function main(env = process.env) {
  const dir = resolve(process.argv[2] ?? env.TEST_RESULTS_DIR ?? 'test-results');
  const targets = [
    env.ALLURE_URL && env.ALLURE_CI_PASSWORD && ['Allure', allure],
    env.REPORTPORTAL_URL &&
      env.REPORTPORTAL_API_KEY &&
      env.REPORTPORTAL_PROJECT && ['ReportPortal', reportportal],
  ].filter(Boolean);
  if (!targets.length) return console.log('test-report: no report server configured, nothing sent');
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.xml'));
  } catch {}
  if (!files.length) return console.log(`test-report: no JUnit XML in ${dir}, nothing sent`);
  const xml = mergeJunit(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  const name = runName(env);
  let failed = false;
  for (const [label, send] of targets) {
    try {
      console.log(`test-report: ${label}: ${await send(env, xml, name)}`);
    } catch (e) {
      failed = true;
      console.error(`test-report: ${label}: ${e.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

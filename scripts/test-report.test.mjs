import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeJunit, runName } from './test-report.mjs';

test('JUnit files merge into one testsuites document', () => {
  const a =
    '<?xml version="1.0"?>\n<testsuites name="vitest"><testsuite name="a"><testcase name="x"/></testsuite></testsuites>';
  const b = '<testsuite name="b"><testcase name="y"><failure message="no"/></testcase></testsuite>';
  const xml = mergeJunit([
    ['a.xml', a],
    ['b.xml', b],
  ]);
  assert.equal(xml.match(/<\?xml/g).length, 1);
  assert.equal(xml.match(/<testsuites>/g).length, 1);
  assert.equal(xml.match(/<\/testsuites>/g).length, 1);
  assert.match(xml, /<testsuite name="a">.*<\/testsuite>\n<testsuite name="b">/s);
});

test('cases outside a suite get one named after the file', () => {
  const xml = mergeJunit([['scripts.xml', '<testsuites><testcase name="x"/></testsuites>']]);
  assert.match(xml, /<testsuite name="scripts.xml">\n<testcase name="x"\/>\n<\/testsuite>/);
});

test('a run is named after the CI run', () => {
  assert.equal(
    runName({ GITHUB_WORKFLOW: 'CI', GITHUB_RUN_NUMBER: '7', GITHUB_REF_NAME: 'main' }),
    'CI #7 main',
  );
  assert.equal(runName({ CI_PIPELINE_IID: '3', CI_COMMIT_REF_NAME: 'dev' }), 'Pipeline #3 dev');
  assert.match(runName({}), /^local /);
});

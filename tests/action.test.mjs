import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fetchRepositoryLabels, installJev, runAction } from '../dist/action.js';

const fakeJev = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(args[1], 'utf8'));
process.stdout.write(JSON.stringify({model: 'jev-latest', answers: {label: {choice: 'bug'}}, request, assertion: args[3], apiKeyPresent: process.env.JEV_API_KEY === 'test-key', githubTokenPresent: Boolean(process.env['INPUT_GITHUB-TOKEN'])}));
process.exit(Number(process.env.JEV_TEST_EXIT_CODE || 0));
`;
const binary = Buffer.from(fakeJev);
const checksum = createHash('sha256').update(binary).digest('hex');

function mockFetch(url) {
  const address = String(url);
  if (address.includes('/labels?')) {
    return Promise.resolve(new Response(JSON.stringify([
      { name: 'bug', description: 'Fixes incorrect behavior' },
      { name: 'needs-triage', description: null },
    ])));
  }
  if (address.endsWith('.sha256')) return Promise.resolve(new Response(`${checksum}  jev-linux-x86_64\n`));
  return Promise.resolve(new Response(binary));
}

test('fetches all label pages and keeps GitHub descriptions', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ name: `label-${index}`, description: `Description ${index}` }));
  const calls = [];
  const labels = await fetchRepositoryLabels('token', 'owner/repo', 'https://api.github.com', async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(calls.length === 1 ? firstPage : [{ name: 'last', description: '' }]));
  });
  assert.equal(Object.keys(labels).length, 101);
  assert.equal(labels.last, 'last');
  assert.match(calls[1], /page=2$/);
});

test('verifies the Jev release checksum', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-test-'));
  try {
    await assert.rejects(
      installJev('v2026.919.0', directory, async (url) =>
        new Response(String(url).endsWith('.sha256') ? '0'.repeat(64) : binary), 'https://release.invalid'),
      /SHA-256 verification/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fetches repository labels, sends the event to Jev, and preserves assertion exit 3', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-test-'));
  try {
    const eventPath = join(directory, 'event.json');
    const outputPath = join(directory, 'output');
    await writeFile(eventPath, JSON.stringify({ pull_request: { title: '$(touch should-not-run)' } }));
    await writeFile(outputPath, '');
    const env = {
      ...process.env,
      'INPUT_API-KEY': 'test-key',
      'INPUT_GITHUB-TOKEN': 'github-token',
      INPUT_LABELS: 'repository',
      INPUT_ASSERT: 'answers.label.choice == "bug"',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      RUNNER_TEMP: directory,
      JEV_TEST_EXIT_CODE: '3',
    };
    assert.equal(await runAction(env, mockFetch, 'https://release.invalid'), 3);
    const outputs = Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), JSON.parse(line.slice(index + 1))];
    }));
    assert.deepEqual(outputs.labels, { bug: 'Fixes incorrect behavior', 'needs-triage': 'needs-triage' });
    assert.equal(outputs.response.request.state.pull_request.title, '$(touch should-not-run)');
    assert.equal(outputs.response.request.questions.label.criteria.bug, 'Fixes incorrect behavior');
    assert.equal(outputs.response.assertion, 'answers.label.choice == "bug"');
    assert.equal(outputs.response.apiKeyPresent, true);
    assert.equal(outputs.response.githubTokenPresent, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('limits fetched labels to named choices and rejects unknown names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-test-'));
  try {
    const eventPath = join(directory, 'event.json');
    const outputPath = join(directory, 'output');
    await writeFile(eventPath, '{}');
    await writeFile(outputPath, '');
    const env = {
      ...process.env,
      'INPUT_API-KEY': 'test-key',
      'INPUT_GITHUB-TOKEN': 'github-token',
      INPUT_LABELS: '["bug"]',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      RUNNER_TEMP: directory,
    };
    assert.equal(await runAction(env, mockFetch, 'https://release.invalid'), 0);
    assert.match(await readFile(outputPath, 'utf8'), /labels=\{"bug":"Fixes incorrect behavior"\}/);
    env.INPUT_LABELS = '["missing"]';
    await assert.rejects(runAction(env, mockFetch, 'https://release.invalid'), /Unknown repository label/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('accepts custom questions, a state file, or a complete request file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-test-'));
  try {
    const statePath = join(directory, 'state.json');
    const requestPath = join(directory, 'full-request.json');
    const outputPath = join(directory, 'output');
    await writeFile(statePath, '{"title":"Custom state"}');
    await writeFile(requestPath, '{"state":"Complete request","questions":{"x":{"type":"noul","instructions":"Valid?"}}}');
    await writeFile(outputPath, '');
    const env = {
      ...process.env,
      'INPUT_API-KEY': 'test-key',
      INPUT_QUESTIONS: '{"x":{"type":"noul","instructions":"Valid?"}}',
      'INPUT_STATE-FILE': statePath,
      GITHUB_OUTPUT: outputPath,
      RUNNER_TEMP: directory,
    };
    assert.equal(await runAction(env, mockFetch, 'https://release.invalid'), 0);
    let response = JSON.parse((await readFile(outputPath, 'utf8')).trim().slice('response='.length));
    assert.equal(response.request.state.title, 'Custom state');
    env.INPUT_QUESTIONS = '';
    env['INPUT_STATE-FILE'] = '';
    env['INPUT_REQUEST-FILE'] = requestPath;
    await writeFile(outputPath, '');
    assert.equal(await runAction(env, mockFetch, 'https://release.invalid'), 0);
    response = JSON.parse((await readFile(outputPath, 'utf8')).trim().slice('response='.length));
    assert.equal(response.request.state, 'Complete request');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

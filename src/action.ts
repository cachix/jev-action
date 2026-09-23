import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Labels = Record<string, string>;
type Fetcher = typeof fetch;

function input(env: NodeJS.ProcessEnv, name: string, fallback = ''): string {
  return (env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim();
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateLabels(value: unknown): Labels {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error('labels must contain at least one label');
  }
  for (const [name, description] of Object.entries(value)) {
    if (!name.trim() || typeof description !== 'string' || !description.trim()) {
      throw new Error('labels must map nonempty names to nonempty descriptions');
    }
  }
  return value as Labels;
}

export async function fetchRepositoryLabels(
  token: string,
  repository: string,
  apiBase: string,
  fetcher: Fetcher = fetch,
): Promise<Labels> {
  if (!token || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('Fetching labels requires github-token and GITHUB_REPOSITORY');
  }
  const [owner, repo] = repository.split('/');
  const labels: Labels = Object.create(null) as Labels;
  for (let page = 1; ; page += 1) {
    const url = `${apiBase.replace(/\/$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels?per_page=100&page=${page}`;
    const response = await fetcher(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'jev-action',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub label request failed with HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      throw new Error('GitHub returned an unexpected labels response');
    }
    for (const item of body) {
      if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error('GitHub returned an invalid label');
      }
      labels[item.name] = typeof item.description === 'string' && item.description.trim()
        ? item.description
        : item.name;
    }
    if (body.length < 100) break;
  }
  return labels;
}

export async function resolveLabels(
  value: string,
  env: NodeJS.ProcessEnv,
  fetcher: Fetcher = fetch,
): Promise<Labels> {
  if (value === 'repository') {
    return validateLabels(await fetchRepositoryLabels(
      input(env, 'github-token', env.GITHUB_TOKEN ?? ''),
      env.GITHUB_REPOSITORY ?? '',
      env.GITHUB_API_URL ?? 'https://api.github.com',
      fetcher,
    ));
  }
  const parsed = parseJson(value, 'labels');
  if (!Array.isArray(parsed)) return validateLabels(parsed);
  if (parsed.length === 0 || !parsed.every((name) => typeof name === 'string' && name.trim())) {
    throw new Error('labels array must contain at least one nonempty name');
  }
  const available = await fetchRepositoryLabels(
    input(env, 'github-token', env.GITHUB_TOKEN ?? ''),
    env.GITHUB_REPOSITORY ?? '',
    env.GITHUB_API_URL ?? 'https://api.github.com',
    fetcher,
  );
  const selected: Labels = Object.create(null) as Labels;
  for (const name of parsed as string[]) {
    if (!Object.hasOwn(available, name)) {
      throw new Error(`Unknown repository label: ${name}`);
    }
    selected[name] = available[name];
  }
  return validateLabels(selected);
}

function assetName(): string {
  if (process.platform === 'linux' && process.arch === 'x64') return 'jev-linux-x86_64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'jev-macos-aarch64';
  throw new Error('Jev supports Linux x86_64 and macOS arm64 runners');
}

export async function installJev(
  version: string,
  runnerTemp: string,
  fetcher: Fetcher = fetch,
  releaseBase = 'https://github.com/model-clis/jev/releases/download',
): Promise<string> {
  if (!/^v[0-9]{4}\.[1-9][0-9]*\.[0-9]+$/.test(version)) {
    throw new Error('version must be a complete vYYYY.MDD.REV release tag');
  }
  const asset = assetName();
  const base = `${releaseBase.replace(/\/$/, '')}/${version}/${asset}`;
  const [binaryResponse, hashResponse] = await Promise.all([
    fetcher(base),
    fetcher(`${base}.sha256`),
  ]);
  if (!binaryResponse.ok || !hashResponse.ok) {
    throw new Error(`Jev download failed (binary HTTP ${binaryResponse.status}, checksum HTTP ${hashResponse.status})`);
  }
  const binary = Buffer.from(await binaryResponse.arrayBuffer());
  const expected = (await hashResponse.text()).trim().split(/\s+/)[0];
  if (!/^[a-fA-F0-9]{64}$/.test(expected)) {
    throw new Error('Invalid Jev SHA-256 file');
  }
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual !== expected.toLowerCase()) {
    throw new Error('Jev download failed SHA-256 verification');
  }
  const directory = join(runnerTemp, 'jev-action', 'bin');
  await mkdir(directory, { recursive: true });
  const stage = join(directory, `jev.${process.pid}.tmp`);
  const destination = join(directory, 'jev');
  try {
    await writeFile(stage, binary, { mode: 0o755 });
    await chmod(stage, 0o755);
    await rename(stage, destination);
  } finally {
    await rm(stage, { force: true });
  }
  return destination;
}

export async function runJev(
  binary: string,
  request: string,
  assertion: string,
  apiKey: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; response?: unknown }> {
  const args = ['ask', request];
  if (assertion) args.push('--assert', assertion);
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('INPUT_') && name !== 'GITHUB_TOKEN' && name !== 'GH_TOKEN'),
  );
  const result = await new Promise<{ code: number; stdout: string }>((done, fail) => {
    const child = spawn(binary, args, {
      env: { ...childEnv, JEV_API_KEY: apiKey },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        oversized = true;
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (oversized) fail(new Error('Jev response exceeded 1 MiB'));
      else done({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
  const text = result.stdout.trim();
  if (!text) {
    if (result.code === 0) throw new Error('Jev returned no response');
    return { code: result.code };
  }
  return { code: result.code, response: parseJson(text, 'Jev response') };
}

async function writeOutput(env: NodeJS.ProcessEnv, name: string, value: unknown): Promise<void> {
  const path = env.GITHUB_OUTPUT;
  if (!path) throw new Error('GITHUB_OUTPUT is required');
  await appendFile(path, `${name}=${JSON.stringify(value)}\n`);
}

export async function runAction(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: Fetcher = fetch,
  releaseBase?: string,
): Promise<number> {
  const apiKey = input(env, 'api-key');
  const labelsInput = input(env, 'labels');
  const questionsInput = input(env, 'questions');
  const requestFile = input(env, 'request-file');
  const stateFile = input(env, 'state-file');
  const assertion = input(env, 'assert');
  const version = input(env, 'version', 'v2026.919.0');
  if (!apiKey) throw new Error('api-key is required');
  if (requestFile && (labelsInput || questionsInput || stateFile)) {
    throw new Error('request-file cannot be combined with labels, questions, or state-file');
  }
  if (!requestFile && [labelsInput, questionsInput].filter(Boolean).length !== 1) {
    throw new Error('Set exactly one of labels, questions, or request-file');
  }
  const workDir = await mkdtemp(join(env.RUNNER_TEMP ?? tmpdir(), 'jev-action-'));
  try {
    let request: string;
    if (requestFile) {
      request = resolve(requestFile);
      await readFile(request);
    } else {
      const statePath = stateFile || env.GITHUB_EVENT_PATH;
      if (!statePath) throw new Error('GITHUB_EVENT_PATH or state-file is required');
      const state = parseJson(await readFile(statePath, 'utf8'), 'state-file');
      let questions: Record<string, unknown>;
      if (labelsInput) {
        const labels = await resolveLabels(labelsInput, env, fetcher);
        await writeOutput(env, 'labels', labels);
        questions = {
          label: {
            type: 'choice',
            instructions: 'Which single label best describes this GitHub event? Use its title and body as evidence. If an uncertainty or triage label is available, choose it when the intent is unclear.',
            criteria: labels,
          },
        };
      } else {
        const parsed = parseJson(questionsInput, 'questions');
        if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
          throw new Error('questions must be a nonempty JSON object');
        }
        questions = parsed;
      }
      request = join(workDir, 'request.json');
      await writeFile(request, JSON.stringify({ state, questions }), { mode: 0o600 });
    }
    const binary = await installJev(version, env.RUNNER_TEMP ?? workDir, fetcher, releaseBase);
    const result = await runJev(binary, request, assertion, apiKey, env);
    if (result.response !== undefined) await writeOutput(env, 'response', result.response);
    return result.code;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

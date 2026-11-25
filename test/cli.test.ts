import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PASSWORD, startFakeDashboards, type FakeDashboards } from './fake-dashboards.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let fake: FakeDashboards;
let dir: string;
let configPath: string;

before(async () => {
  fake = await startFakeDashboards();
  fake.docs = [{ _id: 'a', _source: { '@timestamp': '2026-11-25T10:00:00Z' } }];

  dir = mkdtempSync(join(tmpdir(), 'lougger-test-'));
  configPath = join(dir, 'config.toml');
  writeFileSync(
    configPath,
    `[[source]]\nname = "dev"\nurl = "${fake.url}"\nuser = "reader"\npassword_env = "PW"\n`,
  );
});

after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await fake.close();
});

type Result = { code: number; stdout: string; stderr: string };

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve) => {
    const options = { env: { ...process.env, LOUGGER_CONFIG: '', ...env } };

    execFile(process.execPath, [CLI, ...args], options, (error, stdout, stderr) => {
      const code = typeof error?.code === 'number' ? error.code : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

test('--version prints the package version', async () => {
  const result = await run(['--version']);

  assert.equal(result.stdout.trim(), version);
  assert.equal(result.code, 0);
});

test('--help prints the usage', async () => {
  const result = await run(['--help']);

  assert.match(result.stdout, /Usage: lougger/);
  assert.equal(result.code, 0);
});

test('an unknown option exits with 2 and shows the usage', async () => {
  const result = await run(['--bogus']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option '--bogus'/);
  assert.match(result.stderr, /Usage: lougger/);
});

test('a missing config file exits with 2 and names the file', async () => {
  const missing = join(dir, 'nope.toml');
  const result = await run(['--config', missing]);

  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes(`cannot read ${missing}`));
  assert.equal(result.stdout, '', 'stdout stays clean for the MCP protocol');
});

test('--check logs in, lists the index patterns and tries a search', async () => {
  const result = await run(['--config', configPath, '--check'], { PW: PASSWORD });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /dev: 2 index pattern\(s\): app-\*, logs-\*/);
  assert.match(result.stderr, /dev: search works, 1 line\(s\) in app-\*/);
});

test('--check fails when the search is forbidden although the login works', async () => {
  fake.forbidSearch = true;
  const result = await run(['--config', configPath, '--check'], { PW: PASSWORD });
  fake.forbidSearch = false;

  assert.equal(result.code, 1);
  assert.match(result.stderr, /index pattern\(s\)/);
  assert.match(result.stderr, /✘ dev: Search failed: HTTP 403/);
});

test('--check exits with 1 on a wrong password', async () => {
  const result = await run(['--config', configPath, '--check'], { PW: 'wrong' });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /✘ dev: Source 'dev': wrong user name or password/);
});

test('a plain http source on another host gets a warning, a local one does not', async () => {
  const remotePath = join(dir, 'remote.toml');
  writeFileSync(
    remotePath,
    '[[source]]\nname = "far"\nurl = "http://dashboards.invalid"\nuser = "u"\npassword_env = "PW"\n',
  );

  const remote = await run(['--config', remotePath, '--check'], { PW: PASSWORD });
  assert.match(remote.stderr, /warning: source 'far' uses http/);

  const local = await run(['--config', configPath, '--check'], { PW: PASSWORD });
  assert.doesNotMatch(local.stderr, /warning/);
});

test('--help says what --check does', async () => {
  const result = await run(['--help']);

  assert.match(result.stdout, /--check .*index patterns, run one search/);
});

test('LOUGGER_* variables are enough, no config file needed', async () => {
  const env = {
    LOUGGER_SOURCES: `dev=${fake.url}, prod=${fake.url}/`,
    LOUGGER_USER: 'reader',
    LOUGGER_PASSWORD: PASSWORD,
  };
  const result = await run(['--check'], { ...env, XDG_CONFIG_HOME: dir });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /dev: search works/);
  assert.match(result.stderr, /prod: search works/);
});

test('a missing password variable stops the start instead of the first tool call', async () => {
  const env = { LOUGGER_SOURCES: fake.url, LOUGGER_USER: 'reader', LOUGGER_PASSWORD: '' };
  const result = await run(['--check'], env);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /LOUGGER_PASSWORD is not set/);
});

test('LOUGGER_CONFIG next to LOUGGER_SOURCES is ignored with a warning', async () => {
  const env = {
    LOUGGER_SOURCES: fake.url,
    LOUGGER_USER: 'reader',
    LOUGGER_PASSWORD: PASSWORD,
    LOUGGER_CONFIG: join(dir, 'unused.toml'),
  };
  const result = await run(['--check'], env);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /LOUGGER_CONFIG is ignored because LOUGGER_SOURCES is set/);
});

test('with neither variables nor a file, the error says how to configure', async () => {
  const result = await run(['--check'], { XDG_CONFIG_HOME: join(dir, 'empty') });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Set LOUGGER_SOURCES, LOUGGER_USER and LOUGGER_PASSWORD/);
});

test('a broken config file is reported as broken, without advice to create it', async () => {
  const brokenPath = join(dir, 'broken.toml');
  writeFileSync(brokenPath, '[[source]]\nname = "dev"\n');

  const result = await run(['--check'], { LOUGGER_CONFIG: brokenPath });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /source #1\.url/);
  assert.doesNotMatch(result.stderr, /No configuration found/);
});

test('the config path falls back to LOUGGER_CONFIG', async () => {
  const result = await run(['--check'], { PW: PASSWORD, LOUGGER_CONFIG: configPath });

  assert.equal(result.code, 0, result.stderr);
});

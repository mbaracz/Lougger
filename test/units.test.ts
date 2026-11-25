import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, configFromEnv, defaultConfigPath, parseConfig } from '../src/config.ts';
import {
  msearchBody,
  nextCursor,
  parsePage,
  timeRange,
  type Hit,
  type Search,
} from '../src/search.ts';
import { DEFAULT_FIELDS, getField, resolveField } from '../src/fields.ts';
import { groupTrace, MAX_MESSAGE, toLine } from '../src/trace.ts';

const CONFIG = `
[[source]]
name = "dev"
url = "http://127.0.0.1:5601/"
user = "admin"
password_env = "LOUGGER_DEV_PASSWORD"

[[source]]
name = "prod"
url = "https://dashboards.example"
tenant = "private"
user = "reader"
password_env = "LOUGGER_PROD_PASSWORD"
time_field = "timestamp"
[source.fields]
trace_id = ["requestId"]
`;

test('fields resolve through nested objects and flattened keys, first candidate wins', () => {
  const doc = {
    trace: { id: null },
    traceId: 't1',
    kubernetes: {
      namespace_name: 'orders',
      labels: { 'app_kubernetes_io/name': 'api' },
    },
    'k8s.pod.name': 'api-7d9f',
    'log.level': 'WARN',
    http: { status: 503 },
    __proto__: { polluted: 'x' },
  };
  assert.equal(resolveField(doc, DEFAULT_FIELDS.trace_id), 't1');
  assert.equal(resolveField(doc, DEFAULT_FIELDS.namespace), 'orders');
  assert.equal(resolveField(doc, DEFAULT_FIELDS.app), 'api');
  assert.equal(resolveField(doc, DEFAULT_FIELDS.pod), 'api-7d9f');
  assert.equal(resolveField(doc, DEFAULT_FIELDS.level), 'WARN');
  assert.equal(resolveField(doc, DEFAULT_FIELDS.span_id), undefined);
  assert.equal(resolveField(doc, ['http.status']), '503');
  assert.equal(resolveField(doc, ['http']), undefined);
  assert.equal(getField(doc, 'polluted'), undefined);
  assert.equal(getField('text', 'length'), undefined);
});

test('config: defaults, overrides and a trimmed URL', () => {
  const { sources } = parseConfig(CONFIG);
  const [dev, prod] = sources;
  assert.deepEqual(
    [dev?.url, dev?.tenant, dev?.timeout_ms, dev?.time_field, dev?.allow_self_signed],
    ['http://127.0.0.1:5601', 'global', 30_000, '@timestamp', false],
  );
  assert.deepEqual(dev?.fields, DEFAULT_FIELDS);
  assert.deepEqual(
    [prod?.tenant, prod?.time_field, prod?.fields.trace_id],
    ['private', 'timestamp', ['requestId']],
  );
  assert.deepEqual(prod?.fields.app, DEFAULT_FIELDS.app);
});

test('config: mistakes are rejected with a message that names the problem', () => {
  const bad = (text: string, pattern: RegExp) =>
    assert.throws(
      () => parseConfig(text),
      (e) => e instanceof ConfigError && pattern.test(e.message),
    );
  bad('', /at least one \[\[source]]/);
  bad('[[source', /invalid TOML/);
  bad(CONFIG.replace('name = "prod"', 'name = "dev"'), /'dev' is used twice/);
  bad(CONFIG.replace('https://dashboards.example', 'dashboards.example'), /source #2\.url/);
  bad(CONFIG.replace('https://dashboards.example', 'ftp://dashboards.example'), /http/);
  bad(
    CONFIG.replace('tenant = "private"', 'platform = "opensearch2"'),
    /source #2: Unrecognized key/,
  );
  bad(
    CONFIG.replace('https://dashboards.example', 'https://bob:hunter2@dashboards.example'),
    /user name or password/,
  );
  bad(
    CONFIG.replace('https://dashboards.example', 'https://dashboards.example/?a=1'),
    /query string/,
  );
  bad(CONFIG.replace('tenant = "private"', 'password = "hunter2"'), /use password_env/);
  bad(CONFIG.replace('LOUGGER_PROD_PASSWORD', 'hunter2!'), /environment variable name/);
  bad(CONFIG.replace('trace_id = ["requestId"]', 'trace_id = []'), /fields\.trace_id/);
});

const SHARED = { LOUGGER_USER: 'reader', LOUGGER_PASSWORD: 'secret' };

test('config from the environment: named sources share the user and the password', () => {
  const config = configFromEnv({
    ...SHARED,
    LOUGGER_SOURCES: 'dev=https://dev.example/, prod = https://prod.example\n',
    LOUGGER_TENANT: 'private',
    LOUGGER_ALLOW_SELF_SIGNED: 'true',
    LOUGGER_TIMEOUT_MS: '5000',
  });

  assert.deepEqual(
    config?.sources.map((source) => [source.name, source.url]),
    [
      ['dev', 'https://dev.example'],
      ['prod', 'https://prod.example'],
    ],
  );

  for (const source of config?.sources ?? []) {
    assert.equal(source.user, 'reader');
    assert.equal(source.password_env, 'LOUGGER_PASSWORD');
    assert.equal(source.tenant, 'private');
    assert.equal(source.allow_self_signed, true);
    assert.equal(source.timeout_ms, 5000);
    assert.deepEqual(source.fields, DEFAULT_FIELDS);
  }
});

test('config from the environment: a bare URL is a source called default', () => {
  const config = configFromEnv({ ...SHARED, LOUGGER_SOURCES: 'https://dashboards.example/' });

  assert.deepEqual(
    config?.sources.map((source) => [source.name, source.url, source.tenant]),
    [['default', 'https://dashboards.example', 'global']],
  );
});

test('an ECS document without a message has no message, not its log object', () => {
  const ecs = { log: { level: 'ERROR' }, event: { action: 'login' } };

  assert.equal(resolveField(ecs, DEFAULT_FIELDS.message), undefined);
  assert.equal(resolveField(ecs, DEFAULT_FIELDS.level), 'ERROR');
});

test('config from the environment: empty optional variables count as unset', () => {
  const config = configFromEnv({
    ...SHARED,
    LOUGGER_SOURCES: 'https://dashboards.example/',
    LOUGGER_TENANT: '',
    LOUGGER_TIMEOUT_MS: '',
    LOUGGER_ALLOW_SELF_SIGNED: '',
    LOUGGER_TIME_FIELD: '',
  });
  const source = config?.sources[0];

  assert.equal(source?.tenant, 'global');
  assert.equal(source?.timeout_ms, 30_000);
  assert.equal(source?.allow_self_signed, false);
  assert.equal(source?.time_field, '@timestamp');
});

test('config from the environment: absent without LOUGGER_SOURCES', () => {
  assert.equal(configFromEnv(SHARED), undefined);
  assert.equal(configFromEnv({ LOUGGER_SOURCES: '' }), undefined);
  assert.equal(configFromEnv({ LOUGGER_SOURCES: '  ' }), undefined);
});

test('config from the environment: mistakes name the variable', () => {
  const sources = 'dev=https://dev.example';
  const bad = (env: NodeJS.ProcessEnv, pattern: RegExp) =>
    assert.throws(
      () => configFromEnv({ ...SHARED, LOUGGER_SOURCES: sources, ...env }),
      (e) => e instanceof ConfigError && pattern.test(e.message),
    );

  assert.throws(
    () => configFromEnv({ LOUGGER_SOURCES: sources }),
    /^Error: LOUGGER_USER is not set\nLOUGGER_PASSWORD is not set$/,
  );
  assert.throws(
    () => configFromEnv({ LOUGGER_SOURCES: sources, LOUGGER_USER: 'reader' }),
    /^Error: LOUGGER_PASSWORD is not set$/,
  );
  bad({ LOUGGER_SOURCES: ' , ' }, /LOUGGER_SOURCES is empty/);
  bad(
    { LOUGGER_SOURCES: 'dev=https://a.example, dev=https://b.example' },
    /the name 'dev' is used twice/,
  );
  bad(
    { LOUGGER_SOURCES: 'https://a.example, https://b.example' },
    /the name 'default' is used twice/,
  );
  bad({ LOUGGER_SOURCES: 'dev=https://a.example, prod=not-a-url' }, /LOUGGER_SOURCES entry 2/);
  bad(
    { LOUGGER_SOURCES: 'dev=https://bob:pw@a.example' },
    /LOUGGER_SOURCES entry 1.*user name or password/,
  );
  bad({ LOUGGER_ALLOW_SELF_SIGNED: 'yes' }, /LOUGGER_ALLOW_SELF_SIGNED/);
  bad({ LOUGGER_TIMEOUT_MS: 'soon' }, /LOUGGER_TIMEOUT_MS/);
  bad({ LOUGGER_TENANT: 'admin' }, /LOUGGER_TENANT/);

  // One wrong shared variable is reported once, however many sources there are.
  const twoSources = { LOUGGER_SOURCES: 'a=https://a.example, b=https://b.example' };
  assert.throws(
    () => configFromEnv({ ...SHARED, ...twoSources, LOUGGER_TENANT: 'admin' }),
    (e) => (e as Error).message.match(/LOUGGER_TENANT/g)?.length === 1,
  );
});

test('config path: flag default follows LOUGGER_CONFIG, then XDG_CONFIG_HOME', () => {
  assert.equal(defaultConfigPath({ LOUGGER_CONFIG: '/x/c.toml' }), '/x/c.toml');
  assert.match(
    defaultConfigPath({ XDG_CONFIG_HOME: '/xdg' }),
    /^[\\/]xdg[\\/]lougger[\\/]config\.toml$/,
  );
  assert.match(defaultConfigPath({}), /\.config[\\/]lougger[\\/]config\.toml$/);
});

const SEARCH: Search = { pattern: 'logs-*', must: [], size: 2, oldestFirst: false };

function bodyOf(search: Search, timeField = '@timestamp') {
  const [header, body] = msearchBody(search, timeField, 30_000)
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));

  return { header, body };
}

test('msearch body: newest first by default, sorted by the time field only', () => {
  const must = timeRange('@timestamp', 'now-1h');
  const { header, body } = bodyOf({ ...SEARCH, must });

  assert.deepEqual(header, { index: 'logs-*' });
  assert.equal(body.size, 2);
  assert.equal(body.timeout, '30000ms');
  assert.deepEqual(body.sort, [{ '@timestamp': { order: 'desc', unmapped_type: 'date' } }]);
  assert.deepEqual(body.query.bool.must, [
    { range: { '@timestamp': { gte: 'now-1h', format: 'strict_date_optional_time' } } },
  ]);
  assert.deepEqual(body.query.bool.must_not, []);
});

test('msearch body: a cursor restarts at its timestamp and leaves out the lines already seen', () => {
  const cursor = { at: 1000, seen: ['a', 'b'] };

  const newestFirst = bodyOf({ ...SEARCH, cursor }).body.query.bool;
  assert.deepEqual(newestFirst.must, [
    { range: { '@timestamp': { lte: 1000, format: 'epoch_millis' } } },
  ]);
  assert.deepEqual(newestFirst.must_not, [{ ids: { values: ['a', 'b'] } }]);

  const oldestFirst = bodyOf({ ...SEARCH, oldestFirst: true, cursor }, 'ts').body;
  assert.equal(oldestFirst.sort[0].ts.order, 'asc');
  assert.deepEqual(oldestFirst.query.bool.must, [
    { range: { ts: { gte: 1000, format: 'epoch_millis' } } },
  ]);
});

test('no time range clause without bounds', () => {
  assert.deepEqual(timeRange('@timestamp'), []);
});

const hit = (docId: string, ms: unknown, row: Partial<Hit['row']> = {}): Hit => ({
  row: { id: `i/${docId}`, time: `t${ms}`, ...row },
  docId,
  sortValue: ms,
  document: { raw: docId },
});

/** A page of `hits` with more matches behind it, unless `total` says otherwise. */
const cursorAfter = (search: Search, hits: Hit[], total = hits.length + 1) =>
  nextCursor(search, { total, hits });

test('next cursor: none when the page holds everything that is left', () => {
  assert.equal(cursorAfter(SEARCH, [hit('a', 5)], 1), undefined);
  assert.equal(cursorAfter(SEARCH, [], 0), undefined);
});

test('next cursor: none after a full page that ends exactly at the last match', () => {
  assert.equal(cursorAfter(SEARCH, [hit('a', 9), hit('b', 5)], 2), undefined);
});

test('next cursor: the last timestamp and every line returned for it', () => {
  assert.deepEqual(cursorAfter(SEARCH, [hit('a', 9), hit('b', 5)]), { at: 5, seen: ['b'] });
  assert.deepEqual(cursorAfter(SEARCH, [hit('a', 5), hit('b', 5)]), { at: 5, seen: ['a', 'b'] });
});

test('next cursor: a page still inside the same millisecond keeps the earlier lines', () => {
  const search = { ...SEARCH, cursor: { at: 5, seen: ['a', 'b'] } };

  assert.deepEqual(cursorAfter(search, [hit('c', 5), hit('d', 5)]), {
    at: 5,
    seen: ['c', 'd', 'a', 'b'],
  });
  assert.deepEqual(cursorAfter(search, [hit('c', 5), hit('d', 4)]), { at: 4, seen: ['d'] });
});

test('next cursor: none for the sort value of a document without the time field', () => {
  const sentinel = -9223372036854775808;
  assert.equal(cursorAfter(SEARCH, [hit('a', 5), hit('b', sentinel)]), undefined);
});

test('next cursor: none when the sort value is not a number', () => {
  assert.equal(cursorAfter(SEARCH, [hit('a', 'x'), hit('b', 'x')]), undefined);
});

const SOURCE = { fields: DEFAULT_FIELDS, time_field: '@timestamp' };
const page = (response: unknown) => parsePage({ responses: [response] }, SOURCE, 'logs-*');

test('search response: a hit becomes a row with its id and sort value', () => {
  const _source = {
    '@timestamp': '2026-11-25T00:00:00Z',
    log: { level: 'ERROR' },
    message: 'boom',
    service: { name: 'api' },
    trace: { id: 't1' },
  };
  const hits = [{ _index: 'i', _id: 'a', sort: [5], _source }];

  const result = page({ hits: { total: { value: 7 }, hits } });

  assert.equal(result.total, 7);
  assert.equal(result.hits[0]?.docId, 'a');
  assert.equal(result.hits[0]?.sortValue, 5);
  assert.deepEqual(result.hits[0]?.row, {
    id: 'i/a',
    time: '2026-11-25T00:00:00Z',
    level: 'ERROR',
    namespace: undefined,
    app: 'api',
    pod: undefined,
    message: 'boom',
    trace_id: 't1',
    span_id: undefined,
    parent_span_id: undefined,
  });
});

test('search response: failed shards and cluster timeouts make the page incomplete', () => {
  const hits = { total: { value: 0 }, hits: [] };
  const failures = [{ reason: { reason: 'failed to create query' } }];

  const failed = page({ _shards: { total: 5, failed: 2, failures }, hits });
  assert.equal(failed.incomplete, '2 of 5 shards failed (failed to create query)');

  assert.equal(page({ timed_out: true, hits }).incomplete, 'the search timed out on the cluster');
  assert.equal(page({ _shards: { total: 5, failed: 0 }, hits }).incomplete, undefined);
});

test('search response: a search error is reported with its reason', () => {
  const error = { root_cause: [{ reason: 'Failed to parse query' }] };

  assert.throws(() => page({ error }), /Search error: Failed to parse query/);
});

test('search response: no matching index is an error', () => {
  const empty = { _shards: { total: 0 }, hits: { total: { value: 0 }, hits: [] } };

  assert.throws(() => page(empty), /No index matches 'logs-\*'/);
});

test('search response: an unexpected shape is reported', () => {
  assert.throws(() => parsePage({ statusCode: 500 }, SOURCE, 'logs-*'), /unexpected response/);
});

const line = (ms: number, namespace: string, app: string, level: string, message: string) =>
  hit(String(ms), ms, { namespace, app, level, message, trace_id: 't1' });

test('a trace is grouped by namespace, then app, in order of first appearance', () => {
  const trace = groupTrace('t1', [
    line(1000, 'shop', 'frontend', 'INFO', '--> POST /checkout'),
    line(1005, 'orders', 'orders-api', 'INFO', '--> POST /api/orders'),
    line(1010, 'payments', 'gateway', 'ERROR', '<-- 502'),
    line(1020, 'orders', 'orders-api', 'error', '<-- 502'),
    line(1030, 'shop', 'frontend', 'INFO', '<-- 502'),
  ]);

  assert.equal(trace.duration_ms, 30);
  assert.equal(trace.started, 't1000');
  assert.equal(trace.ended, 't1030');

  assert.deepEqual(
    trace.flow.map((step) => [step.at_ms, `${step.namespace}/${step.app}`]),
    [
      [0, 'shop/frontend'],
      [5, 'orders/orders-api'],
      [10, 'payments/gateway'],
    ],
  );
  assert.deepEqual(
    trace.namespaces.map((group) => group.namespace),
    ['shop', 'orders', 'payments'],
  );

  const orders = trace.namespaces[1]?.apps[0];
  assert.equal(orders?.lines, 2);
  assert.equal(orders?.errors, 1);
  assert.equal(orders?.first, 't1005');
  assert.equal(orders?.last, 't1020');
  assert.deepEqual(orders?.logs[0], {
    time: 't1005',
    level: 'INFO',
    message: '--> POST /api/orders',
  });
});

test('lines without namespace or app go to an (unknown) group', () => {
  const bare: Hit = { row: { id: 'i/1' }, docId: '1', sortValue: 'not-a-number', document: {} };
  const trace = groupTrace('t', [bare]);

  assert.equal(trace.namespaces[0]?.namespace, '(unknown)');
  assert.equal(trace.namespaces[0]?.apps[0]?.app, '(unknown)');
  assert.equal(trace.duration_ms, undefined);
});

test('a long message is cut on a code point and the hit is left untouched', () => {
  const message = 'x'.repeat(MAX_MESSAGE - 1) + '😀' + 'y'.repeat(50);
  const long = hit('a', 0, { message });

  assert.ok(toLine(long).message?.endsWith('😀 ...[truncated]'));
  assert.equal(long.row.message, message);
});

test('a message is cut by code points, so one that only looks long in UTF-16 stays whole', () => {
  const emoji = '😀'.repeat(MAX_MESSAGE / 2 + 1);
  assert.ok(emoji.length > MAX_MESSAGE);
  assert.equal(toLine(hit('a', 0, { message: emoji })).message, emoji);

  const tooMany = '😀'.repeat(MAX_MESSAGE + 1);
  const cut = toLine(hit('a', 0, { message: tooMany })).message;
  assert.equal(cut, `${'😀'.repeat(MAX_MESSAGE)} ...[truncated]`);
});

test('the raw document is included only on request', () => {
  const plain = hit('a', 0);

  assert.equal('source' in toLine(plain), false);
  assert.deepEqual(toLine(plain, true).source, { raw: 'a' });
});

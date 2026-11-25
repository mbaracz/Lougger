import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseConfig } from '../src/config.ts';
import { CursorStore } from '../src/paging.ts';
import { createServer } from '../src/server.ts';
import { startForwardProxy } from './forward-proxy.ts';
import {
  EMPTY_PATTERN,
  PASSWORD,
  startFakeDashboards,
  type FakeDashboards,
  type StoredDoc,
} from './fake-dashboards.ts';

let fake: FakeDashboards;
const open: { close(): Promise<void> }[] = [];
const logged: string[] = [];

before(async () => {
  fake = await startFakeDashboards();
});

after(async () => {
  for (const closable of open) {
    await closable.close();
  }
  await fake.close();
});

beforeEach(() => {
  logged.length = 0;
  fake.searches.length = 0;
  fake.docs = [];
  fake.searchError = undefined;
  fake.forbidSearch = false;
  fake.redirectTo = undefined;
  fake.delayMs = 0;
  fake.rejectionDelaysMs = [];
  fake.failedShards = 0;
  fake.textSortValues = false;
  fake.sentinelSortValues = false;
  fake.stallBody = false;
  fake.forbidLogin = false;
});

type ConnectOptions = { env?: NodeJS.ProcessEnv; url?: string; extra?: string };

async function connect(options: ConnectOptions = {}) {
  const config = parseConfig(`
    [[source]]
    name = "dev"
    url = "${options.url ?? fake.url}/"
    user = "reader"
    password_env = "PW"
    timeout_ms = 1000
    ${options.extra ?? ''}`);

  const server = createServer(config, {
    version: '0.0.0-test',
    env: options.env ?? { PW: PASSWORD },
    log: (line) => logged.push(line),
  });
  const client = new Client({ name: 'test', version: '0' });

  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push(client, server, { close: () => server.closeClients() });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]!.text;

    return { error: result.isError === true, text, json: () => JSON.parse(text) };
  };

  return { client, call };
}

const SEARCH = { source: 'dev', index_pattern: 'logs-*' };
const BASE = Date.parse('2026-11-25T10:00:00.000Z');

function doc(
  id: string,
  offsetMs: number,
  fields: Partial<Record<string, string>> = {},
): StoredDoc {
  return {
    _id: id,
    _source: {
      '@timestamp': new Date(BASE + offsetMs).toISOString(),
      log: { level: fields.level ?? 'INFO' },
      message: fields.message ?? `message ${id}`,
      kubernetes: {
        namespace_name: fields.namespace ?? 'shop',
        labels: { app: fields.app ?? 'frontend' },
      },
      trace: { id: fields.trace ?? 't1' },
    },
  };
}

test('the server introduces itself and lists five read-only tools', async () => {
  const { client } = await connect();

  assert.deepEqual(client.getServerVersion(), { name: 'lougger', version: '0.0.0-test' });
  assert.match(client.getInstructions() ?? '', /untrusted data/);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'get_trace',
    'list_fields',
    'list_index_patterns',
    'list_sources',
    'search_logs',
  ]);

  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
  }
});

test('list_sources never reveals the password or its variable', async () => {
  const { call } = await connect();
  const result = await call('list_sources');

  assert.deepEqual(result.json(), [
    { name: 'dev', url: fake.url, tenant: 'global', user: 'reader' },
  ]);
  assert.doesNotMatch(result.text, /PW|s3cret/);
});

test('concurrent calls share one login', async () => {
  const { call } = await connect();
  const loginsBefore = fake.logins;

  const [first] = await Promise.all([
    call('list_index_patterns', { source: 'dev' }),
    call('list_index_patterns', { source: 'dev' }),
  ]);

  assert.deepEqual(first.json(), ['app-*', 'logs-*']);
  assert.equal(fake.logins, loginsBefore + 1);
  assert.equal(fake.tenants.at(-1), '');
});

test('the private tenant is selected when configured', async () => {
  const { call } = await connect({ extra: 'tenant = "private"' });
  await call('list_index_patterns', { source: 'dev' });

  assert.equal(fake.tenants.at(-1), '__user__');
});

test('list_fields names the raw field behind each part of a log line', async () => {
  const { call } = await connect();
  const result = (await call('list_fields', SEARCH)).json();

  assert.deepEqual(result.line_fields, {
    time: '@timestamp',
    level: 'log.level',
    message: 'message',
    trace_id: 'trace.id',
    namespace: 'kubernetes.namespace_name',
    app: 'kubernetes.labels.app',
  });
  assert.equal(result.total, 7);
  assert.deepEqual(result.fields[0], { name: '@timestamp', type: 'date' });
});

test('list_fields can narrow the list by a part of the name', async () => {
  const { call } = await connect();
  const result = (await call('list_fields', { ...SEARCH, contains: 'Kubernetes' })).json();

  assert.deepEqual(
    result.fields.map((field: { name: string }) => field.name),
    ['kubernetes.labels.app', 'kubernetes.namespace_name'],
  );
});

test('list_fields on a pattern without an index says so', async () => {
  const { call } = await connect();
  const result = await call('list_fields', { source: 'dev', index_pattern: EMPTY_PATTERN });

  assert.ok(result.error);
  assert.match(result.text, /No index matches 'missing-\*'/);
});

test('requests go through HTTP_PROXY, and NO_PROXY exempts a host', async () => {
  const proxy = await startForwardProxy();
  open.push(proxy);

  const proxied = await connect({ env: { PW: PASSWORD, HTTP_PROXY: proxy.url } });
  const viaProxy = await proxied.call('list_index_patterns', { source: 'dev' });

  assert.equal(viaProxy.error, false, viaProxy.text);
  assert.ok(proxy.requests.length > 0, 'the proxy saw the requests');

  const seen = proxy.requests.length;
  const env = { PW: PASSWORD, HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1' };
  const direct = await connect({ env });
  const withoutProxy = await direct.call('list_index_patterns', { source: 'dev' });

  assert.equal(withoutProxy.error, false, withoutProxy.text);
  assert.equal(proxy.requests.length, seen, 'the exempt host was reached directly');
});

test('an https source goes through HTTPS_PROXY as a tunnel', async () => {
  const proxy = await startForwardProxy();
  const secure = await startFakeDashboards({ tls: true });
  open.push(proxy, secure);

  const { call } = await connect({
    url: secure.url,
    env: { PW: PASSWORD, HTTPS_PROXY: proxy.url },
    extra: 'allow_self_signed = true',
  });
  const result = await call('list_index_patterns', { source: 'dev' });

  assert.equal(result.error, false, result.text);
  assert.match(proxy.requests[0] ?? '', /^CONNECT 127\.0\.0\.1:\d+$/);
});

test('search_logs sends the query and the time range, and maps the lines', async () => {
  const { call } = await connect();
  fake.docs = [doc('a', 0, { level: 'ERROR', message: 'boom' })];

  const result = (
    await call('search_logs', { ...SEARCH, query: ' log.level:ERROR ', from: 'now-1h' })
  ).json();

  const { index, body } = fake.searches[0]!;
  assert.equal(index, 'logs-*');
  assert.equal(body.size, 100);
  assert.deepEqual(body.sort, [{ '@timestamp': { order: 'desc', unmapped_type: 'date' } }]);
  assert.deepEqual(body.query.bool.must, [
    { range: { '@timestamp': { gte: 'now-1h', format: 'strict_date_optional_time' } } },
    { query_string: { query: 'log.level:ERROR', analyze_wildcard: true } },
  ]);

  assert.equal(result.total, 1);
  assert.equal(result.next_cursor, null);
  assert.deepEqual(result.logs[0], {
    id: 'logs-2026.11.25/a',
    time: '2026-11-25T10:00:00.000Z',
    level: 'ERROR',
    namespace: 'shop',
    app: 'frontend',
    message: 'boom',
    trace_id: 't1',
  });
});

test('paging returns every line exactly once, even when lines share a timestamp', async () => {
  const { call } = await connect();
  // Five lines in the same millisecond straddle every page boundary.
  fake.docs = [
    doc('a', 0),
    doc('b', 5),
    doc('c', 5),
    doc('d', 5),
    doc('e', 5),
    doc('f', 5),
    doc('g', 9),
  ];

  const ids: string[] = [];
  const counts: unknown[] = [];
  let cursor: string | undefined;

  do {
    const page = (
      await call('search_logs', { ...SEARCH, from: 'now-1h', limit: 2, cursor })
    ).json();
    ids.push(...page.logs.map((line: { id: string }) => line.id.split('/')[1]));
    counts.push(page.total ?? `remaining ${page.remaining}`);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);

  assert.equal(ids[0], 'g', 'newest first');
  assert.equal(ids.at(-1), 'a');
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(counts, [7, 'remaining 5', 'remaining 3', 'remaining 1']);
});

test('search_logs refuses an unbounded search', async () => {
  const { call } = await connect();
  const refused = await call('search_logs', { ...SEARCH, query: '  ' });

  assert.ok(refused.error);
  assert.match(refused.text, /query, a time range/);
  assert.equal(fake.searches.length, 0);
});

test('a match-all query counts as no query', async () => {
  const { call } = await connect();

  for (const query of ['*', ' *:* ']) {
    const refused = await call('search_logs', { ...SEARCH, query });
    assert.ok(refused.error, query);
  }
  assert.equal(fake.searches.length, 0);
});

test('a result stays within the size budget and the cursor continues after the cut', async () => {
  const { call } = await connect();
  const message = 'x'.repeat(1900);
  fake.docs = Array.from({ length: 150 }, (_, i) => doc(`d${i}`, i, { message }));

  const args = { ...SEARCH, from: 'now-1h', limit: 150 };
  const first = await call('search_logs', args);
  const page = first.json();

  assert.ok(first.text.length < 210_000, `${first.text.length} characters`);
  assert.ok(page.returned < 150);
  assert.ok(page.next_cursor);

  const rest = (await call('search_logs', { ...args, cursor: page.next_cursor })).json();
  assert.equal(page.returned + rest.returned, 150);
  assert.equal(rest.logs[0].id, `logs-2026.11.25/d${149 - page.returned}`);
});

test('include_source counts against the size budget too', async () => {
  const { call } = await connect();
  const message = 'x'.repeat(50_000);
  fake.docs = Array.from({ length: 20 }, (_, i) => doc(`d${i}`, i, { message }));

  const result = await call('search_logs', { ...SEARCH, from: 'now-1h', include_source: true });

  assert.ok(result.text.length < 260_000, `${result.text.length} characters`);
  assert.ok(result.json().next_cursor);
});

test('paging stops with a note when too many lines share one timestamp', async () => {
  const { call } = await connect();
  fake.docs = Array.from({ length: 12_000 }, (_, i) => doc(`d${i}`, 0));

  const args = { ...SEARCH, from: 'now-1h', limit: 1000 };
  let page = (await call('search_logs', args)).json();
  let read = page.returned;

  while (page.next_cursor) {
    page = (await call('search_logs', { ...args, cursor: page.next_cursor })).json();
    read += page.returned;
  }

  assert.equal(read, 10_000 + 1000);
  assert.match(page.note, /more than 10000 lines share the timestamp 2026-11-25T10:00:00.000Z/);
});

test('a cursor is a short handle, however many lines share the last timestamp', async () => {
  const { call } = await connect();
  fake.docs = Array.from({ length: 900 }, (_, i) => doc(`d${i}`, 0));

  const page = (await call('search_logs', { ...SEARCH, from: 'now-1h', limit: 700 })).json();

  assert.match(page.next_cursor, /^[\w-]{12}$/);
});

test('a cursor only works for the search that produced it', async () => {
  const { call } = await connect();
  fake.docs = [doc('a', 0), doc('b', 1), doc('c', 2)];

  const args = { ...SEARCH, from: 'now-1h', limit: 2 };
  const { next_cursor: cursor } = (await call('search_logs', args)).json();
  const searchesBefore = fake.searches.length;

  const otherQuery = await call('search_logs', { ...args, query: 'timeout', cursor });
  const otherRange = await call('search_logs', { ...args, from: 'now-2h', cursor });
  const otherTool = await call('get_trace', { ...SEARCH, trace_id: 't1', cursor });

  for (const result of [otherQuery, otherRange, otherTool]) {
    assert.ok(result.error);
    assert.match(result.text, /belongs to a different search/);
  }
  assert.equal(fake.searches.length, searchesBefore, 'nothing was sent');

  const sameSearch = await call('search_logs', { ...args, limit: 50, cursor });
  assert.equal(sameSearch.error, false, 'a different limit is still the same search');
});

test('the cursor store forgets the oldest handle when it is full', () => {
  const store = new CursorStore(2);
  const cursor = { at: 1, seen: [] };

  const first = store.save(cursor, 'k')!;
  const second = store.save(cursor, 'k')!;
  const third = store.save(cursor, 'k')!;

  assert.throws(() => store.resolve(first, 'k'), /unknown or has expired/);
  assert.deepEqual(store.resolve(second, 'k'), cursor);
  assert.deepEqual(store.resolve(third, 'k'), cursor);
  assert.equal(store.save(undefined, 'k'), null);
});

test('the limit is capped at 1000 lines', async () => {
  const { call } = await connect();
  await call('search_logs', { ...SEARCH, to: 'now', limit: 999_999 });

  assert.equal(fake.searches[0]!.body.size, 1000);
});

test('include_source adds the raw document', async () => {
  const { call } = await connect();
  fake.docs = [doc('a', 0)];

  const result = (
    await call('search_logs', { ...SEARCH, from: 'now-1h', include_source: true })
  ).json();
  assert.equal(result.logs[0].source.kubernetes.labels.app, 'frontend');
});

test('get_trace finds only the lines of that trace and groups them', async () => {
  const { call } = await connect();
  const id = '4BF92F35-77B3-4DA6-A3CE-929D0E0E4736';
  fake.docs = [
    doc('a', 0, { trace: id, message: '--> /checkout' }),
    doc('b', 7, {
      trace: id,
      namespace: 'payments',
      app: 'gateway',
      level: 'ERROR',
      message: '<-- 502',
    }),
    doc('c', 10, { trace: id, level: 'ERROR', message: '<-- 502' }),
    doc('x', 3, { trace: 'another-trace' }),
  ];

  const trace = (await call('get_trace', { ...SEARCH, trace_id: ` ${id} ` })).json();

  const { body } = fake.searches[0]!;
  assert.equal(body.sort[0]['@timestamp'].order, 'asc');
  assert.equal(body.size, 200);
  assert.deepEqual(body.query.bool.must[0].bool.should[0], { match_phrase: { 'trace.id': id } });

  assert.equal(trace.total, 3);
  assert.equal(trace.returned, 3);
  assert.equal(trace.next_cursor, null);
  assert.equal(trace.duration_ms, 10);
  assert.deepEqual(
    trace.flow.map((step: any) => `${step.at_ms}:${step.namespace}/${step.app}`),
    ['0:shop/frontend', '7:payments/gateway'],
  );

  const [shop, payments] = trace.namespaces;
  assert.deepEqual([shop.namespace, shop.apps[0].lines, shop.apps[0].errors], ['shop', 2, 1]);
  assert.deepEqual(
    [payments.namespace, payments.apps[0].lines, payments.apps[0].errors],
    ['payments', 1, 1],
  );
});

test('lines inside a trace group do not repeat what the group says', async () => {
  const { call } = await connect();
  fake.docs = [doc('a', 0)];

  const trace = (await call('get_trace', { ...SEARCH, trace_id: 't1' })).json();
  const line = trace.namespaces[0].apps[0].logs[0];

  assert.deepEqual(line, { time: '2026-11-25T10:00:00.000Z', level: 'INFO', message: 'message a' });
});

test('a result that fills its pages exactly ends without an extra empty page', async () => {
  const { call } = await connect();
  fake.docs = [doc('a', 0), doc('b', 1), doc('c', 2), doc('d', 3)];

  for (const [tool, args] of [
    ['search_logs', { ...SEARCH, from: 'now-1h', limit: 2 }],
    ['get_trace', { ...SEARCH, trace_id: 't1', limit: 2 }],
  ] as const) {
    const first = (await call(tool, args)).json();
    assert.ok(first.next_cursor, tool);

    const second = await call(tool, { ...args, cursor: first.next_cursor });
    assert.equal(second.error, false, second.text);
    assert.deepEqual([second.json().returned, second.json().next_cursor], [2, null], tool);
  }
});

test('a long trace comes in pages', async () => {
  const { call } = await connect();
  fake.docs = [doc('a', 0), doc('b', 1), doc('c', 2)];

  const first = (await call('get_trace', { ...SEARCH, trace_id: 't1', limit: 2 })).json();
  assert.deepEqual([first.total, first.returned], [3, 2]);
  assert.ok(first.next_cursor);

  const second = (
    await call('get_trace', { ...SEARCH, trace_id: 't1', limit: 2, cursor: first.next_cursor })
  ).json();
  assert.deepEqual([second.remaining, second.returned, second.next_cursor], [1, 1, null]);
  assert.equal(second.namespaces[0].apps[0].logs[0].message, 'message c');
});

test('an unknown trace id is an error that names the fields searched', async () => {
  const { call } = await connect();
  const missing = await call('get_trace', { ...SEARCH, trace_id: 'nope' });

  assert.ok(missing.error);
  assert.match(missing.text, /No log lines with trace id nope .* trace\.id, trace_id/);
});

test('an expired session is renewed once, transparently', async () => {
  const { call } = await connect();
  await call('list_index_patterns', { source: 'dev' });
  const loginsBefore = fake.logins;

  fake.expireSessions();
  const result = await call('search_logs', { ...SEARCH, from: 'now-1h' });

  assert.equal(result.error, false, result.text);
  assert.equal(fake.logins, loginsBefore + 1);
});

test('a late rejection of the old session does not log the new one out', async () => {
  const { call } = await connect();
  await call('list_index_patterns', { source: 'dev' });

  fake.expireSessions();
  // The second call hears about the expired session only after the first one logged in again.
  fake.rejectionDelaysMs = [0, 300];

  const results = await Promise.all([
    call('search_logs', { ...SEARCH, from: 'now-1h' }),
    call('search_logs', { ...SEARCH, from: 'now-1h' }),
  ]);

  assert.deepEqual(
    results.map((result) => result.error),
    [false, false],
    results.map((result) => result.text).join(' | '),
  );
});

test('a forbidden search reports the 403 and its reason after one fresh login', async () => {
  const { call } = await connect();
  await call('list_index_patterns', { source: 'dev' });
  const loginsBefore = fake.logins;

  fake.forbidSearch = true;
  const result = await call('search_logs', { ...SEARCH, from: 'now-1h' });

  assert.ok(result.error);
  assert.match(result.text, /HTTP 403 .*no permissions for \[indices:data\/read\/msearch\]/);
  assert.match(result.text, /user 'reader' probably lacks the permission/);
  assert.equal(fake.logins, loginsBefore + 1);
});

test('a missing password variable is named in the error', async () => {
  const { call } = await connect({ env: {} });
  const result = await call('list_index_patterns', { source: 'dev' });

  assert.ok(result.error);
  assert.match(result.text, /set the password in the environment variable PW/);
});

test('a wrong password is reported, and a corrected one works without a restart', async () => {
  const env: NodeJS.ProcessEnv = { PW: 'wrong' };
  const { call } = await connect({ env });

  const rejected = await call('list_index_patterns', { source: 'dev' });
  assert.ok(rejected.error);
  assert.match(rejected.text, /wrong user name or password/);

  env.PW = PASSWORD;
  const accepted = await call('list_index_patterns', { source: 'dev' });
  assert.equal(accepted.error, false);
});

test('a rejected password is not sent again with every call', async () => {
  const { call } = await connect({ env: { PW: 'wrong' } });
  const attemptsBefore = fake.loginAttempts;

  const first = await call('list_index_patterns', { source: 'dev' });
  assert.match(first.text, /wrong user name or password/);

  for (let i = 0; i < 2; i++) {
    const later = await call('list_index_patterns', { source: 'dev' });
    assert.match(later.text, /rejected before and is not sent again.*restart the server/);
  }

  assert.equal(fake.loginAttempts, attemptsBefore + 1);
});

test('a 403 at login is reported as it is and tried again on the next call', async () => {
  const { call } = await connect();
  fake.forbidLogin = true;

  const blocked = await call('list_index_patterns', { source: 'dev' });
  assert.ok(blocked.error);
  assert.match(blocked.text, /login failed: HTTP 403 .*Too many requests/);

  fake.forbidLogin = false;
  const later = await call('list_index_patterns', { source: 'dev' });
  assert.equal(later.error, false, later.text);
});

test('the cluster gets a timeout a little under the client timeout', async () => {
  const { call } = await connect();
  await call('search_logs', { ...SEARCH, from: 'now-1h' });

  assert.equal(fake.searches[0]!.body.timeout, '800ms');
});

test('a trace not found on a cluster that answered in part is not a firm no', async () => {
  const { call } = await connect();
  fake.failedShards = 1;

  const result = await call('get_trace', { ...SEARCH, trace_id: 'nope' });

  assert.ok(result.error);
  assert.match(result.text, /No log lines with trace id nope/);
  assert.match(result.text, /incomplete: 1 of 3 shards failed.*may still exist/);
});

test('lines without a usable time value are returned, and paging stops with a note', async () => {
  const { call } = await connect();
  fake.docs = [doc('a', 0), doc('b', 1), doc('c', 2)];
  fake.sentinelSortValues = true;

  const page = (await call('search_logs', { ...SEARCH, from: 'now-1h', limit: 2 })).json();

  assert.deepEqual([page.returned, page.next_cursor], [2, null]);
  assert.match(page.note, /paging needs a date field/);
});

test('failed shards are reported in a note instead of passing as a full result', async () => {
  const { call } = await connect();
  fake.docs = [doc('a', 0)];
  fake.failedShards = 2;

  const search = (await call('search_logs', { ...SEARCH, from: 'now-1h' })).json();
  assert.match(search.note, /Incomplete result: 2 of 3 shards failed \(failed to create query\)/);

  const trace = (await call('get_trace', { ...SEARCH, trace_id: 't1' })).json();
  assert.match(trace.note, /Incomplete result: 2 of 3 shards failed/);
});

test('a complete result has no note', async () => {
  const { call } = await connect();
  fake.docs = [doc('a', 0)];

  const result = (await call('search_logs', { ...SEARCH, from: 'now-1h' })).json();
  assert.equal('note' in result, false);
});

test('when the sort value is not a timestamp, the result says that paging is not possible', async () => {
  const { call } = await connect();
  fake.docs = [doc('a', 0), doc('b', 1), doc('c', 2)];
  fake.textSortValues = true;

  const page = (await call('search_logs', { ...SEARCH, from: 'now-1h', limit: 2 })).json();

  assert.deepEqual([page.total, page.returned, page.next_cursor], [3, 2, null]);
  assert.match(page.note, /more lines, but paging needs a date field/);
});

test('a body that stops halfway is reported as a timeout, not as bad JSON', async () => {
  const { call } = await connect();
  fake.stallBody = true;

  const result = await call('list_index_patterns', { source: 'dev' });

  assert.ok(result.error);
  assert.match(result.text, /did not answer within 1000 ms/);
});

test('a failed tool call is also written to the log, with the tool name', async () => {
  const { call } = await connect();

  await call('list_index_patterns', { source: 'dev' });
  assert.deepEqual(logged, [], 'a call that worked logs nothing');

  await call('list_index_patterns', { source: 'prod' });
  assert.deepEqual(logged, [
    "lougger: list_index_patterns failed: Unknown source 'prod'. Available: dev.",
  ]);
});

test('an unknown source lists the available ones', async () => {
  const { call } = await connect();
  const result = await call('list_index_patterns', { source: 'prod' });

  assert.match(result.text, /Unknown source 'prod'. Available: dev/);
});

test('a query syntax error from the cluster is passed on', async () => {
  const { call } = await connect();
  fake.searchError = { root_cause: [{ reason: 'Failed to parse query [a:(]' }] };

  const result = await call('search_logs', { ...SEARCH, query: 'a:(' });
  assert.ok(result.error);
  assert.match(result.text, /Search error: Failed to parse query/);
});

test('an index pattern that matches no index is an error, not an empty result', async () => {
  const { call } = await connect();
  const result = await call('search_logs', {
    source: 'dev',
    index_pattern: EMPTY_PATTERN,
    from: 'now-1h',
  });

  assert.ok(result.error);
  assert.match(result.text, /No index matches 'missing-\*'/);
});

test('an unknown cursor is rejected before any request', async () => {
  const { call } = await connect();
  const result = await call('search_logs', { ...SEARCH, from: 'now-1h', cursor: 'not-a-cursor' });

  assert.ok(result.error);
  assert.match(result.text, /cursor is unknown or has expired/);
  assert.equal(fake.searches.length, 0);
});

test('missing required arguments are rejected by the input schema', async () => {
  const { call } = await connect();
  const result = await call('search_logs', { source: 'dev' });

  assert.ok(result.error);
});

test('an unreachable server gives a clear error', async () => {
  const stopped = await startFakeDashboards();
  await stopped.close();

  const { call } = await connect({ url: stopped.url });
  const result = await call('list_index_patterns', { source: 'dev' });

  assert.ok(result.error);
  assert.match(result.text, new RegExp(`Could not reach ${stopped.url}`));
});

test('a server slower than timeout_ms gives a timeout error', async () => {
  const { call } = await connect();
  fake.delayMs = 1300;

  const result = await call('list_index_patterns', { source: 'dev' });

  assert.ok(result.error);
  assert.match(result.text, /did not answer within 1000 ms/);
});

test('a redirect is reported with its target instead of being followed', async () => {
  const { call } = await connect();
  fake.redirectTo = 'https://sso.example/login';

  const result = await call('list_index_patterns', { source: 'dev' });

  assert.ok(result.error);
  assert.match(result.text, /redirect to https:\/\/sso\.example\/login/);
});

test('a self-signed certificate is refused unless allow_self_signed is set', async () => {
  const secure = await startFakeDashboards({ tls: true });
  open.push(secure);

  const strict = await connect({ url: secure.url });
  const refused = await strict.call('list_index_patterns', { source: 'dev' });
  assert.ok(refused.error);
  assert.match(refused.text, /Could not reach https:/);

  const relaxed = await connect({ url: secure.url, extra: 'allow_self_signed = true' });
  const accepted = await relaxed.call('list_index_patterns', { source: 'dev' });
  assert.equal(accepted.error, false, accepted.text);
});

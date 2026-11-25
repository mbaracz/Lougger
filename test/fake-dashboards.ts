import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

export type Doc = Record<string, any>;
export type StoredDoc = { _id: string; _source: Doc };

export type FakeDashboards = {
  url: string;
  logins: number;
  loginAttempts: number;
  /** Answers the next logins with 403, as a temporary block would. */
  forbidLogin: boolean;
  tenants: string[];
  searches: { index: string; body: Doc }[];

  docs: StoredDoc[];
  searchError?: Doc;
  forbidSearch: boolean;
  redirectTo?: string;
  delayMs: number;
  /** Delays of the next rejected-session answers, in order. */
  rejectionDelaysMs: number[];
  /** Shards reported as failed by every search. */
  failedShards: number;
  /** Answers searches with a sort value that is not a timestamp. */
  textSortValues: boolean;
  /** Answers searches with the sort value of a document that lacks the time field. */
  sentinelSortValues: boolean;
  /** Starts the index pattern answer and never finishes it. */
  stallBody: boolean;

  expireSessions(): void;
  close(): Promise<void>;
};

export const PASSWORD = 's3cret';
export const EMPTY_PATTERN = 'missing-*';

const FIELDS = [
  ['trace.id', 'string'],
  ['@timestamp', 'date'],
  ['log.level', 'string'],
  ['message', 'string'],
  ['kubernetes.namespace_name', 'string'],
  ['kubernetes.labels.app', 'string'],
  ['http.response.status_code', 'number'],
];

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

export async function startFakeDashboards(
  options: { tls?: boolean } = {},
): Promise<FakeDashboards> {
  const sessions = new Set<string>();

  const fake: FakeDashboards = {
    url: '',
    logins: 0,
    loginAttempts: 0,
    forbidLogin: false,
    tenants: [],
    searches: [],
    docs: [],
    forbidSearch: false,
    delayMs: 0,
    rejectionDelaysMs: [],
    failedShards: 0,
    textSortValues: false,
    sentinelSortValues: false,
    stallBody: false,
    expireSessions: () => sessions.clear(),
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };

  const handle = async (
    req: IncomingMessage,
    send: (status: number, body: unknown, headers?: Doc) => void,
    stall: () => void,
  ) => {
    const text = await readBody(req);
    const path = (req.url ?? '').split('?')[0];

    if (fake.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
    }

    if (req.method === 'POST' && !req.headers['osd-xsrf']) {
      return send(400, { message: 'Request must contain a osd-xsrf header.' });
    }

    if (path === '/auth/login') {
      const { username, password } = JSON.parse(text);
      fake.loginAttempts++;
      if (fake.forbidLogin) {
        return send(403, { message: 'Too many requests from this address' });
      }
      if (username !== 'reader' || password !== PASSWORD) {
        return send(401, { message: 'Unauthorized' });
      }

      fake.logins++;
      const id = `sid${fake.logins}`;
      sessions.add(id);
      return send(
        200,
        { username },
        { 'set-cookie': `security_authentication=${id}; Path=/; HttpOnly` },
      );
    }

    const session = /security_authentication=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!session || !sessions.has(session)) {
      const delay = fake.rejectionDelaysMs.shift() ?? 0;
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Like the security plugin, a rejected session also clears its cookie.
      const clearCookie = 'security_authentication=; Max-Age=0; Path=/';
      return send(401, { message: 'Unauthorized' }, { 'set-cookie': clearCookie });
    }

    if (fake.redirectTo) {
      return send(302, '', { location: fake.redirectTo });
    }

    if (path === '/api/v1/multitenancy/tenant') {
      fake.tenants.push(JSON.parse(text).tenant);
      return send(200, '');
    }

    if (path === '/api/saved_objects/_find') {
      if (fake.stallBody) {
        return stall();
      }

      const titles = ['logs-*', 'app-*', 'logs-*'];
      const saved = titles.map((title) => ({ attributes: { title } }));
      return send(200, { saved_objects: [...saved, { attributes: {} }] });
    }

    if (path === '/api/index_patterns/_fields_for_wildcard') {
      const pattern = new URL(req.url ?? '', 'http://fake').searchParams.get('pattern');
      if (pattern === EMPTY_PATTERN) {
        return send(404, { message: 'No indices match pattern' });
      }

      return send(200, {
        fields: FIELDS.map(([name, type]) => ({ name, type, searchable: true })),
      });
    }

    if (path === '/api/console/proxy') {
      if (fake.forbidSearch) {
        return send(403, { message: 'no permissions for [indices:data/read/msearch]' });
      }

      const [header, body] = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)) as [Doc, Doc];
      fake.searches.push({ index: header.index, body });
      return send(200, { responses: [search(fake, header.index, body)] });
    }

    send(404, { message: 'Not Found' });
  };

  const listener = (req: IncomingMessage, res: import('node:http').ServerResponse) => {
    const send = (status: number, body: unknown, headers: Doc = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const stall = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"saved_objects": [');
    };

    void handle(req, send, stall);
  };

  const server: Server = options.tls
    ? createHttpsServer(
        { key: fixture('self-signed.key'), cert: fixture('self-signed.crt') },
        listener,
      )
    : createHttpServer(listener);

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));

  const { port } = server.address() as AddressInfo;
  fake.url = `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`;

  return fake;
}

/**
 * Evaluates the parts of a search that Lougger's paging and trace lookup rely on:
 * epoch_millis ranges, match_phrase, must_not ids, sort order and size.
 * query_string and date-math ranges are recorded but match everything.
 */
function search(fake: FakeDashboards, index: string, body: Doc): Doc {
  if (fake.searchError) {
    return { error: fake.searchError, status: 400 };
  }

  if (index === EMPTY_PATTERN) {
    return { _shards: { total: 0 }, hits: { total: { value: 0 }, hits: [] }, status: 200 };
  }

  const timeField = Object.keys(body.sort[0])[0]!;
  const ascending = body.sort[0][timeField].order === 'asc';
  const millis = (doc: StoredDoc) => Date.parse(doc._source[timeField]);

  const excluded = new Set<string>(
    body.query.bool.must_not.flatMap((clause: Doc) => clause.ids?.values ?? []),
  );

  const matching = fake.docs
    .filter((doc) => !excluded.has(doc._id))
    .filter((doc) => body.query.bool.must.every((clause: Doc) => matches(doc, clause, millis(doc))))
    .sort((a, b) => (ascending ? millis(a) - millis(b) : millis(b) - millis(a)));

  const hits = matching.slice(0, body.size).map((doc) => ({
    _index: 'logs-2026.11.25',
    _id: doc._id,
    _source: doc._source,
    sort: [sortValue(fake, millis(doc))],
  }));

  return {
    _shards: {
      total: 3,
      failed: fake.failedShards,
      failures: fake.failedShards ? [{ reason: { reason: 'failed to create query' } }] : [],
    },
    hits: { total: { value: matching.length, relation: 'eq' }, hits },
    status: 200,
  };
}

function sortValue(fake: FakeDashboards, millis: number): unknown {
  if (fake.textSortValues) {
    return 'not-a-timestamp';
  }

  return fake.sentinelSortValues ? -9223372036854775808 : millis;
}

function matches(doc: StoredDoc, clause: Doc, millis: number): boolean {
  if (clause.bool?.should) {
    return clause.bool.should.some((option: Doc) => matches(doc, option, millis));
  }

  if (clause.match_phrase) {
    const [[field, value]] = Object.entries(clause.match_phrase) as [[string, string]];
    const actual = field.split('.').reduce((node: any, key) => node?.[key], doc._source);
    return actual === value;
  }

  const bounds = clause.range && (Object.values(clause.range)[0] as Doc);
  if (bounds?.format === 'epoch_millis') {
    return (
      (bounds.gte === undefined || millis >= bounds.gte) &&
      (bounds.lte === undefined || millis <= bounds.lte)
    );
  }

  return true;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

import { z } from 'zod';
import type { Source } from './config.ts';
import { DashboardsError } from './errors.ts';
import { resolveField } from './fields.ts';

export type Search = {
  pattern: string;
  must: unknown[];
  size: number;
  oldestFirst: boolean;
  cursor?: Cursor;
};

/**
 * Where the next page starts: the timestamp of the last line returned,
 * and the documents with that exact timestamp that were already returned.
 */
export type Cursor = { at: number; seen: string[] };

export type Row = {
  id: string;
  time?: string;
  level?: string;
  namespace?: string;
  app?: string;
  pod?: string;
  message?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
};

export type Hit = {
  row: Row;
  docId: string;
  /** The timestamp as OpenSearch sorted it, in epoch milliseconds for a date field. */
  sortValue: unknown;
  /** The stored document, as it came back. */
  document: unknown;
};

export type Page = {
  total: number;
  hits: Hit[];
  next?: Cursor;
  /** Why the hits may not be all there is, when the cluster answered only in part. */
  incomplete?: string;
};

export function timeRange(field: string, from?: string, to?: string): unknown[] {
  if (from === undefined && to === undefined) {
    return [];
  }

  const bounds = { gte: from, lte: to, format: 'strict_date_optional_time' };
  return [{ range: { [field]: bounds } }];
}

export function msearchBody(search: Search, timeField: string, timeoutMs: number): string {
  const order = search.oldestFirst ? 'asc' : 'desc';

  const must = [...search.must];
  const mustNot: unknown[] = [];

  // search_after needs a tiebreak that is unique across shards, and without a
  // point in time there is none. So a page restarts at the last timestamp and
  // leaves out the documents already returned for it.
  if (search.cursor) {
    const bound = search.oldestFirst ? 'gte' : 'lte';
    const fromCursor = { [bound]: search.cursor.at, format: 'epoch_millis' };

    must.push({ range: { [timeField]: fromCursor } });
    mustNot.push({ ids: { values: search.cursor.seen } });
  }

  const header = { index: search.pattern };
  const body = {
    size: search.size,
    // Without it the cluster keeps working on a search that this side has already given up on.
    timeout: `${timeoutMs}ms`,
    track_total_hits: true,
    // unmapped_type keeps an index that lacks the time field from failing its shard.
    sort: [{ [timeField]: { order, unmapped_type: 'date' } }],
    query: { bool: { must, must_not: mustNot } },
  };

  return `${JSON.stringify(header)}\n${JSON.stringify(body)}\n`;
}

/** The part of a source that says where a log line's fields are. */
type LineMapping = Pick<Source, 'fields' | 'time_field'>;

const reasonSchema = z.object({ reason: z.string().optional() });

// Only what this client reads. Everything else in the answer is left alone.
const searchResponseSchema = z.object({
  error: reasonSchema.extend({ root_cause: z.array(reasonSchema).optional() }).optional(),
  timed_out: z.boolean().optional(),
  _shards: z
    .object({
      total: z.number(),
      failed: z.number().optional(),
      failures: z.array(z.object({ reason: reasonSchema.optional() })).optional(),
    })
    .optional(),
  hits: z
    .object({
      total: z.object({ value: z.number() }).optional(),
      hits: z.array(
        z.object({
          _index: z.string(),
          _id: z.string(),
          _source: z.unknown(),
          sort: z.array(z.unknown()).optional(),
        }),
      ),
    })
    .optional(),
});

const msearchSchema = z.object({ responses: z.array(searchResponseSchema) });

type SearchResponse = z.infer<typeof searchResponseSchema>;
type RawHit = NonNullable<SearchResponse['hits']>['hits'][number];

/**
 * A document without the time field sorts with the largest or smallest long,
 * and a date_nanos field sorts in nanoseconds. Neither is a millisecond timestamp.
 */
export function isTimestamp(sortValue: unknown): sortValue is number {
  return Number.isSafeInteger(sortValue);
}

export function nextCursor(search: Search, page: Page): Cursor | undefined {
  const { hits } = page;

  // The total counts the matches from this page on, so nothing is left when it fits the page.
  const isLastPage = page.total <= hits.length;
  const at = hits.at(-1)?.sortValue;

  if (isLastPage || !isTimestamp(at)) {
    return undefined;
  }

  const seen = hits.filter((hit) => hit.sortValue === at).map((hit) => hit.docId);
  if (search.cursor?.at === at) {
    seen.push(...search.cursor.seen);
  }

  return { at, seen };
}

export function parsePage(body: unknown, mapping: LineMapping, pattern: string): Page {
  const parsed = msearchSchema.safeParse(body);
  const response = parsed.data?.responses[0];

  if (!response) {
    const issue = parsed.error?.issues[0];
    const detail = issue ? `${issue.path.join('.')}: ${issue.message}` : 'no responses';
    throw new DashboardsError(`Search returned an unexpected response (${detail}).`);
  }

  if (response.error) {
    const { root_cause, reason } = response.error;
    const message = root_cause?.[0]?.reason ?? reason ?? 'unknown error';
    throw new DashboardsError(`Search error: ${message}`);
  }

  if (response._shards?.total === 0) {
    throw new DashboardsError(`No index matches '${pattern}'. Use list_index_patterns.`);
  }

  if (!response.hits) {
    throw new DashboardsError('Search returned an unexpected response (no hits).');
  }

  const page: Page = {
    total: response.hits.total?.value ?? 0,
    hits: response.hits.hits.map((rawHit) => toHit(rawHit, mapping)),
  };

  const incomplete = whyIncomplete(response);
  if (incomplete) {
    page.incomplete = incomplete;
  }

  return page;
}

/**
 * A search can succeed with HTTP 200 and still have lost shards or run out of time.
 */
function whyIncomplete(response: SearchResponse): string | undefined {
  if (response.timed_out) {
    return 'the search timed out on the cluster';
  }

  const shards = response._shards;
  if (!shards?.failed) {
    return undefined;
  }

  const reason = shards.failures?.[0]?.reason?.reason;
  const summary = `${shards.failed} of ${shards.total} shards failed`;

  return reason ? `${summary} (${reason})` : summary;
}

function toHit(rawHit: RawHit, mapping: LineMapping): Hit {
  const doc: unknown = rawHit._source;
  const { fields } = mapping;

  const row: Row = {
    id: `${rawHit._index}/${rawHit._id}`,
    time: resolveField(doc, [mapping.time_field]),
    level: resolveField(doc, fields.level),
    namespace: resolveField(doc, fields.namespace),
    app: resolveField(doc, fields.app),
    pod: resolveField(doc, fields.pod),
    message: resolveField(doc, fields.message),
    trace_id: resolveField(doc, fields.trace_id),
    span_id: resolveField(doc, fields.span_id),
    parent_span_id: resolveField(doc, fields.parent_span_id),
  };

  return {
    row,
    docId: rawHit._id,
    sortValue: rawHit.sort?.[0],
    document: doc,
  };
}

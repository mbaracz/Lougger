import type { Source } from './config.ts';
import type { Dashboards } from './dashboards.ts';
import { DashboardsError } from './errors.ts';
import {
  DEFAULT_SEARCH,
  DEFAULT_TRACE,
  MAX_LINES,
  type GetTraceArgs,
  type ListFieldsArgs,
  type SearchLogsArgs,
} from './inputs.ts';
import { fitResult, pageCounts, type CursorStore } from './paging.ts';
import { timeRange, type Search } from './search.ts';
import { groupTrace, toLine } from './trace.ts';

const MAX_FIELDS = 300;

export function describeSource(source: Source) {
  return {
    name: source.name,
    url: source.url,
    tenant: source.tenant,
    user: source.user,
  };
}

export async function listFields(
  dashboards: Dashboards,
  args: ListFieldsArgs,
  signal: AbortSignal,
) {
  const all = await dashboards.fields(args.index_pattern, signal);
  const names = new Set(all.map((field) => field.name));

  // Which of the configured candidates this index really has, per part of a log line.
  const lineFields: Record<string, string> = { time: dashboards.source.time_field };
  for (const [part, candidates] of Object.entries(dashboards.source.fields)) {
    const present = candidates.find((candidate) => names.has(candidate));
    if (present) {
      lineFields[part] = present;
    }
  }

  const wanted = args.contains?.trim().toLowerCase();
  const matching = wanted ? all.filter((field) => field.name.toLowerCase().includes(wanted)) : all;
  const fields = matching.slice(0, MAX_FIELDS);

  return {
    line_fields: lineFields,
    total: matching.length,
    returned: fields.length,
    ...(fields.length < matching.length
      ? { note: `Only the first ${MAX_FIELDS} fields are listed. Narrow with "contains".` }
      : {}),
    fields,
  };
}

export async function searchLogs(
  dashboards: Dashboards,
  cursors: CursorStore,
  args: SearchLogsArgs,
  signal: AbortSignal,
) {
  const typed = args.query?.trim();
  const query = typed === '*' || typed === '*:*' ? '' : typed;
  const hasTimeRange = args.from !== undefined || args.to !== undefined;

  if (!query && !hasTimeRange) {
    throw new DashboardsError(
      'Give a query, a time range (from / to), or both. The whole index is too much to read.',
    );
  }

  const must = timeRange(dashboards.source.time_field, args.from, args.to);
  if (query) {
    must.push({ query_string: { query, analyze_wildcard: true } });
  }

  const searchKey = JSON.stringify([
    'search_logs',
    dashboards.source.name,
    args.index_pattern,
    query,
    args.from,
    args.to,
  ]);

  const search: Search = {
    pattern: args.index_pattern,
    must,
    size: Math.min(args.limit ?? DEFAULT_SEARCH, MAX_LINES),
    oldestFirst: false,
    cursor: cursors.resolve(args.cursor, searchKey),
  };

  const page = await dashboards.search(search, signal);
  const { hits, next, note } = fitResult(search, page, args.include_source);

  return {
    ...pageCounts(page.total, hits.length, args.cursor),
    next_cursor: cursors.save(next, searchKey),
    ...(note ? { note } : {}),
    logs: hits.map((hit) => toLine(hit, args.include_source)),
  };
}

export async function getTrace(
  dashboards: Dashboards,
  cursors: CursorStore,
  args: GetTraceArgs,
  signal: AbortSignal,
) {
  const { fields, time_field } = dashboards.source;
  const traceFields = fields.trace_id;

  // match_phrase finds the id in a keyword field and in an analysed text field,
  // where `term` misses ids with upper case or dashes. It takes no query syntax.
  const matchesTraceId = {
    bool: {
      should: traceFields.map((field) => ({
        match_phrase: { [field]: args.trace_id },
      })),
      minimum_should_match: 1,
    },
  };

  const searchKey = JSON.stringify([
    'get_trace',
    dashboards.source.name,
    args.index_pattern,
    args.trace_id,
    args.from,
    args.to,
  ]);

  const search: Search = {
    pattern: args.index_pattern,
    must: [matchesTraceId, ...timeRange(time_field, args.from, args.to)],
    size: Math.min(args.limit ?? DEFAULT_TRACE, MAX_LINES),
    oldestFirst: true,
    cursor: cursors.resolve(args.cursor, searchKey),
  };

  const page = await dashboards.search(search, signal);

  if (page.hits.length === 0) {
    const hasTimeRange = args.from !== undefined || args.to !== undefined;
    const scope = hasTimeRange ? ' within the time range' : '';

    const notFound =
      `No log lines with trace id ${args.trace_id} in ${args.index_pattern} ` +
      `(looked in the fields ${traceFields.join(', ')}${scope}).`;

    // Not finding it on a cluster that answered only in part proves nothing.
    const caveat = page.incomplete
      ? ` The result is incomplete: ${page.incomplete}. The trace may still exist.`
      : '';

    throw new DashboardsError(notFound + caveat);
  }

  const { hits, next, note } = fitResult(search, page);
  const { trace_id, flow, namespaces, ...times } = groupTrace(args.trace_id, hits);

  return {
    trace_id,
    ...pageCounts(page.total, hits.length, args.cursor),
    next_cursor: cursors.save(next, searchKey),
    ...(note ? { note } : {}),
    ...times,
    flow,
    namespaces,
  };
}

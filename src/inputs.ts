import { z } from 'zod';

export const MAX_LINES = 1_000;
export const DEFAULT_SEARCH = 100;
export const DEFAULT_TRACE = 200;

export const sourceArg = z.string().describe('Source name from list_sources.');

const indexPatternArg = z
  .string()
  .min(1)
  .describe('Index pattern from list_index_patterns, e.g. "logs-*".');

const fromArg = z
  .string()
  .min(1)
  .optional()
  .describe('Start of the time range, as ISO 8601 (2026-11-25T10:00:00Z) or date math (now-1h).');

const toArg = z
  .string()
  .min(1)
  .optional()
  .describe('End of the time range, same formats. Open-ended when omitted.');

const limitArg = (defaultLimit: number) =>
  z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Lines to return (default ${defaultLimit}, max ${MAX_LINES}).`);

const cursorArg = z
  .string()
  .optional()
  .describe('next_cursor of the previous result. Keep the other arguments as they were.');

export const listFieldsInput = {
  source: sourceArg,
  index_pattern: indexPatternArg,
  contains: z
    .string()
    .optional()
    .describe('Only fields whose name contains this text, e.g. "kubernetes".'),
};

export const searchLogsInput = {
  source: sourceArg,
  index_pattern: indexPatternArg,
  query: z
    .string()
    .optional()
    .describe(
      'Lucene query_string, e.g. `timeout` or ' +
        '`log.level:ERROR AND kubernetes.namespace_name:payments`. ' +
        'Field names differ between clusters, get them from list_fields.',
    ),
  from: fromArg,
  to: toArg,
  limit: limitArg(DEFAULT_SEARCH),
  cursor: cursorArg,
  include_source: z
    .boolean()
    .optional()
    .describe('Include the full raw document of each line (much larger output).'),
};

export const getTraceInput = {
  source: sourceArg,
  index_pattern: indexPatternArg,
  trace_id: z.string().trim().min(1).describe('Trace id, as in the trace_id of a log line.'),
  from: fromArg.describe(
    'Optional start of a time range to narrow the lookup (ISO 8601 or date math).',
  ),
  to: toArg,
  limit: limitArg(DEFAULT_TRACE),
  cursor: cursorArg,
};

type Args<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;
export type ListFieldsArgs = Args<typeof listFieldsInput>;
export type SearchLogsArgs = Args<typeof searchLogsInput>;
export type GetTraceArgs = Args<typeof getTraceInput>;

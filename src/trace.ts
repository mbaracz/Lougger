import { isTimestamp, type Hit, type Row } from './search.ts';

export const MAX_MESSAGE = 2_000;

const UNKNOWN = '(unknown)';
const ERROR_LEVEL = /^(error|fatal|critical)$/i;

export type Line = Row & { source?: unknown };

/** A line inside a trace group, without what the group already says. */
export type TraceLine = Omit<Line, 'id' | 'namespace' | 'app' | 'trace_id' | 'source'>;

export function toLine(hit: Hit, includeSource = false): Line {
  const line: Line = { ...hit.row };

  // The limit counts code points, so a cut never lands inside a surrogate pair.
  // The length check comes first because it is cheap and a shorter string cannot be over the limit.
  if (line.message !== undefined && line.message.length > MAX_MESSAGE) {
    const codePoints = Array.from(line.message);

    if (codePoints.length > MAX_MESSAGE) {
      line.message = `${codePoints.slice(0, MAX_MESSAGE).join('')} ...[truncated]`;
    }
  }

  if (includeSource) {
    line.source = hit.document;
  }

  return line;
}

function toTraceLine(hit: Hit): TraceLine {
  const { id, namespace, app, trace_id, ...rest } = toLine(hit);
  return rest;
}

export type Trace = {
  trace_id: string;

  started?: string;
  ended?: string;
  duration_ms?: number;

  flow: FlowStep[];
  namespaces: NamespaceGroup[];
};

type FlowStep = {
  at_ms?: number;
  namespace: string;
  app: string;
  first_message?: string;
};

type NamespaceGroup = { namespace: string; apps: AppGroup[] };

type AppGroup = {
  app: string;
  lines: number;
  errors: number;
  first?: string;
  last?: string;
  logs: TraceLine[];
};

/**
 * Hits must be oldest first. Groups keep the order of first appearance.
 */
export function groupTrace(traceId: string, hits: Hit[]): Trace {
  const first = hits[0];
  const last = hits.at(-1);
  const start = epochMillis(first);

  const trace: Trace = {
    trace_id: traceId,
    started: first?.row.time,
    ended: last?.row.time,
    duration_ms: elapsed(start, epochMillis(last)),
    flow: [],
    namespaces: [],
  };

  for (const hit of hits) {
    const { row } = hit;
    const namespace = row.namespace ?? UNKNOWN;
    const app = row.app ?? UNKNOWN;

    let namespaceGroup = trace.namespaces.find((group) => group.namespace === namespace);
    if (!namespaceGroup) {
      namespaceGroup = { namespace, apps: [] };
      trace.namespaces.push(namespaceGroup);
    }

    let appGroup = namespaceGroup.apps.find((group) => group.app === app);
    if (!appGroup) {
      appGroup = { app, lines: 0, errors: 0, first: row.time, logs: [] };
      namespaceGroup.apps.push(appGroup);

      trace.flow.push({
        at_ms: elapsed(start, epochMillis(hit)),
        namespace,
        app,
        first_message: toLine(hit).message,
      });
    }

    appGroup.lines++;
    appGroup.last = row.time;
    appGroup.logs.push(toTraceLine(hit));

    if (ERROR_LEVEL.test(row.level ?? '')) {
      appGroup.errors++;
    }
  }

  return trace;
}

function epochMillis(hit: Hit | undefined): number | undefined {
  const value = hit?.sortValue;
  return isTimestamp(value) ? value : undefined;
}

function elapsed(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined) {
    return undefined;
  }

  return end - start;
}

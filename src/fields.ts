/**
 * Where the fields of a log line live in a document.
 * Each logical field has a list of candidate names and the first one present wins.
 * Names use dots, and match both nested objects (`{"trace": {"id": ...}}`)
 * and flattened keys (`{"trace.id": ...}`).
 */
export const DEFAULT_FIELDS = {
  level: ['log.level', 'level', 'severity'],
  message: ['message', 'msg', 'log', 'full_message'],
  trace_id: ['trace.id', 'trace_id', 'traceId', 'mdc.traceId'],
  span_id: ['span.id', 'span_id', 'spanId', 'mdc.spanId'],
  parent_span_id: ['parent.id', 'parent_span_id', 'parentSpanId'],
  namespace: ['kubernetes.namespace_name', 'kubernetes.namespace', 'k8s.namespace.name'],
  app: [
    'service.name',
    'kubernetes.labels.app_kubernetes_io/name',
    'kubernetes.labels.app',
    'kubernetes.container_name',
  ],
  pod: ['kubernetes.pod_name', 'kubernetes.pod.name', 'k8s.pod.name'],
} as const satisfies Record<string, readonly string[]>;

export type FieldName = keyof typeof DEFAULT_FIELDS;
export type FieldMapping = Record<FieldName, readonly string[]>;

export function getField(doc: unknown, path: string): unknown {
  if (!isPlainObject(doc)) {
    return undefined;
  }

  if (Object.hasOwn(doc, path)) {
    return doc[path];
  }

  // "a.b.c" may be stored as {a: {b: {c}}}, {a: {"b.c"}} or {"a.b": {c}}.
  const parts = path.split('.');

  for (let split = 1; split < parts.length; split++) {
    const head = parts.slice(0, split).join('.');
    const rest = parts.slice(split).join('.');

    if (!Object.hasOwn(doc, head)) {
      continue;
    }

    const value = getField(doc[head], rest);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function resolveField(doc: unknown, candidates: readonly string[]): string | undefined {
  for (const path of candidates) {
    const value = getField(doc, path);

    // An object means the name matched a parent, as "log" does in an ECS document.
    if (value === undefined || value === null || typeof value === 'object') {
      continue;
    }

    return String(value);
  }

  return undefined;
}

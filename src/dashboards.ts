import type { Source } from './config.ts';
import { msearchBody, nextCursor, parsePage, type Page, type Search } from './search.ts';
import { Session } from './session.ts';

const INDEX_PATTERNS_PATH =
  '/api/saved_objects/_find?type=index-pattern&fields=title&per_page=10000';
const MSEARCH_PATH = '/api/console/proxy?path=_msearch&method=GET';
const FIELDS_PATH = '/api/index_patterns/_fields_for_wildcard';

export type Field = { name: string; type: string };

/** The calls lougger makes to one Dashboards instance. All of them only read. */
export class Dashboards {
  readonly source: Source;
  readonly #session: Session;

  constructor(source: Source, env: NodeJS.ProcessEnv = process.env) {
    this.source = source;
    this.#session = new Session(source, env);
  }

  /** Fields of the indices behind a pattern, as Dashboards lists them for Discover. */
  async fields(pattern: string, signal?: AbortSignal): Promise<Field[]> {
    const path = `${FIELDS_PATH}?pattern=${encodeURIComponent(pattern)}`;
    const body = (await this.#session.request('Reading fields', path, {
      method: 'GET',
      signal,
      notFound: `No index matches '${pattern}'. Use list_index_patterns.`,
    })) as { fields?: { name?: unknown; type?: unknown }[] } | null;

    return (body?.fields ?? [])
      .filter((field) => typeof field.name === 'string')
      .map((field) => ({ name: field.name as string, type: String(field.type ?? 'unknown') }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async indexPatterns(signal?: AbortSignal): Promise<string[]> {
    const body = (await this.#session.request('Reading index patterns', INDEX_PATTERNS_PATH, {
      method: 'GET',
      signal,
    })) as { saved_objects?: { attributes?: { title?: unknown } }[] } | null;

    const titles = (body?.saved_objects ?? [])
      .map((savedObject) => savedObject.attributes?.title)
      .filter((title) => typeof title === 'string');

    return [...new Set(titles)].sort();
  }

  async search(search: Search, signal?: AbortSignal): Promise<Page> {
    // A little under the client timeout, so the cluster's partial answer still arrives.
    const clusterTimeoutMs = Math.floor(this.source.timeout_ms * 0.8);

    const body = await this.#session.request('Search', MSEARCH_PATH, {
      method: 'POST',
      body: msearchBody(search, this.source.time_field, clusterTimeoutMs),
      contentType: 'application/x-ndjson',
      signal,
    });

    const page = parsePage(body, this.source, search.pattern);
    const next = nextCursor(search, page);

    return next ? { ...page, next } : page;
  }

  async close(): Promise<void> {
    await this.#session.close();
  }
}

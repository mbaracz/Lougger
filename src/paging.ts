import { randomBytes } from 'node:crypto';
import { DashboardsError } from './errors.ts';
import { nextCursor, type Cursor, type Hit, type Page, type Search } from './search.ts';
import { toLine } from './trace.ts';

// About 50k tokens. A result stops growing here, though a single larger line still goes out whole.
const MAX_RESULT_CHARS = 200_000;

// A cursor lists the lines already returned for its timestamp, and every next request excludes them.
const MAX_CURSOR_IDS = 10_000;
const MAX_OPEN_CURSORS = 200;

/**
 * Paging state stays in the server and the model carries a short handle for it.
 * A handle only works for the search that produced it.
 */
export class CursorStore {
  readonly #open = new Map<string, { cursor: Cursor; searchKey: string }>();
  readonly #capacity: number;

  constructor(capacity = MAX_OPEN_CURSORS) {
    this.#capacity = capacity;
  }

  save(cursor: Cursor | undefined, searchKey: string): string | null {
    if (!cursor) {
      return null;
    }

    const handle = randomBytes(9).toString('base64url');
    this.#open.set(handle, { cursor, searchKey });

    // A Map keeps insertion order, so its first key is the oldest handle.
    if (this.#open.size > this.#capacity) {
      const oldest = this.#open.keys().next().value;
      if (oldest !== undefined) {
        this.#open.delete(oldest);
      }
    }

    return handle;
  }

  resolve(handle: string | undefined, searchKey: string): Cursor | undefined {
    if (handle === undefined) {
      return undefined;
    }

    const entry = this.#open.get(handle);
    if (!entry) {
      throw new DashboardsError(
        'This cursor is unknown or has expired. Run the search again without a cursor.',
      );
    }

    if (entry.searchKey !== searchKey) {
      throw new DashboardsError(
        'This cursor belongs to a different search. Keep the tool and the other arguments ' +
          'as they were, or start again without a cursor.',
      );
    }

    return entry.cursor;
  }
}

export type FittedResult = { hits: Hit[]; next?: Cursor; note?: string };

/**
 * Cuts a page down to the size budget and moves the cursor to where the cut ends.
 */
export function fitResult(search: Search, page: Page, includeSource = false): FittedResult {
  let chars = 0;
  let count = 0;

  for (const hit of page.hits) {
    chars += JSON.stringify(toLine(hit, includeSource)).length;
    if (chars > MAX_RESULT_CHARS && count > 0) {
      break;
    }
    count++;
  }

  const hits = page.hits.slice(0, count);
  const wasCut = hits.length < page.hits.length;
  const next = wasCut ? nextCursor(search, { total: page.total, hits }) : page.next;

  const notes: string[] = [];
  if (page.incomplete) {
    notes.push(`Incomplete result: ${page.incomplete}.`);
  }

  const result: FittedResult = { hits };

  if (next && next.seen.length > MAX_CURSOR_IDS) {
    const timestamp = new Date(next.at).toISOString();
    notes.push(
      `Paging stopped: more than ${MAX_CURSOR_IDS} lines share the timestamp ${timestamp}. ` +
        'Narrow the query or the time range to read the rest.',
    );
  } else if (next) {
    result.next = next;
  } else if (page.total > hits.length) {
    notes.push(
      'There are more lines, but paging needs a date field to sort by. ' +
        'Narrow the query or the time range to read the rest.',
    );
  }

  if (notes.length > 0) {
    result.note = notes.join(' ');
  }

  return result;
}

/**
 * After the first page the search only counts what is left, so it is named differently.
 */
export function pageCounts(matches: number, returned: number, cursor: string | undefined) {
  return cursor === undefined ? { total: matches, returned } : { remaining: matches, returned };
}

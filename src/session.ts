import { Agent, EnvHttpProxyAgent, fetch, type Dispatcher, type Response } from 'undici';
import type { Source } from './config.ts';
import { DashboardsError } from './errors.ts';

const LOGIN_PATH = '/auth/login';
const TENANT_PATH = '/api/v1/multitenancy/tenant';

/**
 * HTTPS_PROXY, HTTP_PROXY and NO_PROXY are honoured when set. undici's fetch ignores them
 * on its own, and in many companies Dashboards is only reachable through a proxy.
 */
function chooseDispatcher(source: Source, env: NodeJS.ProcessEnv): Dispatcher | undefined {
  const tls = source.allow_self_signed ? { rejectUnauthorized: false } : undefined;

  const httpProxy = env.HTTP_PROXY || env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy;

  if (httpProxy || httpsProxy) {
    return new EnvHttpProxyAgent({
      ...(httpProxy ? { httpProxy } : {}),
      ...(httpsProxy ? { httpsProxy } : {}),
      noProxy: env.NO_PROXY || env.no_proxy || '',
      ...(tls ? { requestTls: tls, connect: tls } : {}),
    });
  }

  return tls ? new Agent({ connect: tls }) : undefined;
}

export type Call = {
  method: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  signal?: AbortSignal;
  /** Message for a 404, where it means that the thing asked for does not exist. */
  notFound?: string;
};

function jsonPost(body: unknown): Call {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    contentType: 'application/json',
  };
}

/**
 * One logged-in session with a Dashboards instance: the login, its cookies,
 * and logging in again when the session has expired.
 */
export class Session {
  readonly #source: Source;
  readonly #env: NodeJS.ProcessEnv;
  readonly #dispatcher: Dispatcher | undefined;

  readonly #cookies = new Map<string, string>();

  #login: Promise<void> | undefined;
  #rejectedPassword: string | undefined;

  constructor(source: Source, env: NodeJS.ProcessEnv) {
    this.#source = source;
    this.#env = env;

    this.#dispatcher = chooseDispatcher(source, env);
  }

  async close(): Promise<void> {
    await this.#dispatcher?.close();
  }

  /**
   * Sends a request as the logged-in user and returns the JSON answer.
   */
  async request(what: string, path: string, call: Call): Promise<unknown> {
    const { user, url, timeout_ms } = this.#source;
    let rejection = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      const login = (this.#login ??= this.#logIn());

      try {
        await login;
      } catch (e) {
        this.#forget(login);
        throw e;
      }

      const res = await this.#send(path, call);

      const sessionExpired = res.status === 401 || res.status === 403;
      if (sessionExpired) {
        rejection = await describeFailure(res);
        this.#forget(login);
        continue;
      }

      if (res.status === 404 && call.notFound) {
        await res.body?.cancel();
        throw new DashboardsError(call.notFound);
      }

      if (!res.ok) {
        const failure = await describeFailure(res);
        throw new DashboardsError(`${what} failed: ${failure}`);
      }

      try {
        return await res.json();
      } catch (e) {
        // The body can still be cut off by the caller or by the timeout.
        if (call.signal?.aborted) {
          throw e;
        }
        if ((e as Error).name === 'TimeoutError') {
          throw new DashboardsError(`${url} did not answer within ${timeout_ms} ms.`);
        }

        throw new DashboardsError(`${what} failed: ${url} did not answer with JSON.`);
      }
    }

    throw new DashboardsError(
      `${what} failed: ${rejection}. Logging in again did not help, ` +
        `so user '${user}' probably lacks the permission.`,
    );
  }

  #forget(login: Promise<void>): void {
    if (this.#login === login) {
      this.#login = undefined;
    }
  }

  async #logIn(): Promise<void> {
    const { name, user, password_env, tenant } = this.#source;

    const password = this.#env[password_env];
    if (!password) {
      throw new DashboardsError(
        `Source '${name}': set the password in the environment variable ${password_env}.`,
      );
    }

    // Sending a rejected password again with every tool call could lock the account.
    if (password === this.#rejectedPassword) {
      throw new DashboardsError(
        `Source '${name}': the password was rejected before and is not sent again. ` +
          'Correct it and restart the server.',
      );
    }

    this.#cookies.clear();

    const login = await this.#send(LOGIN_PATH, jsonPost({ username: user, password }));

    // Only a 401 means bad credentials. A 403 can be a block that passes, so it is tried again.
    if (login.status === 401) {
      await login.body?.cancel();
      this.#rejectedPassword = password;
      throw new DashboardsError(`Source '${name}': wrong user name or password.`);
    }

    if (!login.ok) {
      const failure = await describeFailure(login);
      const hint =
        login.status === 404 ? ' Is this OpenSearch Dashboards with the security plugin?' : '';
      throw new DashboardsError(`Source '${name}': login failed: ${failure}${hint}`);
    }

    await login.body?.cancel();

    // Index patterns are stored per tenant, so select it before anything else.
    const tenantId = tenant === 'global' ? '' : '__user__';
    const select = await this.#send(TENANT_PATH, jsonPost({ tenant: tenantId, username: user }));

    if (!select.ok) {
      const failure = await describeFailure(select);
      throw new DashboardsError(
        `Source '${name}': could not select the ${tenant} tenant: ${failure}`,
      );
    }

    await select.body?.cancel();
  }

  async #send(path: string, call: Call): Promise<Response> {
    const { url, name, timeout_ms } = this.#source;

    const timeout = AbortSignal.timeout(timeout_ms);
    const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(url + path, {
        method: call.method,
        body: call.body ?? null,
        headers: this.#headers(call.contentType),
        // Followed redirects would drop Set-Cookie headers, and none is expected from the API.
        redirect: 'manual',
        signal,
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      });
    } catch (e) {
      const cancelledByCaller = call.signal?.aborted;
      if (cancelledByCaller) {
        throw e;
      }

      if (timeout.aborted) {
        throw new DashboardsError(`${url} did not answer within ${timeout_ms} ms.`);
      }

      throw new DashboardsError(`Could not reach ${url}: ${networkReason(e)}`);
    }

    // A rejected answer clears the cookie it was sent with. Arriving late, it would
    // log out the session that another call has opened in the meantime.
    const isRejection = res.status === 401 || res.status === 403;
    if (!isRejection) {
      this.#rememberCookies(res);
    }

    const isRedirect = res.status >= 300 && res.status < 400;
    if (isRedirect) {
      await res.body?.cancel();

      const target = res.headers.get('location') ?? 'another address';
      throw new DashboardsError(
        `${url} answered with a redirect to ${target}. Check the url of source '${name}'.`,
      );
    }

    return res;
  }

  #headers(contentType: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      // Dashboards rejects calls without its XSRF header.
      'osd-xsrf': 'true',
    };

    if (contentType) {
      headers['content-type'] = contentType;
    }

    if (this.#cookies.size > 0) {
      headers.cookie = [...this.#cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    }

    return headers;
  }

  #rememberCookies(res: Response): void {
    for (const setCookie of res.headers.getSetCookie()) {
      const pair = setCookie.split(';', 1)[0] ?? '';
      const equals = pair.indexOf('=');
      if (equals < 1) {
        continue;
      }

      const key = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();

      if (value) {
        this.#cookies.set(key, value);
      } else {
        this.#cookies.delete(key);
      }
    }
  }
}

function networkReason(error: unknown): string {
  const cause = (error as { cause?: { message?: string; code?: string } }).cause;

  return cause?.message || cause?.code || (error as Error).message;
}

async function describeFailure(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 200);

  return snippet ? `HTTP ${res.status} (${snippet})` : `HTTP ${res.status}`;
}

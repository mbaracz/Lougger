# Lougger

Lougger is an MCP server that lets an AI agent read application logs from OpenSearch Dashboards.
The agent can search log lines and pull one trace grouped by Kubernetes namespace and app, so it can tell which service broke a request.

## Why

Working out where a request failed usually means opening Dashboards, searching one service, copying the trace id, and searching again in the next namespace.
An agent can do that loop on its own if it can run the searches.
On many clusters the OpenSearch API is not reachable from a laptop and Dashboards is the only way in, so Lougger talks to Dashboards the way the browser does:
it logs in with the login form, keeps the session cookie and sends its searches through the Dev Tools console proxy.

It only reads logs. The one thing it sets in Dashboards is the tenant of its own session.

## Tools

| Tool                  | What it does                                                            |
| --------------------- | ----------------------------------------------------------------------- |
| `list_sources`        | The configured Dashboards instances                                     |
| `list_index_patterns` | Index patterns of a source, for example `logs-*`                        |
| `list_fields`         | Field names and types of an index pattern, for writing queries          |
| `search_logs`         | Lines matching a query, a time range, or both, newest first             |
| `get_trace`           | The lines of one trace, oldest first, grouped by namespace and then app |

`search_logs` takes a Lucene `query_string` as in Dashboards and time bounds as ISO 8601 or date
math (`now-1h`). It refuses to run with neither a query nor a time range.

Results are kept small for the model. A search returns 100 lines by default and a trace 200, with
1000 as the maximum. Messages are cut at 2000 characters, the raw document comes only with
`include_source`, and a result stops growing at about 200 000 characters. When there is more,
`next_cursor` continues where the result ended.

## Requirements

- Node.js 22.19 or newer.
- OpenSearch Dashboards with the security plugin and its login form (user name and password).
- The Dev Tools console enabled in Dashboards, and an account that can use it and read the log
  indices. All searches go through the console.

Tested with OpenSearch 2.18 and OpenSearch Dashboards 2.18, in the Global and the Private tenant.
OpenSearch 1.x and Open Distro use the same login form but have not been tested.

Not supported: SSO-only logins (SAML, OIDC), tenants other than Global and Private, Elastic Kibana,
and direct access to the Elasticsearch or OpenSearch API.

## Setup

Your MCP client starts and stops the server itself, there is nothing to keep running. The whole
setup can live in the client's MCP config: the Dashboards URLs, one user and one password.

For GitHub Copilot in VS Code, put this in `.vscode/mcp.json`. VS Code asks for the password once
and keeps it in its secret storage, so the file holds no secret and can be committed for the team.

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "lougger-password",
      "description": "Dashboards password",
      "password": true
    }
  ],
  "servers": {
    "lougger": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "lougger"],
      "env": {
        "LOUGGER_SOURCES": "dev=https://dashboards-dev.example.com/, prod=https://dashboards.example.com/",
        "LOUGGER_USER": "logs-reader",
        "LOUGGER_PASSWORD": "${input:lougger-password}"
      }
    }
  }
}
```

Each `name=url` pair in `LOUGGER_SOURCES` is one source, and the agent picks an environment by its
name. With a single Dashboards, the bare URL is enough and the source is called `default`.

For Claude Code, put this in `.mcp.json`. The password comes from the environment Claude Code runs
in.

```json
{
  "mcpServers": {
    "lougger": {
      "command": "npx",
      "args": ["-y", "lougger"],
      "env": {
        "LOUGGER_SOURCES": "dev=https://dashboards-dev.example.com/, prod=https://dashboards.example.com/",
        "LOUGGER_USER": "logs-reader",
        "LOUGGER_PASSWORD": "${LOUGGER_PASSWORD}"
      }
    }
  }
}
```

To try the settings from a terminal, run the check. It logs in to every source, lists its index
patterns and runs one search.

```sh
LOUGGER_SOURCES='https://dashboards.example.com/' LOUGGER_USER='logs-reader' \
  LOUGGER_PASSWORD='your password' npx lougger --check
```

## Configuration

These variables apply to every source in `LOUGGER_SOURCES`.

| Variable                    | Default      | Meaning                                          |
| --------------------------- | ------------ | ------------------------------------------------ |
| `LOUGGER_SOURCES`           | required     | `name=url` pairs separated by commas, or one URL |
| `LOUGGER_USER`              | required     | User name                                        |
| `LOUGGER_PASSWORD`          | required     | Password                                         |
| `LOUGGER_TENANT`            | `global`     | `global` or `private`                            |
| `LOUGGER_TIMEOUT_MS`        | `30000`      | Per request                                      |
| `LOUGGER_ALLOW_SELF_SIGNED` | `false`      | `true` skips TLS certificate checks              |
| `LOUGGER_TIME_FIELD`        | `@timestamp` | Date field for time ranges and ordering          |

For a company CA, set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` and leave `LOUGGER_ALLOW_SELF_SIGNED`
off.

If Dashboards is only reachable through an HTTP proxy, set `HTTPS_PROXY` (or `HTTP_PROXY` for an
`http://` URL) next to the other variables, for example `"HTTPS_PROXY": "http://localhost:8079"`.
`NO_PROXY` lists hosts to reach directly.

### Config file

Use a file when the sources need different users or settings, or when your logs use other field
names for the trace id, namespace or app. [`config.example.toml`](config.example.toml) lists every
option.

```toml
[[source]]
name = "prod"
url = "https://dashboards.example.com/"
user = "logs-reader"
password_env = "LOUGGER_PROD_PASSWORD"
```

`--config <file>` always wins. Without it, `LOUGGER_SOURCES` is used when it is set. Otherwise the
file is `$LOUGGER_CONFIG`, else `~/.config/lougger/config.toml`.

## Limitations

- The call flow is the order in which apps first log in the trace. Span and parent ids are returned
  but not used to build a tree.
- The counts, the flow and the duration of a `get_trace` result cover the lines in that result. For
  a trace longer than one page, read the next pages too.
- A cursor lives in the server process. After a restart, run the search again.
- Paging remembers which lines it already returned for the last timestamp. If more than 10 000
  lines share one timestamp, paging stops there with a note and you have to narrow the query.
- Paging tells lines apart by document id. Two documents with the same id and the same timestamp in
  different indices count as one.
- A `date_nanos` time field is not supported.
- When the cluster answers only in part (failed shards, a search timeout), the result says so in a
  `note`. Read the note before trusting a count.
- A single line larger than the size budget is still returned whole.
- `index_pattern` is not limited to the saved index patterns. The agent can search any index the
  account can read.
- Error counts look at the level names `error`, `fatal` and `critical`.

## Security

Give Lougger an account that can only read the log indices. That account is the real limit on what
an agent can see.

Passwords are read from environment variables. A `password` key in the config file is rejected, and
so is a URL with credentials in it. Passwords are never logged or returned to the agent.

Log lines are untrusted input. An application can log text that reads like an instruction to the
agent. The server says so in its instructions, but you should still review what your agent does
with log content. Logs can also contain personal data, and that data reaches the model.

`allow_self_signed = true` turns off certificate verification for that source. An `http://` URL
sends the password and the logs unencrypted, and the server warns about it on stderr unless the
host is local.

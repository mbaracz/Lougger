#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ConfigError,
  configFromEnv,
  defaultConfigPath,
  loadConfig,
  type Config,
} from './config.ts';
import { Dashboards } from './dashboards.ts';
import { createServer } from './server.ts';

const USAGE = `Usage: lougger [options]

Runs the Lougger MCP server on stdio. MCP clients start it themselves.

Options:
  -c, --config <file>  config file (default: $LOUGGER_CONFIG, else ~/.config/lougger/config.toml)
      --check          log in to every source, list its index patterns, run one search, and exit
  -v, --version        print the version
  -h, --help           print this help

Without a config file, set the sources with environment variables:
  LOUGGER_SOURCES      "dev=https://dev.example/, prod=https://prod.example/" or one bare URL
  LOUGGER_USER         user name, shared by all sources
  LOUGGER_PASSWORD     password, shared by all sources
  optional, for all sources: LOUGGER_TENANT (global | private), LOUGGER_TIME_FIELD,
                             LOUGGER_TIMEOUT_MS, LOUGGER_ALLOW_SELF_SIGNED (true | false)`;

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const packageJson = createRequire(import.meta.url)('../package.json') as {
  version: string;
};
const { version } = packageJson;

// stdout carries the MCP protocol, so diagnostics go to stderr.
async function main(): Promise<number | undefined> {
  let args;
  try {
    args = readArgs();
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  if (args.help) {
    console.log(USAGE);
    return EXIT_OK;
  }

  if (args.version) {
    console.log(version);
    return EXIT_OK;
  }

  let config: Config;
  try {
    config = readConfig(args.config);
  } catch (e) {
    if (!(e instanceof ConfigError)) {
      throw e;
    }

    console.error(`Lougger: ${e.message}`);
    return EXIT_USAGE;
  }

  warnAboutPlainHttp(config);

  if (args.check) {
    return check(config);
  }

  await serve(config);
  return undefined;
}

/**
 * An explicit --config wins, then LOUGGER_SOURCES, then the config file.
 */
function readConfig(configFlag: string | undefined): Config {
  if (configFlag !== undefined) {
    return loadConfig(configFlag);
  }

  const fromEnv = configFromEnv();
  if (fromEnv) {
    if (process.env.LOUGGER_CONFIG) {
      console.error('Lougger: warning: LOUGGER_CONFIG is ignored because LOUGGER_SOURCES is set.');
    }

    return fromEnv;
  }

  const path = defaultConfigPath();
  if (!existsSync(path)) {
    throw new ConfigError(
      `No configuration found. Set LOUGGER_SOURCES, LOUGGER_USER and LOUGGER_PASSWORD, ` +
        `or create ${path}.`,
    );
  }

  return loadConfig(path);
}

function readArgs() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      check: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  return values;
}

function warnAboutPlainHttp(config: Config): void {
  for (const source of config.sources) {
    const { protocol, hostname } = new URL(source.url);
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

    if (protocol === 'http:' && !isLocal) {
      console.error(
        `Lougger: warning: source '${source.name}' uses http, ` +
          'so its password and logs cross the network unencrypted.',
      );
    }
  }
}

async function serve(config: Config): Promise<void> {
  const server = createServer(config, { version });

  const stop = () => {
    void server
      .close()
      .then(() => server.closeClients())
      .finally(() => process.exit(EXIT_OK));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await server.connect(new StdioServerTransport());

  process.stdin.once('close', stop);
}

async function check(config: Config): Promise<number> {
  let failed = 0;

  for (const source of config.sources) {
    const dashboards = new Dashboards(source);

    try {
      const patterns = await dashboards.indexPatterns();
      const list = patterns.join(', ');

      console.error(`✔ ${source.name}: ${patterns.length} index pattern(s): ${list}`);

      // Listing patterns does not touch the console proxy that every search goes through.
      const probe = patterns[0];
      if (probe !== undefined) {
        const page = await dashboards.search({
          pattern: probe,
          must: [],
          size: 0,
          oldestFirst: false,
        });

        console.error(`✔ ${source.name}: search works, ${page.total} line(s) in ${probe}`);
      }
    } catch (e) {
      failed++;
      console.error(`✘ ${source.name}: ${(e as Error).message}`);
    } finally {
      await dashboards.close();
    }
  }

  return failed > 0 ? EXIT_FAILED : EXIT_OK;
}

try {
  const exitCode = await main();

  if (exitCode !== undefined) {
    process.exitCode = exitCode;
  }
} catch (e) {
  const details = e instanceof Error ? (e.stack ?? e.message) : String(e);

  console.error(`Lougger: ${details}`);
  process.exitCode = EXIT_FAILED;
}

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { DEFAULT_FIELDS, type FieldMapping, type FieldName } from './fields.ts';

const fieldList = z.array(z.string().min(1)).min(1);
const fieldNames = Object.keys(DEFAULT_FIELDS) as FieldName[];

const sourceSchema = z.strictObject({
  name: z.string().regex(/^[\w.-]+$/, "use letters, digits, '_', '-' or '.'"),
  url: z
    .url({
      protocol: /^https?$/,
      error: 'must be an http:// or https:// URL',
    })
    .refine((url) => !hasCredentials(url), {
      error: 'must not contain a user name or password',
    })
    .refine((url) => !hasQueryOrFragment(url), {
      error: 'must not contain a query string or a fragment',
    }),
  tenant: z.enum(['global', 'private']).default('global'),
  user: z.string().min(1),
  password_env: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name'),
  allow_self_signed: z.boolean().default(false),
  timeout_ms: z.number().int().min(1000).max(300_000).default(30_000),
  time_field: z.string().min(1).default('@timestamp'),
  fields: z
    .strictObject(Object.fromEntries(fieldNames.map((f) => [f, fieldList.optional()])))
    .default({}),
});

const configSchema = z.strictObject({
  source: z.array(sourceSchema).optional(),
});

export type Source = Omit<z.infer<typeof sourceSchema>, 'fields'> & {
  fields: FieldMapping;
};
export type Config = { sources: Source[] };

export class ConfigError extends Error {}

export function parseConfig(text: string): Config {
  return validate(readToml(text), FILE_WORDING);
}

/**
 * Sources from LOUGGER_* variables, for a setup without a config file: several
 * environments in LOUGGER_SOURCES that share one user and one password.
 * Returns undefined when LOUGGER_SOURCES is not set.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config | undefined {
  if (!env.LOUGGER_SOURCES?.trim()) {
    return undefined;
  }

  const unset = ['LOUGGER_USER', 'LOUGGER_PASSWORD'].filter((name) => !env[name]);
  if (unset.length > 0) {
    throw new ConfigError(unset.map((name) => `${name} is not set`).join('\n'));
  }

  const entries = env.LOUGGER_SOURCES.split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  const sources = entries.map((entry) => {
    // "name=url", or a bare URL for a setup with one environment.
    const named = /^([\w.-]+)\s*=\s*(.*)$/.exec(entry);

    return {
      name: named ? named[1] : 'default',
      url: named ? named[2]?.trim() : entry,
      user: env.LOUGGER_USER,
      password_env: 'LOUGGER_PASSWORD',
      tenant: env.LOUGGER_TENANT || undefined,
      allow_self_signed: parseFlag(env.LOUGGER_ALLOW_SELF_SIGNED),
      timeout_ms: parseNumber(env.LOUGGER_TIMEOUT_MS),
      time_field: env.LOUGGER_TIME_FIELD || undefined,
    };
  });

  return validate({ source: sources }, ENV_WORDING);
}

// An empty variable counts as unset, since client config templates produce those easily.
// Values the schema cannot read are passed on as they are, so that it reports them.
function parseFlag(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }

  return value;
}

function parseNumber(value: string | undefined): unknown {
  if (!value?.trim()) {
    return undefined;
  }

  return Number.isNaN(Number(value)) ? value : Number(value);
}

/** How a problem is worded, depending on where the settings came from. */
type Wording = {
  where(path: PropertyKey[]): string;
  noSources: string;
  duplicateName(name: string): string;
};

const FILE_WORDING: Wording = {
  where([section, index, ...rest]) {
    if (section !== 'source' || typeof index !== 'number') {
      return section === undefined ? 'config' : [section, index, ...rest].join('.');
    }

    return [`source #${index + 1}`, ...rest].join('.');
  },
  noSources: 'define at least one [[source]]',
  duplicateName: (name) => `source name '${name}' is used twice`,
};

const ENV_WORDING: Wording = {
  where([, index, key]) {
    // The name and the URL of a source come from its entry, everything else from a shared variable.
    if (key === 'name' || key === 'url' || key === undefined) {
      return `LOUGGER_SOURCES entry ${Number(index) + 1}`;
    }

    return `LOUGGER_${String(key).toUpperCase()}`;
  },
  noSources: 'LOUGGER_SOURCES is empty',
  duplicateName: (name) => `LOUGGER_SOURCES: the name '${name}' is used twice`,
};

function validate(raw: unknown, wording: Wording): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    // A shared variable is wrong for every source, so the same line would come once per source.
    const problems = result.error.issues.map((issue) => describeIssue(issue, wording));
    throw new ConfigError([...new Set(problems)].join('\n'));
  }

  const sources = result.data.source ?? [];
  if (sources.length === 0) {
    throw new ConfigError(wording.noSources);
  }
  rejectDuplicateNames(
    sources.map((source) => source.name),
    wording,
  );

  return {
    sources: sources.map((source) => ({
      ...source,
      url: withoutTrailingSlash(source.url),
      fields: { ...DEFAULT_FIELDS, ...dropUndefined(source.fields) },
    })),
  };
}

// Both checks also see values that are not URLs at all, which the schema reports on its own.
function hasCredentials(url: string): boolean {
  const parsed = URL.parse(url);
  return parsed !== null && (parsed.username !== '' || parsed.password !== '');
}

function hasQueryOrFragment(url: string): boolean {
  const parsed = URL.parse(url);
  return parsed !== null && (parsed.search !== '' || parsed.hash !== '');
}

function readToml(text: string): unknown {
  try {
    return parseToml(text);
  } catch (e) {
    throw new ConfigError(`invalid TOML: ${(e as Error).message}`);
  }
}

function describeIssue(issue: z.core.$ZodIssue, wording: Wording): string {
  const hasInlinePassword = issue.code === 'unrecognized_keys' && issue.keys.includes('password');
  const hint = hasInlinePassword
    ? ' (passwords are not allowed in the config file, use password_env)'
    : '';

  return `${wording.where(issue.path)}: ${issue.message}${hint}`;
}

function rejectDuplicateNames(names: string[], wording: Wording): void {
  const seen = new Set<string>();

  for (const name of names) {
    if (seen.has(name)) {
      throw new ConfigError(wording.duplicateName(name));
    }
    seen.add(name);
  }
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function dropUndefined(fields: Record<string, string[] | undefined>): Partial<FieldMapping> {
  const defined = Object.entries(fields).filter(([, names]) => names !== undefined);
  return Object.fromEntries(defined);
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read ${path}: ${(e as Error).message}`);
  }

  try {
    return parseConfig(text);
  } catch (e) {
    throw new ConfigError(`${path}:\n${(e as Error).message}`);
  }
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LOUGGER_CONFIG) {
    return env.LOUGGER_CONFIG;
  }

  const configHome = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'lougger', 'config.toml');
}

export interface Config {
  port: number;
  appPassword: string;
  anthropicApiKey: string | undefined;
  claudeModel: string;
  openaiApiKey: string | undefined;
  openaiModel: string;
  generationsPerHour: number;
  maxGenerationsPerDay: number;
  loginMaxAttempts: number;
  loginLockMinutes: number;
  dataDir: string;
  staticDir: string;
  trustProxy: boolean;
  whoisCacheHours: number;
  whoisCacheFreeHours: number;
  denicIntervalMs: number;
  verisignIntervalMs: number;
}

export class ConfigError extends Error {}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) throw new ConfigError(`${name} muss eine nicht-negative Zahl sein (ist: "${raw}")`);
  return v;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appPassword = env.APP_PASSWORD ?? '';
  if (!appPassword) {
    throw new ConfigError('APP_PASSWORD ist nicht gesetzt. Bitte in der Umgebung bzw. .env setzen – ohne Passwort startet der Server nicht.');
  }
  return {
    port: num(env, 'PORT', 8787),
    appPassword,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    claudeModel: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    openaiModel: env.OPENAI_MODEL || 'gpt-5.5',
    generationsPerHour: num(env, 'GENERATIONS_PER_HOUR', 10),
    maxGenerationsPerDay: num(env, 'MAX_GENERATIONS_PER_DAY', 50),
    loginMaxAttempts: num(env, 'LOGIN_MAX_ATTEMPTS', 5),
    loginLockMinutes: num(env, 'LOGIN_LOCK_MINUTES', 15),
    dataDir: env.DATA_DIR || './data',
    staticDir: env.STATIC_DIR || '../web/dist',
    trustProxy: bool(env, 'TRUST_PROXY', true),
    whoisCacheHours: num(env, 'WHOIS_CACHE_HOURS', 24),
    whoisCacheFreeHours: num(env, 'WHOIS_CACHE_FREE_HOURS', 1),
    denicIntervalMs: num(env, 'DENIC_INTERVAL_MS', 2000),
    verisignIntervalMs: num(env, 'VERISIGN_INTERVAL_MS', 250),
  };
}

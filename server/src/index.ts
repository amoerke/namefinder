import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { Db } from './db.ts';
import { EventHub } from './events.ts';
import { GenerationLimiter } from './ratelimit.ts';
import { createAnthropicGenerator, createOpenAIGenerator } from './generate.ts';
import { createDomainChecker } from './domains/index.ts';
import { createApp } from './app.ts';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Konfigurationsfehler: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
if (!config.anthropicApiKey && !config.openaiApiKey) console.warn('Weder ANTHROPIC_API_KEY noch OPENAI_API_KEY gesetzt – es können keine Namen generiert werden.');

const db = Db.open(config.dataDir);
db.purgeExpiredSessions();
const purgeTimer = setInterval(() => db.purgeExpiredSessions(), 3_600_000);
purgeTimer.unref();
const hub = new EventHub();
const checker = createDomainChecker({
  cache: db,
  takenTtlMs: config.whoisCacheHours * 3_600_000,
  freeTtlMs: config.whoisCacheFreeHours * 3_600_000,
  intervalMs: { de: config.denicIntervalMs, com: config.verisignIntervalMs },
  onUpdate: (suggestionId, check) => {
    try {
      db.applyCheck(suggestionId, check);
    } catch (err) {
      console.error('Check konnte nicht gespeichert werden:', err);
    }
    hub.broadcast({ suggestionId, check });
  },
});
const limiter = new GenerationLimiter(
  config.generationsPerHour,
  config.maxGenerationsPerDay,
  db.recentSearchTimes(Date.now() - 24 * 3_600_000),
);
const app = createApp({
  config,
  db,
  checker,
  limiter,
  hub,
  providers: {
    ...(config.anthropicApiKey && {
      anthropic: { label: 'Claude', model: config.claudeModel, generate: createAnthropicGenerator({ apiKey: config.anthropicApiKey, model: config.claudeModel }) },
    }),
    ...(config.openaiApiKey && {
      openai: { label: 'OpenAI', model: config.openaiModel, generate: createOpenAIGenerator({ apiKey: config.openaiApiKey, model: config.openaiModel }) },
    }),
  },
});

if (existsSync(join(config.staticDir, 'index.html'))) {
  app.use('*', serveStatic({ root: config.staticDir }));
  app.get('*', serveStatic({ path: join(config.staticDir, 'index.html') }));
  console.log(`Statische Dateien aus ${config.staticDir}`);
} else {
  console.warn(`STATIC_DIR ${config.staticDir} nicht gefunden – nur API wird ausgeliefert.`);
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`namefinder läuft auf http://localhost:${info.port}`);
});

function shutdown(): void {
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

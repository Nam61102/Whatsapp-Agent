import { Logger } from '@nestjs/common';

/**
 * Startup configuration check. Reports problems by variable NAME only; values are never logged.
 * Missing database/JWT settings stop the server. A missing AI key does not: messages must keep
 * syncing and being stored, and AI jobs fail with a clear, non-retryable error until it is set.
 */
export function validateConfig(env: NodeJS.ProcessEnv = process.env): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];

  for (const name of ['DATABASE_URL', 'JWT_SECRET']) {
    if (!env[name] || !env[name]!.trim()) fatal.push(`${name} is not set`);
  }

  const key = (env.OPENROUTER_API_KEY || '').trim();
  if (!key) {
    warnings.push('OPENROUTER_API_KEY is not set: AI extraction and reply suggestions are disabled until it is configured');
  } else if (!key.startsWith('sk-or-')) {
    warnings.push('OPENROUTER_API_KEY does not look like an OpenRouter key (expected it to start with "sk-or-")');
  }
  return { fatal, warnings };
}

export function assertConfig(logger = new Logger('Config')) {
  const { fatal, warnings } = validateConfig();
  warnings.forEach((w) => logger.warn(w));
  if (fatal.length) {
    fatal.forEach((f) => logger.error(f));
    throw new Error(`Invalid server configuration: ${fatal.join('; ')}`);
  }
}

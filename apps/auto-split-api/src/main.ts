import { ConfigError, parseConfig } from './config';
import { createLogger } from './log';
import { createOpenAiProvider } from './openai-provider';
import { createAnalysisServer } from './server';

/**
 * THE PRODUCTION ENTRY. The OpenAI provider only: the mock provider is not imported here, so it is
 * not in this bundle. A bad configuration stops the process with a sentence that names the variable
 * and never prints its value.
 */
const logger = createLogger((line) => {
  process.stdout.write(`${line}\n`);
});

try {
  const config = parseConfig(process.env, { allowMock: false });
  if (config.apiKey === undefined) throw new ConfigError('OPENAI_API_KEY is required.');
  const provider = createOpenAiProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.providerTimeoutMs,
  });
  const server = createAnalysisServer({ config, provider, logger });
  server.listen(config.port, config.host, () => {
    logger.log({ event: 'start', provider: config.provider, status: config.port });
  });
  const stop = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  process.stderr.write(
    `auto-split-api: ${error instanceof ConfigError ? error.message : 'could not start'}\n`,
  );
  process.exit(1);
}

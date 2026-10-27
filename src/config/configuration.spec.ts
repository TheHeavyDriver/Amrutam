import { describe, expect, it } from 'vitest';
import { loadConfiguration } from './configuration.js';

describe('loadConfiguration', () => {
  it('uses pretty logs in development by default', () => {
    const config = loadConfiguration({ NODE_ENV: 'development' });

    expect(config.logging.pretty).toBe(true);
  });

  it('uses JSON logs in production by default', () => {
    const config = loadConfiguration({ NODE_ENV: 'production' });

    expect(config.logging.pretty).toBe(false);
  });

  it('honours an explicit LOG_PRETTY override', () => {
    const config = loadConfiguration({ NODE_ENV: 'production', LOG_PRETTY: 'true' });

    expect(config.logging.pretty).toBe(true);
  });

  it('maps validated environment values into the typed config', () => {
    const config = loadConfiguration({
      NODE_ENV: 'test',
      PORT: '4000',
      CORS_ORIGINS: 'https://example.com',
    });

    expect(config.nodeEnv).toBe('test');
    expect(config.http.port).toBe(4000);
    expect(config.http.corsOrigins).toEqual(['https://example.com']);
    expect(config.service.name).toBe('amrutam-api');
    expect(config.database.url).toContain('postgresql://');
  });
});

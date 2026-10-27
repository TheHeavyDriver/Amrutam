#!/usr/bin/env node
// Generates local-only development secrets in .env without overwriting any
// existing values. Never use this script for a deployed environment.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = '.env';

if (!existsSync(file)) {
  process.stderr.write('No .env file found. Copy .env.example to .env first.\n');
  process.exitCode = 1;
} else {
  let content = readFileSync(file, 'utf8');
  const present = new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.split('=')[0]?.trim())
      .filter(Boolean),
  );

  const values = {
    JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
    JWT_MFA_SECRET: randomBytes(48).toString('hex'),
    AUTH_TOKEN_PEPPER: randomBytes(48).toString('hex'),
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
  };

  const additions = Object.entries(values)
    .filter(([key]) => !present.has(key))
    .map(([key, value]) => `${key}=${value}`);

  if (additions.length === 0) {
    process.stdout.write('All local auth settings already exist; nothing changed.\n');
  } else {
    content = `${content.replace(/\s*$/, '')}\n\n# Local development auth settings (generated)\n${additions.join('\n')}\n`;
    writeFileSync(file, content, { mode: 0o600 });
    chmodSync(file, 0o600);
    process.stdout.write(`Added ${additions.length} local auth setting(s) to .env.\n`);
  }
}

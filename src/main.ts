import './instrumentation.js';
import 'dotenv/config';
import 'reflect-metadata';
import { bootstrap } from './bootstrap.js';

bootstrap().catch((error: unknown) => {
  console.error('Failed to start application:', error);
  process.exitCode = 1;
});

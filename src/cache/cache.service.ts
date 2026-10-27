import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClient } from 'redis';
import { AppConfigService } from '../config/app-config.service.js';

export const DOCTOR_LIST_TTL_SECONDS = 60;
export const DOCTOR_DETAIL_TTL_SECONDS = 120;
export const DOCTOR_AVAILABILITY_TTL_SECONDS = 30;

type RedisClient = ReturnType<typeof createClient>;

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly enabled: boolean;
  private readonly client: RedisClient | null;
  private ready = false;

  constructor(config: AppConfigService) {
    this.enabled = config.cache.enabled;

    if (!this.enabled) {
      this.client = null;
      return;
    }

    this.client = createClient({
      url: config.redis.url,
      socket: {
        connectTimeout: 2_000,
        // Cache is optional infrastructure: fail fast and serve from PostgreSQL
        // rather than delaying API startup when Redis is unavailable.
        reconnectStrategy: false,
      },
    });

    this.client.on('error', (error: Error) => {
      this.ready = false;
      this.logger.warn({ err: error }, 'Redis cache error; falling back to PostgreSQL');
    });
    this.client.on('ready', () => {
      this.ready = true;
      this.logger.log('Redis cache connected');
    });
    this.client.on('end', () => {
      this.ready = false;
    });
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.client.connect();
    } catch (error) {
      this.ready = false;
      this.logger.warn({ err: error }, 'Redis cache unavailable; serving without cache');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client?.isOpen) {
      return;
    }

    try {
      await this.client.quit();
    } catch {
      this.client.destroy();
    }
  }

  async getJson<Value>(key: string): Promise<Value | null> {
    if (!this.client?.isReady) {
      return null;
    }

    try {
      const raw = await this.client.get(key);
      return raw === null ? null : (JSON.parse(raw) as Value);
    } catch (error) {
      this.logger.debug({ err: error }, 'Cache read failed');
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.client?.isReady) {
      return;
    }

    try {
      await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
    } catch {
      // Cache writes are best-effort and must never fail a request.
    }
  }

  async getOrSet<Value>(
    key: string,
    ttlSeconds: number,
    load: () => Promise<Value>,
  ): Promise<Value> {
    const cached = await this.getJson<Value>(key);
    if (cached !== null) {
      return cached;
    }

    const value = await load();
    await this.setJson(key, value, ttlSeconds);
    return value;
  }

  async delete(key: string): Promise<void> {
    if (!this.client?.isReady) {
      return;
    }

    try {
      await this.client.del(key);
    } catch {
      // Best-effort invalidation; TTL still bounds stale reads.
    }
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    if (!this.client?.isReady) {
      return;
    }

    try {
      for await (const keys of this.client.scanIterator({
        MATCH: `${prefix}*`,
        COUNT: 100,
      })) {
        if (keys.length > 0) {
          await this.client.del(keys);
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to invalidate cache prefix');
    }
  }

  static keyHash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "crypto";
import Redis from "ioredis";
import { env } from "../config/env";

type CachedValue = {
  expiresAt: number | null;
  value: string;
};

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client = new Redis(env.redisUrl, {
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  private readonly fallbackStore = new Map<string, CachedValue>();
  private fallbackEnabled = false;

  constructor() {
    this.client.on("error", (error) => {
      if (this.fallbackEnabled) {
        return;
      }

      this.logger.warn(`Redis client error: ${this.describeError(error)}`);
    });
  }

  async onModuleInit() {
    try {
      await this.client.connect();
      console.log("====== Redis Connected ======");
    } catch (error) {
      if (!this.canUseFallback(error)) {
        throw error;
      }

      this.enableFallback(error);
    }
  }

  async onModuleDestroy() {
    if (this.fallbackEnabled) {
      this.fallbackStore.clear();
      return;
    }

    if (this.client.status === "end") {
      return;
    }

    await this.client.quit();
  }

  async ping() {
    return this.withRedisClient(
      (client) => client.ping(),
      async () => "PONG",
    );
  }

  async setJson(key: string, value: unknown, ttlSeconds: number) {
    await this.withRedisClient(
      async (client) => {
        await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
      },
      async () => {
        this.fallbackStore.set(key, {
          expiresAt: Date.now() + ttlSeconds * 1000,
          value: JSON.stringify(value),
        });
      },
    );
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.withRedisClient(
      (client) => client.get(key),
      async () => {
        const cachedValue = this.getFallbackValue(key);
        return cachedValue?.value ?? null;
      },
    );

    if (!value) {
      return null;
    }

    return JSON.parse(value) as T;
  }

  async delete(key: string) {
    await this.withRedisClient(
      async (client) => {
        await client.del(key);
      },
      async () => {
        this.fallbackStore.delete(key);
      },
    );
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    return this.withRedisClient(
      async (client) => {
        const value = await client.incr(key);

        if (value === 1) {
          await client.expire(key, ttlSeconds);
        }

        return value;
      },
      async () => {
        const existing = this.getFallbackValue(key);
        const current = existing ? parseInt(existing.value, 10) : 0;
        const next = current + 1;

        this.fallbackStore.set(key, {
          expiresAt: existing?.expiresAt ?? Date.now() + ttlSeconds * 1000,
          value: String(next),
        });

        return next;
      },
    );
  }

  async pushToList(key: string, json: unknown): Promise<void> {
    await this.withRedisClient(
      async (client) => {
        await client.lpush(key, JSON.stringify(json));
      },
      async () => {
        const existing = this.getFallbackValue(key);
        const list: unknown[] = existing ? JSON.parse(existing.value) : [];
        list.push(json);
        this.fallbackStore.set(key, {
          expiresAt: null,
          value: JSON.stringify(list),
        });
      },
    );
  }

  async popFromList(key: string): Promise<unknown | null> {
    return this.withRedisClient(
      async (client) => {
        const value = await client.rpop(key);
        return value ? JSON.parse(value) : null;
      },
      async () => {
        const existing = this.getFallbackValue(key);

        if (!existing) {
          return null;
        }

        const list: unknown[] = JSON.parse(existing.value);

        if (list.length === 0) {
          return null;
        }

        const item = list.shift();
        this.fallbackStore.set(key, {
          expiresAt: null,
          value: JSON.stringify(list),
        });
        return item ?? null;
      },
    );
  }

  async listLength(key: string): Promise<number> {
    return this.withRedisClient(
      async (client) => client.llen(key),
      async () => {
        const existing = this.getFallbackValue(key);

        if (!existing) {
          return 0;
        }

        return JSON.parse(existing.value).length;
      },
    );
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    const token = randomUUID();

    return this.withRedisClient(
      async (client) => {
        const result = await client.set(key, token, "EX", ttlSeconds, "NX");
        return result === "OK" ? token : null;
      },
      async () => {
        const existing = this.getFallbackValue(key);

        if (existing) {
          return null;
        }

        this.fallbackStore.set(key, {
          expiresAt: Date.now() + ttlSeconds * 1000,
          value: token,
        });

        return token;
      },
    );
  }

  async releaseLock(key: string, token: string) {
    await this.withRedisClient(
      async (client) => {
        await client.eval(
          `
            if redis.call("get", KEYS[1]) == ARGV[1] then
              return redis.call("del", KEYS[1])
            end
            return 0
          `,
          1,
          key,
          token,
        );
      },
      async () => {
        const existing = this.getFallbackValue(key);

        if (existing?.value === token) {
          this.fallbackStore.delete(key);
        }
      },
    );
  }

  isUsingFallback() {
    return this.fallbackEnabled;
  }

  private async withRedisClient<T>(
    operation: (client: Redis) => Promise<T>,
    fallbackOperation: () => Promise<T>,
  ): Promise<T> {
    if (this.fallbackEnabled) {
      return fallbackOperation();
    }

    try {
      return await operation(this.client);
    } catch (error) {
      if (!this.canUseFallback(error)) {
        throw error;
      }

      this.enableFallback(error);
      return fallbackOperation();
    }
  }

  private getFallbackValue(key: string) {
    const cachedValue = this.fallbackStore.get(key);

    if (!cachedValue) {
      return null;
    }

    if (cachedValue.expiresAt !== null && cachedValue.expiresAt <= Date.now()) {
      this.fallbackStore.delete(key);
      return null;
    }

    return cachedValue;
  }

  private enableFallback(error: unknown) {
    if (this.fallbackEnabled) {
      return;
    }

    this.fallbackEnabled = true;
    this.client.disconnect(false);
    this.logger.warn(
      `Redis is unavailable; using in-memory storage. Session cache, queues, and locks are per-process and not shared across replicas. ${this.describeError(error)}`,
    );
  }

  private canUseFallback(error: unknown) {
    return this.isRedisConnectionError(error);
  }

  private isRedisConnectionError(error: unknown) {
    if (!(error instanceof Error)) {
      return false;
    }

    const connectionCodes = new Set([
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "ETIMEDOUT",
    ]);

    const code = "code" in error ? String(error.code) : null;

    return (
      (code !== null && connectionCodes.has(code)) ||
      error.message.includes("Connection is closed") ||
      error.message.includes("connect ECONNREFUSED") ||
      error.message.includes("failed to connect")
    );
  }

  private describeError(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return "Unknown Redis error";
  }
}

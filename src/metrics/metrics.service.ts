import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { AppConfigService } from '../config/app-config.service.js';

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly httpRequests: Counter<'method' | 'route' | 'status_code'>;
  private readonly httpDuration: Histogram<'method' | 'route' | 'status_code'>;
  private readonly outboxEvents: Counter<'event_type' | 'outcome'>;
  private readonly businessEvents: Counter<'event_type'>;
  private readonly outboxBacklog: Gauge<'status'>;

  constructor(config: AppConfigService) {
    const service =
      process.env.METRICS_SERVICE_NAME?.trim() || config.service.name || 'amrutam-api';

    this.registry.setDefaultLabels({
      service,
      environment: config.nodeEnv,
      version: config.service.version,
    });

    collectDefaultMetrics({ register: this.registry, prefix: 'amrutam_' });

    this.httpRequests = new Counter({
      name: 'amrutam_http_requests_total',
      help: 'HTTP requests by method, route template and status code.',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.httpDuration = new Histogram({
      name: 'amrutam_http_request_duration_seconds',
      help: 'HTTP request latency by method, route template and status code.',
      labelNames: ['method', 'route', 'status_code'],
      buckets: HTTP_DURATION_BUCKETS,
      registers: [this.registry],
    });

    this.outboxEvents = new Counter({
      name: 'amrutam_outbox_events_total',
      help: 'Transactional outbox events by type and outcome.',
      labelNames: ['event_type', 'outcome'],
      registers: [this.registry],
    });

    this.businessEvents = new Counter({
      name: 'amrutam_business_events_total',
      help: 'Domain events observed by the outbox dispatcher.',
      labelNames: ['event_type'],
      registers: [this.registry],
    });

    this.outboxBacklog = new Gauge({
      name: 'amrutam_outbox_backlog',
      help: 'Current transactional outbox backlog by status.',
      labelNames: ['status'],
      registers: [this.registry],
    });
  }

  observeHttp(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = {
      method: method.toUpperCase(),
      route: route || 'unmatched',
      status_code: String(statusCode),
    };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, Math.max(durationSeconds, 0));
  }

  recordOutboxOutcome(eventType: string, outcome: 'processed' | 'retried' | 'dead_letter'): void {
    this.outboxEvents.inc({ event_type: eventType, outcome });
  }

  recordBusinessEvent(eventType: string): void {
    this.businessEvents.inc({ event_type: eventType });
  }

  setOutboxBacklog(status: string, value: number): void {
    this.outboxBacklog.set({ status }, Math.max(value, 0));
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}

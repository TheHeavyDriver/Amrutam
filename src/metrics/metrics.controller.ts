import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../common/auth/public.decorator.js';
import { MetricsService } from './metrics.service.js';

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    reply.header('Cache-Control', 'no-store');
    reply.type(this.metrics.contentType);
    return this.metrics.getMetrics();
  }
}

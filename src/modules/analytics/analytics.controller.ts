import { Controller, Get, Header, Query } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  analyticsRangeQuerySchema,
  analyticsSeriesQuerySchema,
  doctorUtilizationQuerySchema,
} from './analytics.schemas.js';
import type {
  AnalyticsRangeQuery,
  AnalyticsSeriesQuery,
  DoctorUtilizationQuery,
} from './analytics.schemas.js';
import { AnalyticsService } from './analytics.service.js';
import type {
  AnalyticsOverview,
  ConsultationsAnalytics,
  DoctorUtilizationResponse,
  RevenueAnalytics,
  SpecialtyAnalyticsResponse,
} from './analytics.types.js';

@Controller('admin/analytics')
@Roles('admin')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  @Header('Cache-Control', 'no-store')
  overview(
    @Query(new ZodValidationPipe(analyticsRangeQuerySchema)) query: AnalyticsRangeQuery,
  ): Promise<AnalyticsOverview> {
    return this.analyticsService.overview(query.from, query.to);
  }

  @Get('consultations')
  @Header('Cache-Control', 'no-store')
  consultations(
    @Query(new ZodValidationPipe(analyticsSeriesQuerySchema)) query: AnalyticsSeriesQuery,
  ): Promise<ConsultationsAnalytics> {
    return this.analyticsService.consultations(query.interval, query.from, query.to);
  }

  @Get('revenue')
  @Header('Cache-Control', 'no-store')
  revenue(
    @Query(new ZodValidationPipe(analyticsSeriesQuerySchema)) query: AnalyticsSeriesQuery,
  ): Promise<RevenueAnalytics> {
    return this.analyticsService.revenue(query.interval, query.from, query.to);
  }

  @Get('doctor-utilization')
  @Header('Cache-Control', 'no-store')
  doctorUtilization(
    @Query(new ZodValidationPipe(doctorUtilizationQuerySchema)) query: DoctorUtilizationQuery,
  ): Promise<DoctorUtilizationResponse> {
    return this.analyticsService.doctorUtilization(query.from, query.to, query.doctorId);
  }

  @Get('specialties')
  @Header('Cache-Control', 'no-store')
  specialties(
    @Query(new ZodValidationPipe(analyticsRangeQuerySchema)) query: AnalyticsRangeQuery,
  ): Promise<SpecialtyAnalyticsResponse> {
    return this.analyticsService.specialties(query.from, query.to);
  }
}

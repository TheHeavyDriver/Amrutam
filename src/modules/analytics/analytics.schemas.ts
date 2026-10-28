import { z } from 'zod';

export const analyticsRangeQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();

export const analyticsSeriesQuerySchema = analyticsRangeQuerySchema
  .extend({
    interval: z.enum(['day', 'week', 'month']).default('day'),
  })
  .strict();

export const doctorUtilizationQuerySchema = analyticsRangeQuerySchema
  .extend({
    doctorId: z.uuid().optional(),
  })
  .strict();

export type AnalyticsRangeQuery = z.infer<typeof analyticsRangeQuerySchema>;
export type AnalyticsSeriesQuery = z.infer<typeof analyticsSeriesQuerySchema>;
export type DoctorUtilizationQuery = z.infer<typeof doctorUtilizationQuerySchema>;

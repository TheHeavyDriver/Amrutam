import { z } from 'zod';

const notes = z.string().trim().max(2_000).optional();

export const createBookingSchema = z
  .object({
    slotId: z.uuid(),
    notes,
  })
  .strict();

export const cancelBookingSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const rescheduleBookingSchema = z
  .object({
    slotId: z.uuid(),
  })
  .strict();

export const completeConsultationSchema = z
  .object({
    diagnosis: z.string().trim().max(2_000).optional(),
    notes: z.string().trim().max(4_000).optional(),
  })
  .strict()
  .default({});

export const noShowSchema = z
  .object({
    notes: z.string().trim().max(1_000).optional(),
  })
  .strict()
  .default({});

export const listBookingsQuerySchema = z
  .object({
    status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled', 'no_show']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    cursor: z.string().min(1).max(2_000).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from < value.to, {
    message: 'from must be earlier than to',
    path: ['from'],
  });

export const consultationIdSchema = z.uuid();

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;
export type RescheduleBookingInput = z.infer<typeof rescheduleBookingSchema>;
export type CompleteConsultationInput = z.infer<typeof completeConsultationSchema>;
export type NoShowInput = z.infer<typeof noShowSchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;

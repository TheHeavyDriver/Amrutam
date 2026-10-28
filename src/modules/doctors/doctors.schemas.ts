import { z } from 'zod';

const cursor = z.string().min(1).max(2_000).optional();
const limit = z.coerce.number().int().min(1).max(50).default(20);
const dateTime = z.coerce.date();
const MIN_SLOT_DURATION_MS = 5 * 60_000;
const MAX_SLOT_DURATION_MS = 4 * 60 * 60_000;

export const listDoctorsQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(120).optional(),
    specialization: z.string().trim().min(2).max(120).optional(),
    language: z
      .string()
      .regex(/^[a-z]{2}$/, 'Expected an ISO 639-1 language code')
      .optional(),
    city: z.string().trim().min(1).max(120).optional(),
    minFeeCents: z.coerce.number().int().min(0).max(10_000_000).optional(),
    maxFeeCents: z.coerce.number().int().min(0).max(10_000_000).optional(),
    availableFrom: dateTime.optional(),
    availableTo: dateTime.optional(),
    sort: z.enum(['rating_desc', 'fee_asc', 'fee_desc', 'next_available']).default('rating_desc'),
    cursor,
    limit,
  })
  .strict()
  .refine(
    (value) =>
      value.minFeeCents === undefined ||
      value.maxFeeCents === undefined ||
      value.minFeeCents <= value.maxFeeCents,
    { message: 'minFeeCents must not exceed maxFeeCents', path: ['minFeeCents'] },
  )
  .refine(
    (value) =>
      !value.availableFrom || !value.availableTo || value.availableFrom < value.availableTo,
    { message: 'availableFrom must be earlier than availableTo', path: ['availableFrom'] },
  );

export const availabilityQuerySchema = z
  .object({
    from: dateTime.optional(),
    to: dateTime.optional(),
    cursor,
    limit,
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from < value.to, {
    message: 'from must be earlier than to',
    path: ['from'],
  });

export const doctorIdSchema = z.uuid();

export const createAvailabilitySlotSchema = z
  .object({
    startsAt: dateTime,
    endsAt: dateTime,
  })
  .strict()
  .superRefine((value, context) => {
    const duration = value.endsAt.getTime() - value.startsAt.getTime();

    if (duration < MIN_SLOT_DURATION_MS) {
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'A slot must be at least 5 minutes long',
      });
    }

    if (duration > MAX_SLOT_DURATION_MS) {
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'A slot cannot be longer than 4 hours',
      });
    }
  });

export const availabilitySlotIdSchema = z.uuid();

export type ListDoctorsQuery = z.infer<typeof listDoctorsQuerySchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
export type CreateAvailabilitySlotInput = z.infer<typeof createAvailabilitySlotSchema>;

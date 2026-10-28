import { z } from 'zod';

export const paymentProviderSchema = z.enum(['mock', 'razorpay', 'stripe']);

export const createPaymentSchema = z
  .object({
    provider: paymentProviderSchema,
    returnUrl: z.url().max(2_000).optional(),
  })
  .strict();

export const refundPaymentSchema = z
  .object({
    amount: z.number().int().min(1).optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const paymentIdSchema = z.uuid();

export const paymentWebhookSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    eventType: z.enum([
      'payment.authorized',
      'payment.captured',
      'payment.failed',
      'payment.refunded',
    ]),
    paymentId: z.uuid(),
    providerReference: z.string().min(1).max(200),
    amount: z.number().int().min(1).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    occurredAt: z.coerce.date(),
  })
  .strict();

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;
export type PaymentWebhookInput = z.infer<typeof paymentWebhookSchema>;
export type PaymentProviderPath = z.infer<typeof paymentProviderSchema>;

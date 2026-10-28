import { z } from 'zod';

const prescriptionItemSchema = z
  .object({
    medicationName: z.string().trim().min(1).max(200),
    dosage: z.string().trim().min(1).max(100),
    frequency: z.string().trim().min(1).max(100),
    durationDays: z.number().int().min(1).max(365),
    instructions: z.string().trim().max(500).optional(),
  })
  .strict();

export const createPrescriptionSchema = z
  .object({
    diagnosis: z.string().trim().min(1).max(2_000),
    notes: z.string().trim().max(4_000).optional(),
    items: z.array(prescriptionItemSchema).min(1).max(20),
  })
  .strict();

export const updatePrescriptionSchema = z
  .object({
    diagnosis: z.string().trim().min(1).max(2_000).optional(),
    notes: z.string().trim().max(4_000).nullable().optional(),
    items: z.array(prescriptionItemSchema).min(1).max(20).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be supplied',
  });

export const voidPrescriptionSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const prescriptionIdSchema = z.uuid();

export const listPrescriptionsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const prescriptionDocumentQuerySchema = z
  .object({
    expires: z.coerce.number().int().positive(),
    signature: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type CreatePrescriptionInput = z.infer<typeof createPrescriptionSchema>;
export type UpdatePrescriptionInput = z.infer<typeof updatePrescriptionSchema>;
export type VoidPrescriptionInput = z.infer<typeof voidPrescriptionSchema>;
export type ListPrescriptionsQuery = z.infer<typeof listPrescriptionsQuerySchema>;
export type PrescriptionDocumentQuery = z.infer<typeof prescriptionDocumentQuerySchema>;
export type PrescriptionItemInput = z.infer<typeof prescriptionItemSchema>;

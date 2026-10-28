import { z } from 'zod';

export const doctorVerificationStatusSchema = z.enum([
  'pending',
  'verified',
  'rejected',
  'suspended',
]);

export const adminDoctorListQuerySchema = z
  .object({
    verificationStatus: doctorVerificationStatusSchema.optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const doctorVerificationSchema = z
  .object({
    status: doctorVerificationStatusSchema,
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const adminDoctorIdSchema = z.uuid();

export type AdminDoctorListQuery = z.infer<typeof adminDoctorListQuerySchema>;
export type DoctorVerificationInput = z.infer<typeof doctorVerificationSchema>;
export type DoctorVerificationStatus = z.infer<typeof doctorVerificationStatusSchema>;

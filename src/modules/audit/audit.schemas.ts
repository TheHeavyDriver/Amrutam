import { z } from 'zod';

const from = z.coerce.date().optional();
const to = z.coerce.date().optional();

export const auditLogQuerySchema = z
  .object({
    actorId: z.uuid().optional(),
    action: z.string().trim().min(1).max(120).optional(),
    resourceType: z.string().trim().min(1).max(120).optional(),
    resourceId: z.string().trim().min(1).max(200).optional(),
    from,
    to,
    cursor: z.string().min(1).max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from < value.to, {
    message: 'from must be earlier than to',
    path: ['from'],
  });

export const auditVerifyQuerySchema = z
  .object({
    from,
    to,
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from < value.to, {
    message: 'from must be earlier than to',
    path: ['from'],
  });

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export type AuditVerifyQuery = z.infer<typeof auditVerifyQuerySchema>;

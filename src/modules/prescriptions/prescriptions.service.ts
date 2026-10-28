import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuthenticatedUser, RequestMetadata } from '../../common/auth/auth-user.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';
import {
  IdempotencyService,
  type IdempotentExecutionResult,
} from '../../common/idempotency/idempotency.service.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { decodePrescriptionCursor, encodePrescriptionCursor } from './prescriptions.cursor.js';
import type {
  CreatePrescriptionInput,
  ListPrescriptionsQuery,
  UpdatePrescriptionInput,
  VoidPrescriptionInput,
} from './prescriptions.schemas.js';
import type {
  Prescription,
  PrescriptionDocument,
  PrescriptionItem,
  PrescriptionListResponse,
  PrescriptionStatus,
} from './prescriptions.types.js';

const MAX_DOCUMENT_LINK_SKEW_SECONDS = 5;

interface PrescriptionRow {
  id: string;
  consultation_id: string;
  doctor_id: string;
  patient_id: string;
  status: PrescriptionStatus;
  version: number;
  diagnosis: string | null;
  notes: string | null;
  issued_at: Date | null;
  signed_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  document_url: string | null;
  document_sha256: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PrescriptionSignRow extends PrescriptionRow {
  doctor_full_name: string;
  patient_full_name: string;
  doctor_license_number: string;
  doctor_specialization: string;
  consultation_status: string;
}

interface PrescriptionItemRow {
  id: string;
  prescription_id: string;
  medication_name: string;
  dosage: string;
  frequency: string;
  duration_days: number;
  instructions: string | null;
  sort_order: number;
}

interface ConsultationAccessRow {
  patient_id: string;
  doctor_id: string;
  status: string;
}

interface DocumentRow {
  content: Buffer;
  content_type: string;
  sha256: string;
  status: PrescriptionStatus;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

@Injectable()
export class PrescriptionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  async create(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    consultationId: string,
    input: CreatePrescriptionInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Prescription>> {
    this.requireDoctor(user);

    return this.idempotency.execute<Prescription>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: `/bookings/${consultationId}/prescriptions`,
        body: input,
        request,
      },
      async (client) => {
        const consultation = await this.lockConsultation(client, consultationId);
        this.assertAssignedDoctor(user, consultation);

        if (consultation.status === 'cancelled' || consultation.status === 'no_show') {
          throw this.invalidTransition(
            'Prescriptions cannot be created for a cancelled or no-show consultation',
          );
        }

        const existingDraft = await client.query<{ id: string }>(
          `SELECT id FROM prescriptions
            WHERE consultation_id = $1 AND status = 'draft'
            LIMIT 1`,
          [consultationId],
        );

        if (existingDraft.rows[0]) {
          throw new ApiException(HttpStatus.CONFLICT, {
            code: ErrorCodes.PRESCRIPTION_DRAFT_EXISTS,
            message: 'A draft prescription already exists for this consultation',
          });
        }

        const versionResult = await client.query<{ version: number }>(
          `SELECT COALESCE(max(version), 0)::int + 1 AS version
             FROM prescriptions
            WHERE consultation_id = $1`,
          [consultationId],
        );
        const version = versionResult.rows[0]?.version ?? 1;

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO prescriptions (
             consultation_id, doctor_id, patient_id, status, version, diagnosis, notes
           ) VALUES ($1, $2, $3, 'draft', $4, $5, $6)
           RETURNING id`,
          [
            consultationId,
            user.id,
            consultation.patient_id,
            version,
            input.diagnosis,
            input.notes ?? null,
          ],
        );
        const prescriptionId = inserted.rows[0]?.id;

        if (!prescriptionId) {
          throw new Error('Failed to create prescription');
        }

        await this.insertItems(client, prescriptionId, input.items);
        const body = await this.loadPrescription(client, prescriptionId);

        await this.enqueue(client, prescriptionId, 'prescription.created', {
          prescriptionId,
          consultationId,
          doctorId: user.id,
          patientId: consultation.patient_id,
          version,
          status: 'draft',
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'prescription.created',
            resourceType: 'prescription',
            resourceId: prescriptionId,
            request,
            after: { status: 'draft', version, itemCount: input.items.length },
            metadata: { consultationId, version, itemCount: input.items.length },
          },
          client,
        );

        return { status: HttpStatus.CREATED, body };
      },
    );
  }

  async list(
    user: AuthenticatedUser,
    consultationId: string,
    query: ListPrescriptionsQuery,
  ): Promise<PrescriptionListResponse> {
    const consultation = await this.loadConsultationAccess(consultationId);
    this.assertConsultationAccess(user, consultation);

    const conditions = ['p.consultation_id = $1'];
    const values: unknown[] = [consultationId];

    if (query.cursor) {
      const cursor = decodePrescriptionCursor(query.cursor);
      values.push(new Date(cursor.createdAt));
      const createdAtParameter = `$${values.length}`;
      values.push(cursor.id);
      const idParameter = `$${values.length}`;
      conditions.push(
        `(p.created_at < ${createdAtParameter}::timestamptz ` +
          `OR (p.created_at = ${createdAtParameter}::timestamptz ` +
          `AND p.id < ${idParameter}::uuid))`,
      );
    }

    values.push(query.limit + 1);
    const limitParameter = `$${values.length}`;

    const { rows } = await this.database.query<PrescriptionRow>(
      `${this.prescriptionSelect()}
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${limitParameter}`,
      values,
    );

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const items = await this.loadItemsForPrescriptions(pageRows.map((row) => row.id));

    return {
      data: pageRows.map((row) => this.toPrescription(row, items.get(row.id) ?? [])),
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodePrescriptionCursor({
                v: 1,
                createdAt: last.created_at.toISOString(),
                id: last.id,
              })
            : null,
      },
    };
  }

  async get(user: AuthenticatedUser, prescriptionId: string): Promise<Prescription> {
    const prescription = await this.loadPrescription(null, prescriptionId);
    this.assertPrescriptionAccess(user, prescription);

    return prescription;
  }

  async update(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    prescriptionId: string,
    input: UpdatePrescriptionInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Prescription>> {
    this.requireDoctor(user);

    const result = await this.idempotency.execute<Prescription>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'PATCH',
        path: `/prescriptions/${prescriptionId}`,
        body: input,
        request,
      },
      async (client) => {
        const current = await this.lockPrescription(client, prescriptionId);
        this.assertPrescriptionOwner(user, current);

        if (current.status !== 'draft') {
          throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
            code: ErrorCodes.PRESCRIPTION_NOT_EDITABLE,
            message: 'Only draft prescriptions can be edited',
          });
        }

        await this.assertConsultationNotTerminal(client, current.consultation_id);

        const diagnosisProvided = input.diagnosis !== undefined;
        const notesProvided = Object.hasOwn(input, 'notes');

        await client.query(
          `UPDATE prescriptions
              SET diagnosis = CASE WHEN $2::boolean THEN $3 ELSE diagnosis END,
                  notes = CASE WHEN $4::boolean THEN $5 ELSE notes END
            WHERE id = $1`,
          [
            prescriptionId,
            diagnosisProvided,
            input.diagnosis ?? null,
            notesProvided,
            notesProvided ? (input.notes ?? null) : null,
          ],
        );

        if (input.items) {
          await client.query('DELETE FROM prescription_items WHERE prescription_id = $1', [
            prescriptionId,
          ]);
          await this.insertItems(client, prescriptionId, input.items);
        }

        const body = await this.loadPrescription(client, prescriptionId);

        await this.enqueue(client, prescriptionId, 'prescription.updated', {
          prescriptionId,
          consultationId: current.consultation_id,
          doctorId: current.doctor_id,
          patientId: current.patient_id,
          version: current.version,
          status: 'draft',
          itemCount: body.items.length,
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'prescription.updated',
            resourceType: 'prescription',
            resourceId: prescriptionId,
            request,
            before: { status: current.status, version: current.version },
            after: { status: 'draft', version: current.version, itemCount: body.items.length },
            metadata: {
              consultationId: current.consultation_id,
              version: current.version,
              diagnosisChanged: diagnosisProvided,
              notesChanged: notesProvided,
              itemsChanged: Boolean(input.items),
            },
          },
          client,
        );

        return { status: HttpStatus.OK, body };
      },
    );

    return { ...result, body: this.withFreshDocumentUrl(result.body) };
  }

  async sign(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    prescriptionId: string,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Prescription>> {
    this.requireDoctor(user);

    const result = await this.idempotency.execute<Prescription>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: `/prescriptions/${prescriptionId}/sign`,
        body: {},
        request,
      },
      async (client) => {
        const current = await this.lockSignRow(client, prescriptionId);
        this.assertPrescriptionOwner(user, current);

        if (current.status !== 'draft') {
          throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
            code: ErrorCodes.PRESCRIPTION_NOT_EDITABLE,
            message: 'Only draft prescriptions can be signed',
          });
        }

        if (
          current.consultation_status === 'cancelled' ||
          current.consultation_status === 'no_show'
        ) {
          throw this.invalidTransition(
            'Prescriptions cannot be signed for a cancelled or no-show consultation',
          );
        }

        const items = await this.loadItems(client, prescriptionId);

        if (items.length === 0) {
          throw this.invalidTransition(
            'A prescription must contain at least one item before signing',
          );
        }

        const signedAt = new Date();
        const content = this.renderDocument(current, items, signedAt);
        const documentBytes = Buffer.from(content, 'utf8');
        const sha256 = createHash('sha256').update(documentBytes).digest('hex');
        const documentUrl = this.documentPath(prescriptionId);

        await client.query(
          `UPDATE prescriptions
              SET status = 'signed',
                  issued_at = $2,
                  signed_at = $2,
                  document_url = $3,
                  document_sha256 = $4
            WHERE id = $1`,
          [prescriptionId, signedAt, documentUrl, sha256],
        );
        await client.query(
          `INSERT INTO prescription_documents (
             prescription_id, content_type, content, sha256
           ) VALUES ($1, 'text/html; charset=utf-8', $2, $3)`,
          [prescriptionId, documentBytes, sha256],
        );

        const body = await this.loadPrescription(client, prescriptionId);

        await this.enqueue(client, prescriptionId, 'prescription.signed', {
          prescriptionId,
          consultationId: current.consultation_id,
          doctorId: current.doctor_id,
          patientId: current.patient_id,
          version: current.version,
          documentSha256: sha256,
          itemCount: items.length,
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'prescription.signed',
            resourceType: 'prescription',
            resourceId: prescriptionId,
            request,
            before: { status: 'draft', version: current.version },
            after: {
              status: 'signed',
              version: current.version,
              itemCount: items.length,
              documentSha256: sha256,
            },
            metadata: {
              consultationId: current.consultation_id,
              version: current.version,
              itemCount: items.length,
              documentSha256: sha256,
            },
          },
          client,
        );

        return { status: HttpStatus.OK, body };
      },
    );

    return { ...result, body: this.withFreshDocumentUrl(result.body) };
  }

  async void(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    prescriptionId: string,
    input: VoidPrescriptionInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Prescription>> {
    if (user.role !== 'doctor' && user.role !== 'admin') {
      throw new ApiException(HttpStatus.FORBIDDEN, {
        code: ErrorCodes.FORBIDDEN,
        message: 'Only the assigned doctor or an administrator can void a prescription',
      });
    }

    const result = await this.idempotency.execute<Prescription>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: `/prescriptions/${prescriptionId}/void`,
        body: input,
        request,
      },
      async (client) => {
        const current = await this.lockPrescription(client, prescriptionId);

        if (user.role === 'doctor') {
          this.assertPrescriptionOwner(user, current);
        }

        if (current.status !== 'signed') {
          throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
            code: ErrorCodes.PRESCRIPTION_NOT_EDITABLE,
            message: 'Only signed prescriptions can be voided',
          });
        }

        await client.query(
          `UPDATE prescriptions
              SET status = 'voided',
                  voided_at = now(),
                  void_reason = $2
            WHERE id = $1`,
          [prescriptionId, input.reason],
        );

        const body = await this.loadPrescription(client, prescriptionId);

        await this.enqueue(client, prescriptionId, 'prescription.voided', {
          prescriptionId,
          consultationId: current.consultation_id,
          doctorId: current.doctor_id,
          patientId: current.patient_id,
          version: current.version,
          voidedBy: user.id,
          voidedByRole: user.role,
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'prescription.voided',
            resourceType: 'prescription',
            resourceId: prescriptionId,
            request,
            before: { status: 'signed', version: current.version },
            after: { status: 'voided', version: current.version },
            metadata: {
              consultationId: current.consultation_id,
              version: current.version,
              voidedByRole: user.role,
            },
          },
          client,
        );

        return { status: HttpStatus.OK, body };
      },
    );

    return { ...result, body: this.withFreshDocumentUrl(result.body) };
  }

  async getDocument(
    user: AuthenticatedUser,
    prescriptionId: string,
  ): Promise<PrescriptionDocument> {
    const prescription = await this.loadPrescription(null, prescriptionId);
    this.assertPrescriptionAccess(user, prescription);

    if (
      (prescription.status !== 'signed' && prescription.status !== 'voided') ||
      !prescription.document
    ) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Signed prescription document not found',
      });
    }

    return prescription.document;
  }

  async downloadDocument(
    prescriptionId: string,
    expires: number,
    signature: string,
    request: RequestMetadata,
  ): Promise<{ content: Buffer; contentType: string; sha256: string }> {
    this.verifyDocumentSignature(prescriptionId, expires, signature);

    const { rows } = await this.database.query<DocumentRow>(
      `SELECT pd.content,
              pd.content_type,
              pd.sha256,
              p.status
         FROM prescription_documents pd
         JOIN prescriptions p ON p.id = pd.prescription_id
        WHERE pd.prescription_id = $1`,
      [prescriptionId],
    );
    const row = rows[0];

    if (!row || (row.status !== 'signed' && row.status !== 'voided')) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Signed prescription document not found',
      });
    }

    await this.audit.record({
      actorId: null,
      actorRole: null,
      action: 'prescription.document_accessed',
      resourceType: 'prescription',
      resourceId: prescriptionId,
      request,
      metadata: { documentSha256: row.sha256 },
    });

    return { content: row.content, contentType: row.content_type, sha256: row.sha256 };
  }

  private async insertItems(
    client: PoolClient,
    prescriptionId: string,
    items: Array<{
      medicationName: string;
      dosage: string;
      frequency: string;
      durationDays: number;
      instructions?: string;
    }>,
  ): Promise<void> {
    for (const [index, item] of items.entries()) {
      await client.query(
        `INSERT INTO prescription_items (
           prescription_id, medication_name, dosage, frequency,
           duration_days, instructions, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          prescriptionId,
          item.medicationName,
          item.dosage,
          item.frequency,
          item.durationDays,
          item.instructions ?? null,
          index,
        ],
      );
    }
  }

  private prescriptionSelect(): string {
    return `SELECT p.id,
                   p.consultation_id,
                   p.doctor_id,
                   p.patient_id,
                   p.status,
                   p.version,
                   p.diagnosis,
                   p.notes,
                   p.issued_at,
                   p.signed_at,
                   p.voided_at,
                   p.void_reason,
                   p.document_url,
                   p.document_sha256,
                   p.created_at,
                   p.updated_at
              FROM prescriptions p`;
  }

  private async loadPrescription(
    client: PoolClient | null,
    prescriptionId: string,
  ): Promise<Prescription> {
    const sql = `${this.prescriptionSelect()} WHERE p.id = $1`;
    const result = client
      ? await client.query<PrescriptionRow>(sql, [prescriptionId])
      : await this.database.query<PrescriptionRow>(sql, [prescriptionId]);
    const row = result.rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Prescription not found',
      });
    }

    const items = await this.loadItems(client, prescriptionId);
    return this.toPrescription(row, items);
  }

  private async lockPrescription(
    client: PoolClient,
    prescriptionId: string,
  ): Promise<PrescriptionRow> {
    const { rows } = await client.query<PrescriptionRow>(
      `${this.prescriptionSelect()} WHERE p.id = $1 FOR UPDATE OF p`,
      [prescriptionId],
    );
    const row = rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Prescription not found',
      });
    }

    return row;
  }

  private async lockSignRow(
    client: PoolClient,
    prescriptionId: string,
  ): Promise<PrescriptionSignRow> {
    const { rows } = await client.query<PrescriptionSignRow>(
      `SELECT p.id,
              p.consultation_id,
              p.doctor_id,
              p.patient_id,
              p.status,
              p.version,
              p.diagnosis,
              p.notes,
              p.issued_at,
              p.signed_at,
              p.voided_at,
              p.void_reason,
              p.document_url,
              p.document_sha256,
              p.created_at,
              p.updated_at,
              dp.full_name AS doctor_full_name,
              pp.full_name AS patient_full_name,
              d.license_number AS doctor_license_number,
              d.specialization AS doctor_specialization,
              c.status::text AS consultation_status
         FROM prescriptions p
         JOIN profiles dp ON dp.user_id = p.doctor_id
         JOIN profiles pp ON pp.user_id = p.patient_id
         JOIN doctors d ON d.user_id = p.doctor_id
         JOIN consultations c ON c.id = p.consultation_id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [prescriptionId],
    );
    const row = rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Prescription not found',
      });
    }

    return row;
  }

  private async loadItems(
    client: PoolClient | null,
    prescriptionId: string,
  ): Promise<PrescriptionItem[]> {
    const sql = `SELECT id, prescription_id, medication_name, dosage, frequency,
                        duration_days, instructions, sort_order
                   FROM prescription_items
                  WHERE prescription_id = $1
                  ORDER BY sort_order ASC`;
    const result = client
      ? await client.query<PrescriptionItemRow>(sql, [prescriptionId])
      : await this.database.query<PrescriptionItemRow>(sql, [prescriptionId]);

    return result.rows.map((row) => this.toItem(row));
  }

  private async loadItemsForPrescriptions(
    prescriptionIds: string[],
  ): Promise<Map<string, PrescriptionItem[]>> {
    const map = new Map<string, PrescriptionItem[]>();

    if (prescriptionIds.length === 0) {
      return map;
    }

    const { rows } = await this.database.query<PrescriptionItemRow>(
      `SELECT id, prescription_id, medication_name, dosage, frequency,
              duration_days, instructions, sort_order
         FROM prescription_items
        WHERE prescription_id = ANY($1::uuid[])
        ORDER BY prescription_id, sort_order ASC`,
      [prescriptionIds],
    );

    for (const row of rows) {
      const items = map.get(row.prescription_id) ?? [];
      items.push(this.toItem(row));
      map.set(row.prescription_id, items);
    }

    return map;
  }

  private async lockConsultation(
    client: PoolClient,
    consultationId: string,
  ): Promise<ConsultationAccessRow> {
    const { rows } = await client.query<ConsultationAccessRow>(
      `SELECT patient_id, doctor_id, status::text AS status
         FROM consultations
        WHERE id = $1
        FOR UPDATE`,
      [consultationId],
    );
    const row = rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Consultation not found',
      });
    }

    return row;
  }

  private async loadConsultationAccess(consultationId: string): Promise<ConsultationAccessRow> {
    const { rows } = await this.database.query<ConsultationAccessRow>(
      `SELECT patient_id, doctor_id, status::text AS status
         FROM consultations
        WHERE id = $1`,
      [consultationId],
    );
    const row = rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Consultation not found',
      });
    }

    return row;
  }

  private async assertConsultationNotTerminal(
    client: PoolClient,
    consultationId: string,
  ): Promise<void> {
    const { rows } = await client.query<{ status: string }>(
      'SELECT status::text AS status FROM consultations WHERE id = $1',
      [consultationId],
    );
    const status = rows[0]?.status;

    if (status === 'cancelled' || status === 'no_show') {
      throw this.invalidTransition('The consultation is no longer active');
    }
  }

  private assertConsultationAccess(
    user: AuthenticatedUser,
    consultation: Pick<ConsultationAccessRow, 'patient_id' | 'doctor_id'>,
  ): void {
    if (user.role === 'admin') {
      return;
    }

    if (user.role === 'patient' && consultation.patient_id === user.id) {
      return;
    }

    if (user.role === 'doctor' && consultation.doctor_id === user.id) {
      return;
    }

    throw new ApiException(HttpStatus.FORBIDDEN, {
      code: ErrorCodes.FORBIDDEN,
      message: 'You do not have permission to access this consultation',
    });
  }

  private assertPrescriptionAccess(
    user: AuthenticatedUser,
    prescription: Pick<Prescription, 'patientId' | 'doctorId'>,
  ): void {
    if (user.role === 'admin') {
      return;
    }

    if (user.role === 'patient' && prescription.patientId === user.id) {
      return;
    }

    if (user.role === 'doctor' && prescription.doctorId === user.id) {
      return;
    }

    throw new ApiException(HttpStatus.FORBIDDEN, {
      code: ErrorCodes.FORBIDDEN,
      message: 'You do not have permission to access this prescription',
    });
  }

  private assertPrescriptionOwner(
    user: AuthenticatedUser,
    prescription: Pick<PrescriptionRow, 'doctor_id'>,
  ): void {
    if (user.role !== 'doctor' || prescription.doctor_id !== user.id) {
      throw new ApiException(HttpStatus.FORBIDDEN, {
        code: ErrorCodes.FORBIDDEN,
        message: 'Only the prescribing doctor can perform this action',
      });
    }
  }

  private assertAssignedDoctor(
    user: AuthenticatedUser,
    consultation: Pick<ConsultationAccessRow, 'doctor_id'>,
  ): void {
    if (user.role !== 'doctor' || consultation.doctor_id !== user.id) {
      throw new ApiException(HttpStatus.FORBIDDEN, {
        code: ErrorCodes.FORBIDDEN,
        message: 'Only the assigned doctor can prescribe for this consultation',
      });
    }
  }

  private requireDoctor(user: AuthenticatedUser): void {
    if (user.role !== 'doctor') {
      throw new ApiException(HttpStatus.FORBIDDEN, {
        code: ErrorCodes.FORBIDDEN,
        message: 'Only doctors can perform this action',
      });
    }
  }

  private toPrescription(row: PrescriptionRow, items: PrescriptionItem[]): Prescription {
    return {
      id: row.id,
      consultationId: row.consultation_id,
      doctorId: row.doctor_id,
      patientId: row.patient_id,
      status: row.status,
      version: row.version,
      diagnosis: row.diagnosis,
      notes: row.notes,
      issuedAt: iso(row.issued_at),
      signedAt: iso(row.signed_at),
      voidedAt: iso(row.voided_at),
      voidReason: row.void_reason,
      document:
        row.document_sha256 && (row.status === 'signed' || row.status === 'voided')
          ? this.documentLink(row.id, row.document_sha256)
          : null,
      items,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private toItem(row: PrescriptionItemRow): PrescriptionItem {
    return {
      id: row.id,
      medicationName: row.medication_name,
      dosage: row.dosage,
      frequency: row.frequency,
      durationDays: row.duration_days,
      instructions: row.instructions,
      sortOrder: row.sort_order,
    };
  }

  private withFreshDocumentUrl(prescription: Prescription): Prescription {
    if (!prescription.document) {
      return prescription;
    }

    return {
      ...prescription,
      document: this.documentLink(prescription.id, prescription.document.sha256),
    };
  }

  private documentPath(prescriptionId: string): string {
    return `/${this.config.http.globalPrefix}/prescriptions/${prescriptionId}/document/content`;
  }

  private documentLink(prescriptionId: string, sha256: string): PrescriptionDocument {
    const expires =
      Math.floor(Date.now() / 1_000) + this.config.prescriptions.documentUrlTtlSeconds;
    const signature = this.signDocument(prescriptionId, expires);
    const url = new URL(this.documentPath(prescriptionId), this.config.service.publicUrl);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', signature);

    return {
      url: url.toString(),
      sha256,
      expiresAt: new Date(expires * 1_000).toISOString(),
    };
  }

  private signDocument(prescriptionId: string, expires: number): string {
    return createHmac('sha256', this.config.auth.secrets.tokenPepper)
      .update(`prescription-document:v1:${prescriptionId}:${expires}`)
      .digest('hex');
  }

  private verifyDocumentSignature(
    prescriptionId: string,
    expires: number,
    signature: string,
  ): void {
    const now = Math.floor(Date.now() / 1_000);

    if (expires < now) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.TOKEN_EXPIRED,
        message: 'The prescription document link has expired',
      });
    }

    if (
      expires >
      now + this.config.prescriptions.documentUrlTtlSeconds + MAX_DOCUMENT_LINK_SKEW_SECONDS
    ) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.INVALID_TOKEN,
        message: 'The prescription document link is invalid',
      });
    }

    const expected = this.signDocument(prescriptionId, expires);
    const expectedBuffer = Buffer.from(expected, 'hex');
    let suppliedBuffer: Buffer;

    try {
      suppliedBuffer = Buffer.from(signature, 'hex');
    } catch {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.INVALID_TOKEN,
        message: 'The prescription document link is invalid',
      });
    }

    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(suppliedBuffer, expectedBuffer)
    ) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.INVALID_TOKEN,
        message: 'The prescription document link is invalid',
      });
    }
  }

  private renderDocument(
    row: PrescriptionSignRow,
    items: PrescriptionItem[],
    signedAt: Date,
  ): string {
    const itemRows = items
      .map(
        (item) => `<tr>
          <td>${item.sortOrder + 1}</td>
          <td>${escapeHtml(item.medicationName)}</td>
          <td>${escapeHtml(item.dosage)}</td>
          <td>${escapeHtml(item.frequency)}</td>
          <td>${item.durationDays} day${item.durationDays === 1 ? '' : 's'}</td>
          <td>${item.instructions ? escapeHtml(item.instructions) : '&mdash;'}</td>
        </tr>`,
      )
      .join('\n');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Prescription ${escapeHtml(row.id)}</title>
  <style>
    body { font-family: Georgia, 'Times New Roman', serif; color: #18211b; margin: 2.5rem; line-height: 1.5; }
    header { border-bottom: 2px solid #2f5d46; margin-bottom: 1.5rem; padding-bottom: 1rem; }
    h1 { font-size: 1.75rem; margin: 0 0 .35rem; color: #204b37; }
    .muted { color: #5b6b61; font-size: .9rem; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1.5rem 0; }
    .label { font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: #5b6b61; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; font-size: .92rem; }
    th, td { border-bottom: 1px solid #d7e0da; padding: .65rem .5rem; text-align: left; vertical-align: top; }
    th { background: #edf3ef; }
    section { margin: 1.25rem 0; }
    footer { border-top: 1px solid #d7e0da; margin-top: 2.5rem; padding-top: 1rem; font-size: .85rem; color: #5b6b61; }
    .signature { font-family: 'Brush Script MT', cursive; font-size: 1.5rem; color: #204b37; }
  </style>
</head>
<body>
  <header>
    <h1>Amrutam Medical Prescription</h1>
    <div class="muted">Electronically signed clinical document</div>
  </header>
  <div class="grid">
    <div><div class="label">Prescribing doctor</div><div>${escapeHtml(row.doctor_full_name)}</div><div class="muted">${escapeHtml(row.doctor_specialization)} &middot; License ${escapeHtml(row.doctor_license_number)}</div></div>
    <div><div class="label">Patient</div><div>${escapeHtml(row.patient_full_name)}</div><div class="muted">Prescription version ${row.version}</div></div>
  </div>
  <section>
    <div class="label">Diagnosis</div>
    <div>${escapeHtml(row.diagnosis ?? 'Not recorded')}</div>
  </section>
  <section>
    <div class="label">Medications</div>
    <table>
      <thead><tr><th>#</th><th>Medication</th><th>Dosage</th><th>Frequency</th><th>Duration</th><th>Instructions</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
  </section>
  <section>
    <div class="label">Clinical notes</div>
    <div>${escapeHtml(row.notes ?? 'None')}</div>
  </section>
  <footer>
    <div class="signature">${escapeHtml(row.doctor_full_name)}</div>
    <div>Signed ${escapeHtml(signedAt.toISOString())} &middot; Prescription ${escapeHtml(row.id)}</div>
    <div>This document was generated electronically and is accompanied by an auditable SHA-256 checksum.</div>
  </footer>
</body>
</html>`;
  }

  private async enqueue(
    client: PoolClient,
    prescriptionId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('prescription', $1, $2, $3::jsonb)`,
      [prescriptionId, eventType, JSON.stringify(payload)],
    );
  }

  private invalidTransition(message: string): ApiException {
    return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
      code: ErrorCodes.INVALID_STATE_TRANSITION,
      message,
    });
  }
}

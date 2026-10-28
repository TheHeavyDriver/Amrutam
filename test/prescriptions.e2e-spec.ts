import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpCode } from '../src/common/security/totp.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { LoginResponse, SessionResponse } from '../src/modules/auth/auth.types.js';
import type { AvailabilitySlot, DoctorSummary } from '../src/modules/doctors/doctors.types.js';
import type { Consultation } from '../src/modules/bookings/bookings.types.js';
import type {
  Prescription,
  PrescriptionDocument,
  PrescriptionListResponse,
} from '../src/modules/prescriptions/prescriptions.types.js';
import { createTestApp } from './utils/create-test-app.js';

const DEMO_PASSWORD = 'DemoPass!2026';
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const DOCUMENT_PEPPER = 'test-pepper-that-is-at-least-32-characters';
const RUN_ID = randomUUID().slice(0, 8);

interface ErrorResponse {
  error: { code: string; message: string };
}

function uniqueEmail(label: string): string {
  return `prescription.${RUN_ID}.${label}.${randomUUID().slice(0, 8)}@example.test`;
}

function uniquePhone(): string {
  return `+9196${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
}

function key(label: string): string {
  return `prescription-${RUN_ID}-${label}-${randomUUID()}`;
}

function isSession(response: LoginResponse): response is SessionResponse {
  return 'accessToken' in response;
}

describe('Prescriptions (e2e)', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let patient: SessionResponse;
  let otherPatient: SessionResponse;
  let doctor: SessionResponse;
  let admin: SessionResponse;
  let doctorSummary: DoctorSummary;
  let consultation: Consultation;
  let prescription: Prescription;
  let signedDocument: PrescriptionDocument;
  const diagnosis = `Acute migraine <follow-up> ${randomUUID()}`;
  const notes = `Private prescription note ${randomUUID()}`;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);

    patient = await registerPatient('one');
    otherPatient = await registerPatient('two');
    doctor = await login('aarav.mehta@amrutam.local');
    admin = await login('admin@amrutam.local');

    const doctors = await app.inject({
      method: 'GET',
      url: '/api/v1/doctors?specialization=Cardiology&limit=1',
    });
    expect(doctors.statusCode, doctors.body).toBe(200);
    doctorSummary = doctors.json<{ data: DoctorSummary[] }>().data[0] as DoctorSummary;

    const slot = await reserveSlot();
    const booking = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: headers(patient.accessToken, key('booking')),
      payload: { slotId: slot.id },
    });
    expect(booking.statusCode, booking.body).toBe(201);
    consultation = booking.json<Consultation>();

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/start`,
      headers: headers(doctor.accessToken, key('start')),
    });
    expect(started.statusCode, started.body).toBe(200);
    consultation = started.json<Consultation>();
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerPatient(label: string): Promise<SessionResponse> {
    const email = uniqueEmail(label);
    const registration = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email,
        password: DEMO_PASSWORD,
        fullName: `Prescription Patient ${label}`,
        phone: uniquePhone(),
        acceptedTerms: true,
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);

    return login(email);
  }

  async function login(email: string): Promise<SessionResponse> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: DEMO_PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<LoginResponse>();

    if (isSession(body)) {
      return body;
    }

    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { mfaToken: body.mfaToken, code: generateTotpCode(DEMO_TOTP_SECRET) },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    return verified.json<SessionResponse>();
  }

  async function reserveSlot(): Promise<AvailabilitySlot> {
    const from = new Date();
    const to = new Date(from.getTime() + 30 * 86_400_000);
    const response = await app.inject({
      method: 'GET',
      url:
        `/api/v1/doctors/${doctorSummary.id}/availability?` +
        new URLSearchParams({
          from: from.toISOString(),
          to: to.toISOString(),
          limit: '50',
        }).toString(),
    });
    expect(response.statusCode, response.body).toBe(200);
    const slot = response.json<{ data: AvailabilitySlot[] }>().data[0];

    if (!slot) {
      throw new Error('Expected an available slot');
    }

    return slot;
  }

  function headers(token: string, idempotencyKey?: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    };
  }

  it('creates a draft idempotently and limits drafts to the assigned doctor', async () => {
    const createKey = key('create');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/prescriptions`,
      headers: headers(doctor.accessToken, createKey),
      payload: {
        diagnosis,
        notes,
        items: [
          {
            medicationName: 'Sumatriptan',
            dosage: '50 mg',
            frequency: 'Twice daily as needed',
            durationDays: 5,
            instructions: 'Take at the onset of a migraine.',
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    prescription = response.json<Prescription>();
    expect(prescription).toMatchObject({
      consultationId: consultation.id,
      doctorId: doctor.user.id,
      patientId: patient.user.id,
      status: 'draft',
      version: 1,
      document: null,
    });
    expect(prescription.items).toHaveLength(1);

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/prescriptions`,
      headers: headers(doctor.accessToken, createKey),
      payload: {
        diagnosis,
        notes,
        items: [
          {
            medicationName: 'Sumatriptan',
            dosage: '50 mg',
            frequency: 'Twice daily as needed',
            durationDays: 5,
            instructions: 'Take at the onset of a migraine.',
          },
        ],
      },
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<Prescription>().id).toBe(prescription.id);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/prescriptions`,
      headers: headers(doctor.accessToken, key('duplicate-draft')),
      payload: {
        diagnosis,
        items: [
          { medicationName: 'Ibuprofen', dosage: '200 mg', frequency: 'Once', durationDays: 1 },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<ErrorResponse>().error.code).toBe('PRESCRIPTION_DRAFT_EXISTS');

    const patientCreate = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/prescriptions`,
      headers: headers(patient.accessToken, key('patient-create')),
      payload: {
        diagnosis,
        items: [
          { medicationName: 'Ibuprofen', dosage: '200 mg', frequency: 'Once', durationDays: 1 },
        ],
      },
    });
    expect(patientCreate.statusCode).toBe(403);

    const missingKey = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/prescriptions`,
      headers: headers(doctor.accessToken),
      payload: {
        diagnosis,
        items: [
          { medicationName: 'Ibuprofen', dosage: '200 mg', frequency: 'Once', durationDays: 1 },
        ],
      },
    });
    expect(missingKey.statusCode).toBe(400);
  });

  it('edits drafts idempotently and rejects edits from other roles', async () => {
    const updateKey = key('update');
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/prescriptions/${prescription.id}`,
      headers: headers(doctor.accessToken, updateKey),
      payload: {
        notes: null,
        items: [
          {
            medicationName: 'Sumatriptan',
            dosage: '100 mg',
            frequency: 'Once daily',
            durationDays: 3,
            instructions: 'Take with water.',
          },
          {
            medicationName: 'Paracetamol',
            dosage: '500 mg',
            frequency: 'Every 8 hours',
            durationDays: 2,
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const updated = response.json<Prescription>();
    expect(updated.notes).toBeNull();
    expect(updated.items).toHaveLength(2);
    expect(updated.items[0]?.sortOrder).toBe(0);
    expect(updated.items[1]?.sortOrder).toBe(1);
    expect(updated.updatedAt >= prescription.updatedAt).toBe(true);

    const replay = await app.inject({
      method: 'PATCH',
      url: `/api/v1/prescriptions/${prescription.id}`,
      headers: headers(doctor.accessToken, updateKey),
      payload: {
        notes: null,
        items: [
          {
            medicationName: 'Sumatriptan',
            dosage: '100 mg',
            frequency: 'Once daily',
            durationDays: 3,
            instructions: 'Take with water.',
          },
          {
            medicationName: 'Paracetamol',
            dosage: '500 mg',
            frequency: 'Every 8 hours',
            durationDays: 2,
          },
        ],
      },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<Prescription>().items).toHaveLength(2);

    const patientUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/prescriptions/${prescription.id}`,
      headers: headers(patient.accessToken, key('patient-update')),
      payload: { diagnosis: 'Not allowed' },
    });
    expect(patientUpdate.statusCode).toBe(403);

    const emptyUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/prescriptions/${prescription.id}`,
      headers: headers(doctor.accessToken, key('empty-update')),
      payload: {},
    });
    expect(emptyUpdate.statusCode).toBe(400);

    prescription = updated;
  });

  it('signs idempotently and creates an immutable checksummed artifact', async () => {
    const signKey = key('sign');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/prescriptions/${prescription.id}/sign`,
      headers: headers(doctor.accessToken, signKey),
    });
    expect(response.statusCode, response.body).toBe(200);
    const signed = response.json<Prescription>();
    expect(signed.status).toBe('signed');
    expect(signed.issuedAt).not.toBeNull();
    expect(signed.signedAt).toBe(signed.issuedAt);
    expect(signed.document?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.document?.url).toContain(`/prescriptions/${prescription.id}/document/content`);
    expect(signed.document?.expiresAt).toBeTruthy();
    signedDocument = signed.document as PrescriptionDocument;
    prescription = signed;

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/prescriptions/${prescription.id}/sign`,
      headers: headers(doctor.accessToken, signKey),
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<Prescription>().document?.sha256).toBe(signed.document?.sha256);

    const stored = await database.query<{
      content: Buffer;
      sha256: string;
      content_type: string;
    }>(
      'SELECT content, sha256, content_type FROM prescription_documents WHERE prescription_id = $1',
      [prescription.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.content_type).toBe('text/html; charset=utf-8');
    expect(
      createHash('sha256')
        .update(stored.rows[0]?.content as Buffer)
        .digest('hex'),
    ).toBe(stored.rows[0]?.sha256);
    const html = (stored.rows[0]?.content as Buffer).toString('utf8');
    expect(html).toContain('Acute migraine &lt;follow-up&gt;');
    expect(html).toContain('Sumatriptan');

    await expect(
      database.query('UPDATE prescriptions SET diagnosis = $2 WHERE id = $1', [
        prescription.id,
        'Tampered diagnosis',
      ]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      database.query('DELETE FROM prescription_items WHERE prescription_id = $1', [
        prescription.id,
      ]),
    ).rejects.toThrow(/cannot change after signing/i);

    const signedEdit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/prescriptions/${prescription.id}`,
      headers: headers(doctor.accessToken, key('signed-edit')),
      payload: { diagnosis: 'Tampered diagnosis' },
    });
    expect(signedEdit.statusCode).toBe(422);
    expect(signedEdit.json<ErrorResponse>().error.code).toBe('PRESCRIPTION_NOT_EDITABLE');

    const secondSign = await app.inject({
      method: 'POST',
      url: `/api/v1/prescriptions/${prescription.id}/sign`,
      headers: headers(doctor.accessToken, key('second-sign')),
    });
    expect(secondSign.statusCode).toBe(422);

    const audit = await database.query<{ metadata_text: string }>(
      `SELECT metadata::text AS metadata_text
         FROM audit_logs
        WHERE resource_id = $1 AND action = 'prescription.signed'`,
      [prescription.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.metadata_text).not.toContain('Acute migraine');
    expect(audit.rows[0]?.metadata_text).not.toContain('Sumatriptan');
    expect(audit.rows[0]?.metadata_text).not.toContain(notes);

    const outbox = await database.query<{ payload_text: string }>(
      `SELECT payload::text AS payload_text
         FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'prescription.signed'`,
      [prescription.id],
    );
    expect(outbox.rows[0]?.payload_text).not.toContain('Acute migraine');
    expect(outbox.rows[0]?.payload_text).not.toContain('Sumatriptan');
  });

  it('serves signed documents through tamper-evident short-lived links', async () => {
    const metadata = await app.inject({
      method: 'GET',
      url: `/api/v1/prescriptions/${prescription.id}/document`,
      headers: headers(patient.accessToken),
    });
    expect(metadata.statusCode, metadata.body).toBe(200);
    const document = metadata.json<PrescriptionDocument>();
    expect(document.sha256).toBe(signedDocument.sha256);
    expect(new Date(document.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const parsed = new URL(document.url);
    const download = await app.inject({
      method: 'GET',
      url: `${parsed.pathname}${parsed.search}`,
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-type']).toContain('text/html');
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['content-security-policy']).toContain('sandbox');
    expect(createHash('sha256').update(download.rawPayload).digest('hex')).toBe(document.sha256);
    expect(download.body).toContain('Acute migraine &lt;follow-up&gt;');

    const tampered = new URL(document.url);
    tampered.searchParams.set('signature', '0'.repeat(64));
    const tamperedResponse = await app.inject({
      method: 'GET',
      url: `${tampered.pathname}${tampered.search}`,
    });
    expect(tamperedResponse.statusCode).toBe(401);
    expect(tamperedResponse.json<ErrorResponse>().error.code).toBe('INVALID_TOKEN');

    const expired = Math.floor(Date.now() / 1_000) - 5;
    const expiredSignature = createHmac('sha256', DOCUMENT_PEPPER)
      .update(`prescription-document:v1:${prescription.id}:${expired}`)
      .digest('hex');
    const expiredResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/prescriptions/${prescription.id}/document/content?expires=${expired}&signature=${expiredSignature}`,
    });
    expect(expiredResponse.statusCode).toBe(401);
    expect(expiredResponse.json<ErrorResponse>().error.code).toBe('TOKEN_EXPIRED');

    const otherPatientDocument = await app.inject({
      method: 'GET',
      url: `/api/v1/prescriptions/${prescription.id}/document`,
      headers: headers(otherPatient.accessToken),
    });
    expect(otherPatientDocument.statusCode).toBe(403);

    const adminDocument = await app.inject({
      method: 'GET',
      url: `/api/v1/prescriptions/${prescription.id}/document`,
      headers: headers(admin.accessToken),
    });
    expect(adminDocument.statusCode, adminDocument.body).toBe(200);

    const accessAudit = await database.query<{ action: string }>(
      `SELECT action FROM audit_logs
        WHERE resource_id = $1 AND action = 'prescription.document_accessed'`,
      [prescription.id],
    );
    expect(accessAudit.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('voids a signed prescription without changing its artifact, then allows a new version', async () => {
    const voidKey = key('void');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/prescriptions/${prescription.id}/void`,
      headers: headers(doctor.accessToken, voidKey),
      payload: { reason: 'Medication changed after review' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const voided = response.json<Prescription>();
    expect(voided.status).toBe('voided');
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidReason).toBe('Medication changed after review');
    expect(voided.signedAt).toBe(prescription.signedAt);
    expect(voided.document?.sha256).toBe(signedDocument.sha256);

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/prescriptions/${prescription.id}/void`,
      headers: headers(doctor.accessToken, voidKey),
      payload: { reason: 'Medication changed after review' },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');

    const voidedEdit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/prescriptions/${prescription.id}`,
      headers: headers(doctor.accessToken, key('voided-edit')),
      payload: { diagnosis: 'Still not editable' },
    });
    expect(voidedEdit.statusCode).toBe(422);

    const voidedDownload = await app.inject({
      method: 'GET',
      url: `${new URL((voided.document as PrescriptionDocument).url).pathname}${
        new URL((voided.document as PrescriptionDocument).url).search
      }`,
    });
    expect(voidedDownload.statusCode, voidedDownload.body).toBe(200);
    expect(createHash('sha256').update(voidedDownload.rawPayload).digest('hex')).toBe(
      signedDocument.sha256,
    );

    const nextVersion = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/prescriptions`,
      headers: headers(doctor.accessToken, key('version-two')),
      payload: {
        diagnosis: 'Revised diagnosis',
        items: [
          { medicationName: 'Paracetamol', dosage: '500 mg', frequency: 'Once', durationDays: 1 },
        ],
      },
    });
    expect(nextVersion.statusCode, nextVersion.body).toBe(201);
    expect(nextVersion.json<Prescription>().version).toBe(2);
    expect(nextVersion.json<Prescription>().status).toBe('draft');
  });

  it('lists prescription history with access control and stable cursors', async () => {
    const firstPageResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${consultation.id}/prescriptions?limit=1`,
      headers: headers(patient.accessToken),
    });
    expect(firstPageResponse.statusCode, firstPageResponse.body).toBe(200);
    const firstPage = firstPageResponse.json<PrescriptionListResponse>();
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.data[0]?.version).toBe(2);
    expect(firstPage.page.hasMore).toBe(true);
    expect(firstPage.page.nextCursor).toBeTruthy();

    const secondPageResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${consultation.id}/prescriptions?limit=1&cursor=${encodeURIComponent(
        firstPage.page.nextCursor as string,
      )}`,
      headers: headers(patient.accessToken),
    });
    expect(secondPageResponse.statusCode, secondPageResponse.body).toBe(200);
    const secondPage = secondPageResponse.json<PrescriptionListResponse>();
    expect(secondPage.data[0]?.version).toBe(1);
    expect(secondPage.data[0]?.status).toBe('voided');
    expect(secondPage.data[0]?.id).not.toBe(firstPage.data[0]?.id);

    const otherPatientList = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${consultation.id}/prescriptions`,
      headers: headers(otherPatient.accessToken),
    });
    expect(otherPatientList.statusCode).toBe(403);

    const adminList = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${consultation.id}/prescriptions`,
      headers: headers(admin.accessToken),
    });
    expect(adminList.statusCode, adminList.body).toBe(200);
    expect(adminList.json<PrescriptionListResponse>().data).toHaveLength(2);

    const invalidCursor = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${consultation.id}/prescriptions?cursor=not-a-cursor`,
      headers: headers(patient.accessToken),
    });
    expect(invalidCursor.statusCode).toBe(400);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/prescriptions/${prescription.id}`,
      headers: headers(patient.accessToken),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<Prescription>().status).toBe('voided');
  });
});

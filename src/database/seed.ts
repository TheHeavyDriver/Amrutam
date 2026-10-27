import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import { deterministicUuid } from './ids.js';

const IST_OFFSET_MINUTES = 330;
const DAY_MS = 86_400_000;

// Demo-only material. Task 5 replaces these with real Argon2id hashes and
// encrypted TOTP secrets. They are deliberately unusable as credentials.
const SEED_PASSWORD_HASH = 'disabled:seeded-account-requires-auth-setup';
const SEED_MFA_SECRET = 'seed-placeholder:not-a-real-encrypted-secret';
const SEED_VERIFIED_AT = new Date('2026-01-15T00:00:00.000Z');

interface DoctorSeed {
  email: string;
  fullName: string;
  phone: string;
  licenseNumber: string;
  specialization: string;
  subSpecialties: string[];
  languages: string[];
  yearsExperience: number;
  feeCents: number;
  city: string;
  rating: number;
  ratingCount: number;
  bio: string;
}

interface PatientSeed {
  email: string;
  fullName: string;
  phone: string;
  dateOfBirth: string;
  gender: 'female' | 'male' | 'non_binary' | 'prefer_not_to_say';
}

interface SlotInput {
  id: string;
  doctorId: string;
  startsAt: Date;
  endsAt: Date;
  status: 'available' | 'booked';
}

const DOCTORS: DoctorSeed[] = [
  {
    email: 'aarav.mehta@amrutam.local',
    fullName: 'Dr. Aarav Mehta',
    phone: '+919700000001',
    licenseNumber: 'AMR-DOC-2026-0001',
    specialization: 'Cardiology',
    subSpecialties: ['Interventional cardiology', 'Heart failure'],
    languages: ['en', 'hi', 'gu'],
    yearsExperience: 14,
    feeCents: 120_000,
    city: 'Mumbai',
    rating: 4.9,
    ratingCount: 210,
    bio: 'Consultant cardiologist focused on preventive heart care and hypertension.',
  },
  {
    email: 'diya.nair@amrutam.local',
    fullName: 'Dr. Diya Nair',
    phone: '+919700000002',
    licenseNumber: 'AMR-DOC-2026-0002',
    specialization: 'Dermatology',
    subSpecialties: ['Clinical dermatology', 'Paediatric dermatology'],
    languages: ['en', 'ml', 'hi'],
    yearsExperience: 9,
    feeCents: 80_000,
    city: 'Kochi',
    rating: 4.8,
    ratingCount: 164,
    bio: 'Dermatologist treating acne, eczema, pigmentation, and hair disorders.',
  },
  {
    email: 'kabir.sharma@amrutam.local',
    fullName: 'Dr. Kabir Sharma',
    phone: '+919700000003',
    licenseNumber: 'AMR-DOC-2026-0003',
    specialization: 'General Medicine',
    subSpecialties: ['Primary care', 'Diabetes management'],
    languages: ['en', 'hi'],
    yearsExperience: 11,
    feeCents: 50_000,
    city: 'Delhi',
    rating: 4.7,
    ratingCount: 320,
    bio: 'General physician providing first-line care and chronic disease follow-up.',
  },
  {
    email: 'meera.iyer@amrutam.local',
    fullName: 'Dr. Meera Iyer',
    phone: '+919700000004',
    licenseNumber: 'AMR-DOC-2026-0004',
    specialization: 'Paediatrics',
    subSpecialties: ['Newborn care', 'Child nutrition'],
    languages: ['en', 'ta', 'hi'],
    yearsExperience: 16,
    feeCents: 90_000,
    city: 'Chennai',
    rating: 4.9,
    ratingCount: 280,
    bio: 'Paediatrician supporting newborn health, growth, and childhood infections.',
  },
  {
    email: 'rohan.desai@amrutam.local',
    fullName: 'Dr. Rohan Desai',
    phone: '+919700000005',
    licenseNumber: 'AMR-DOC-2026-0005',
    specialization: 'Orthopaedics',
    subSpecialties: ['Sports medicine', 'Joint replacement'],
    languages: ['en', 'hi', 'gu'],
    yearsExperience: 12,
    feeCents: 110_000,
    city: 'Ahmedabad',
    rating: 4.6,
    ratingCount: 150,
    bio: 'Orthopaedic surgeon focused on sports injuries and musculoskeletal pain.',
  },
  {
    email: 'ananya.bose@amrutam.local',
    fullName: 'Dr. Ananya Bose',
    phone: '+919700000006',
    licenseNumber: 'AMR-DOC-2026-0006',
    specialization: 'Psychiatry',
    subSpecialties: ['Anxiety disorders', 'Cognitive behavioural therapy'],
    languages: ['en', 'bn', 'hi'],
    yearsExperience: 8,
    feeCents: 75_000,
    city: 'Kolkata',
    rating: 4.8,
    ratingCount: 95,
    bio: 'Psychiatrist supporting anxiety, depression, sleep, and stress-related concerns.',
  },
  {
    email: 'vihaan.reddy@amrutam.local',
    fullName: 'Dr. Vihaan Reddy',
    phone: '+919700000007',
    licenseNumber: 'AMR-DOC-2026-0007',
    specialization: 'Endocrinology',
    subSpecialties: ['Thyroid disorders', 'Diabetes management'],
    languages: ['en', 'te', 'hi'],
    yearsExperience: 13,
    feeCents: 95_000,
    city: 'Hyderabad',
    rating: 4.7,
    ratingCount: 120,
    bio: 'Endocrinologist managing thyroid, metabolic, and hormonal conditions.',
  },
  {
    email: 'saanvi.kulkarni@amrutam.local',
    fullName: 'Dr. Saanvi Kulkarni',
    phone: '+919700000008',
    licenseNumber: 'AMR-DOC-2026-0008',
    specialization: 'Gynaecology',
    subSpecialties: ['Reproductive health', 'Adolescent gynaecology'],
    languages: ['en', 'mr', 'hi'],
    yearsExperience: 15,
    feeCents: 100_000,
    city: 'Pune',
    rating: 4.9,
    ratingCount: 230,
    bio: 'Gynaecologist offering compassionate care across reproductive life stages.',
  },
];

const PATIENT_NAMES = [
  'Aditi Sharma',
  'Vivaan Patel',
  'Ishaan Gupta',
  'Ananya Singh',
  'Advik Joshi',
  'Kiara Menon',
  'Reyansh Rao',
  'Myra Kapoor',
  'Arjun Verma',
  'Sara Khan',
  'Dhruv Malhotra',
  'Aarohi Das',
  'Krishna Pillai',
  'Nitya Jain',
  'Ayaan Ahmed',
  'Riya Mishra',
  'Ved Chawla',
  'Tara Shetty',
  'Neil Fernandes',
  'Zoya Bhat',
];

const GENDERS: PatientSeed['gender'][] = [
  'female',
  'male',
  'male',
  'female',
  'male',
  'female',
  'male',
  'female',
  'male',
  'female',
  'male',
  'female',
  'male',
  'female',
  'male',
  'female',
  'male',
  'female',
  'male',
  'female',
];

const DIAGNOSES = [
  'Seasonal viral infection',
  'Hypertension follow-up',
  'Iron deficiency anaemia',
  'Migraine without aura',
  'Type 2 diabetes review',
  'Allergic rhinitis',
  'Mechanical lower back pain',
  'Generalised anxiety disorder',
];

const MEDICATIONS = [
  {
    name: 'Paracetamol',
    dosage: '500 mg',
    frequency: 'Twice daily',
    durationDays: 3,
    instructions: 'After food',
  },
  {
    name: 'Cetirizine',
    dosage: '10 mg',
    frequency: 'Once at night',
    durationDays: 5,
    instructions: 'May cause drowsiness',
  },
  {
    name: 'Vitamin D3',
    dosage: '60,000 IU',
    frequency: 'Weekly',
    durationDays: 28,
    instructions: 'Take with a fatty meal',
  },
  {
    name: 'Amlodipine',
    dosage: '5 mg',
    frequency: 'Once daily',
    durationDays: 30,
    instructions: 'Monitor blood pressure',
  },
  {
    name: 'Pantoprazole',
    dosage: '40 mg',
    frequency: 'Once before breakfast',
    durationDays: 14,
    instructions: 'Take 30 minutes before food',
  },
  {
    name: 'Metformin',
    dosage: '500 mg',
    frequency: 'Twice daily',
    durationDays: 30,
    instructions: 'After meals',
  },
];

function write(message: string): void {
  process.stdout.write(`${message}\n`);
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function istCalendarDate(offsetDays: number): {
  dateString: string;
  weekday: number;
} {
  const nowIst = new Date(Date.now() + IST_OFFSET_MINUTES * 60_000 + offsetDays * DAY_MS);
  const year = nowIst.getUTCFullYear();
  const month = nowIst.getUTCMonth() + 1;
  const day = nowIst.getUTCDate();

  return {
    dateString: `${year}-${pad2(month)}-${pad2(day)}`,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function istTimestamp(dateString: string, hour: number, minute: number): Date {
  const [year, month, day] = dateString.split('-').map(Number) as [number, number, number];

  // IST is UTC+05:30.
  return new Date(Date.UTC(year, month - 1, day, hour - 5, minute - 30));
}

function patientDateOfBirth(index: number): string {
  const year = 1975 + ((index * 7) % 28);
  const month = (index % 12) + 1;
  const day = ((index * 3) % 27) + 1;

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function patientSeed(index: number): PatientSeed {
  return {
    email: `patient${index + 1}@amrutam.local`,
    fullName: PATIENT_NAMES[index] ?? `Patient ${index + 1}`,
    phone: `+9198000000${pad2(index + 1)}`,
    dateOfBirth: patientDateOfBirth(index),
    gender: GENDERS[index] ?? 'prefer_not_to_say',
  };
}

async function query<Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  const result = await client.query<Row, unknown[]>(text, values);
  return result.rows;
}

async function upsertUser(
  client: PoolClient,
  input: {
    id: string;
    email: string;
    role: 'patient' | 'doctor' | 'admin';
    mfaEnabled: boolean;
    mfaSecret: string | null;
  },
): Promise<string> {
  const rows = await query<{ id: string }>(
    client,
    `
      INSERT INTO users (
        id, email, password_hash, role, status, email_verified_at,
        mfa_enabled, mfa_secret_encrypted
      )
      VALUES ($1, $2, $3, $4, 'active', now(), $5, $6)
      ON CONFLICT (email) DO UPDATE SET
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        email_verified_at = EXCLUDED.email_verified_at,
        mfa_enabled = EXCLUDED.mfa_enabled,
        mfa_secret_encrypted = EXCLUDED.mfa_secret_encrypted
      RETURNING id
    `,
    [input.id, input.email, SEED_PASSWORD_HASH, input.role, input.mfaEnabled, input.mfaSecret],
  );

  const row = rows[0];

  if (!row) {
    throw new Error(`Failed to seed user ${input.email}`);
  }

  return row.id;
}

async function upsertProfile(
  client: PoolClient,
  input: {
    userId: string;
    fullName: string;
    phone: string;
    dateOfBirth?: string | null;
    gender?: string | null;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO profiles (user_id, full_name, date_of_birth, phone, gender, locale, timezone)
      VALUES ($1, $2, $3, $4, $5, 'en-IN', 'Asia/Kolkata')
      ON CONFLICT (user_id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        date_of_birth = EXCLUDED.date_of_birth,
        phone = EXCLUDED.phone,
        gender = EXCLUDED.gender,
        locale = EXCLUDED.locale,
        timezone = EXCLUDED.timezone
    `,
    [input.userId, input.fullName, input.dateOfBirth ?? null, input.phone, input.gender ?? null],
  );
}

async function upsertDoctor(
  client: PoolClient,
  userId: string,
  doctor: DoctorSeed,
  verifiedBy: string,
): Promise<void> {
  await client.query(
    `
      INSERT INTO doctors (
        user_id, license_number, specialization, sub_specialties, languages,
        years_experience, consultation_fee_cents, consultation_duration_minutes,
        city, country_code, bio, verification_status, verified_at, verified_by,
        rating, rating_count, timezone, accepting_new_patients
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, 30,
        $8, 'IN', $9, 'verified', $10, $11,
        $12, $13, 'Asia/Kolkata', true
      )
      ON CONFLICT (user_id) DO UPDATE SET
        license_number = EXCLUDED.license_number,
        specialization = EXCLUDED.specialization,
        sub_specialties = EXCLUDED.sub_specialties,
        languages = EXCLUDED.languages,
        years_experience = EXCLUDED.years_experience,
        consultation_fee_cents = EXCLUDED.consultation_fee_cents,
        consultation_duration_minutes = EXCLUDED.consultation_duration_minutes,
        city = EXCLUDED.city,
        country_code = EXCLUDED.country_code,
        bio = EXCLUDED.bio,
        verification_status = EXCLUDED.verification_status,
        verified_at = EXCLUDED.verified_at,
        verified_by = EXCLUDED.verified_by,
        rating = EXCLUDED.rating,
        rating_count = EXCLUDED.rating_count,
        timezone = EXCLUDED.timezone,
        accepting_new_patients = EXCLUDED.accepting_new_patients
    `,
    [
      userId,
      doctor.licenseNumber,
      doctor.specialization,
      doctor.subSpecialties,
      doctor.languages,
      doctor.yearsExperience,
      doctor.feeCents,
      doctor.city,
      doctor.bio,
      SEED_VERIFIED_AT,
      verifiedBy,
      doctor.rating,
      doctor.ratingCount,
    ],
  );
}

async function upsertSlot(client: PoolClient, slot: SlotInput): Promise<string> {
  const rows = await query<{ id: string }>(
    client,
    `
      INSERT INTO availability_slots (id, doctor_id, starts_at, ends_at, status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (doctor_id, starts_at) DO UPDATE SET status = availability_slots.status
      RETURNING id
    `,
    [slot.id, slot.doctorId, slot.startsAt, slot.endsAt, slot.status],
  );

  const row = rows[0];

  if (!row) {
    throw new Error(`Failed to seed slot ${slot.id}`);
  }

  return row.id;
}

async function seedAvailableSlots(
  client: PoolClient,
  doctors: Array<{ id: string; index: number }>,
): Promise<void> {
  const times = [
    [9, 0],
    [9, 30],
    [10, 0],
    [10, 30],
    [11, 0],
    [11, 30],
    [14, 0],
    [14, 30],
    [15, 0],
    [15, 30],
    [16, 0],
    [16, 30],
  ] as const;

  for (let offset = 0; offset < 14; offset += 1) {
    const { dateString, weekday } = istCalendarDate(offset);

    if (weekday === 0 || weekday === 6) {
      continue;
    }

    for (const [hour, minute] of times) {
      const startsAt = istTimestamp(dateString, hour, minute);

      if (startsAt.getTime() <= Date.now()) {
        continue;
      }

      const endsAt = new Date(startsAt.getTime() + 30 * 60_000);

      for (const doctor of doctors) {
        await upsertSlot(client, {
          id: deterministicUuid(`slot:${doctor.index}:${dateString}:${hour}:${minute}`),
          doctorId: doctor.id,
          startsAt,
          endsAt,
          status: 'available',
        });
      }
    }
  }
}

async function seedHistoricalConsultations(
  client: PoolClient,
  doctors: Array<{ id: string; index: number; feeCents: number }>,
  patients: Array<{ id: string; index: number }>,
): Promise<void> {
  for (let dayOffset = 1; dayOffset <= 14; dayOffset += 1) {
    const { dateString } = istCalendarDate(-dayOffset);

    for (let slotIndex = 0; slotIndex < 2; slotIndex += 1) {
      const seedIndex = dayOffset * 2 + slotIndex;
      const doctor = doctors[seedIndex % doctors.length];
      const patient = patients[seedIndex % patients.length];

      if (!doctor || !patient) {
        continue;
      }

      const startHour = 18;
      const startMinute = slotIndex * 30;
      const startsAt = istTimestamp(dateString, startHour, startMinute);
      const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
      const startedAt = new Date(startsAt.getTime() + 2 * 60_000);
      const endedAt = new Date(startsAt.getTime() + 28 * 60_000);
      const consultationId = deterministicUuid(`consultation:${dateString}:${slotIndex}`);
      const slotId = await upsertSlot(client, {
        id: deterministicUuid(`history-slot:${dateString}:${slotIndex}`),
        doctorId: doctor.id,
        startsAt,
        endsAt,
        status: 'booked',
      });

      await client.query(
        `
          INSERT INTO consultations (
            id, patient_id, doctor_id, slot_id, status,
            scheduled_start, scheduled_end, fee_cents, currency,
            started_at, ended_at, diagnosis, notes
          )
          VALUES (
            $1, $2, $3, $4, 'completed',
            $5, $6, $7, 'INR',
            $8, $9, $10, $11
          )
          ON CONFLICT (id) DO NOTHING
        `,
        [
          consultationId,
          patient.id,
          doctor.id,
          slotId,
          startsAt,
          endsAt,
          doctor.feeCents,
          startedAt,
          endedAt,
          DIAGNOSES[seedIndex % DIAGNOSES.length],
          'Follow-up advised if symptoms persist.',
        ],
      );

      await client.query(
        `
          INSERT INTO consultation_slot_claims (slot_id, consultation_id)
          VALUES ($1, $2)
          ON CONFLICT (slot_id) DO NOTHING
        `,
        [slotId, consultationId],
      );

      const prescriptionId = deterministicUuid(`prescription:${dateString}:${slotIndex}`);
      const prescriptionRows = await query<{ id: string }>(
        client,
        `
          INSERT INTO prescriptions (
            id, consultation_id, doctor_id, patient_id, status, version,
            diagnosis, notes
          )
          VALUES ($1, $2, $3, $4, 'draft', 1, $5, $6)
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `,
        [
          prescriptionId,
          consultationId,
          doctor.id,
          patient.id,
          DIAGNOSES[seedIndex % DIAGNOSES.length],
          'Complete the course as prescribed.',
        ],
      );

      let prescriptionStatus: string | undefined;

      if (prescriptionRows.length === 0) {
        const existing = await query<{ status: string }>(
          client,
          'SELECT status FROM prescriptions WHERE id = $1',
          [prescriptionId],
        );
        prescriptionStatus = existing[0]?.status;
      }

      if (prescriptionRows.length > 0 || prescriptionStatus === 'draft') {
        for (let itemIndex = 0; itemIndex < 2; itemIndex += 1) {
          const medication = MEDICATIONS[(seedIndex + itemIndex) % MEDICATIONS.length];

          if (!medication) {
            continue;
          }

          await client.query(
            `
              INSERT INTO prescription_items (
                id, prescription_id, medication_name, dosage, frequency,
                duration_days, instructions, sort_order
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (prescription_id, sort_order) DO NOTHING
            `,
            [
              deterministicUuid(`prescription-item:${dateString}:${slotIndex}:${itemIndex}`),
              prescriptionId,
              medication.name,
              medication.dosage,
              medication.frequency,
              medication.durationDays,
              medication.instructions,
              itemIndex,
            ],
          );
        }

        await client.query(
          `
            UPDATE prescriptions
            SET
              status = 'signed',
              issued_at = $2,
              signed_at = $3,
              document_url = $4,
              document_sha256 = $5
            WHERE id = $1 AND status = 'draft'
          `,
          [
            prescriptionId,
            new Date(endedAt.getTime() + 5 * 60_000),
            new Date(endedAt.getTime() + 6 * 60_000),
            `s3://amrutam-seed/prescriptions/${prescriptionId}.pdf`,
            createHash('sha256').update(`prescription:${prescriptionId}`).digest('hex'),
          ],
        );
      }

      await client.query(
        `
          INSERT INTO payments (
            id, consultation_id, patient_id, amount_cents, currency,
            status, provider, provider_reference, authorized_at, captured_at
          )
          VALUES ($1, $2, $3, $4, 'INR', 'captured', 'mock', $5, $6, $7)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          deterministicUuid(`payment:${dateString}:${slotIndex}`),
          consultationId,
          patient.id,
          doctor.feeCents,
          `seed-payment-${dateString}-${slotIndex}`,
          new Date(endedAt.getTime() + 6 * 60_000),
          new Date(endedAt.getTime() + 7 * 60_000),
        ],
      );

      await client.query(
        `
          INSERT INTO outbox_events (
            id, aggregate_type, aggregate_id, event_type, payload,
            status, dispatched_at
          )
          VALUES ($1, 'consultation', $2, 'consultation.completed', $3::jsonb, 'dispatched', $4)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          deterministicUuid(`outbox:consultation-completed:${dateString}:${slotIndex}`),
          consultationId,
          JSON.stringify({
            consultationId,
            patientId: patient.id,
            doctorId: doctor.id,
            completedAt: endedAt.toISOString(),
          }),
          new Date(endedAt.getTime() + 8 * 60_000),
        ],
      );
    }
  }
}

async function seed(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW !== 'true') {
    throw new Error('Refusing to seed a production database without SEED_ALLOW=true');
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to seed the database');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: 'amrutam-seed',
  });
  const client = await pool.connect();

  try {
    const tableCheck = await query<{ users_table: string | null }>(
      client,
      "SELECT to_regclass('public.users')::text AS users_table",
    );

    if (!tableCheck[0]?.users_table) {
      throw new Error('Database schema is not migrated; run `npm run db:migrate` first');
    }

    await client.query('BEGIN');

    const adminId = await upsertUser(client, {
      id: deterministicUuid('user:admin'),
      email: 'admin@amrutam.local',
      role: 'admin',
      mfaEnabled: true,
      mfaSecret: SEED_MFA_SECRET,
    });

    await upsertProfile(client, {
      userId: adminId,
      fullName: 'Amrutam Administrator',
      phone: '+919900000001',
    });

    const doctors: Array<{ id: string; index: number; feeCents: number }> = [];

    for (const [index, doctor] of DOCTORS.entries()) {
      const userId = await upsertUser(client, {
        id: deterministicUuid(`user:doctor:${index}`),
        email: doctor.email,
        role: 'doctor',
        mfaEnabled: true,
        mfaSecret: SEED_MFA_SECRET,
      });

      await upsertProfile(client, {
        userId,
        fullName: doctor.fullName,
        phone: doctor.phone,
      });

      await upsertDoctor(client, userId, doctor, adminId);
      doctors.push({ id: userId, index, feeCents: doctor.feeCents });
    }

    const patients: Array<{ id: string; index: number }> = [];

    for (let index = 0; index < PATIENT_NAMES.length; index += 1) {
      const patient = patientSeed(index);
      const userId = await upsertUser(client, {
        id: deterministicUuid(`user:patient:${index}`),
        email: patient.email,
        role: 'patient',
        mfaEnabled: false,
        mfaSecret: null,
      });

      await upsertProfile(client, {
        userId,
        fullName: patient.fullName,
        phone: patient.phone,
        dateOfBirth: patient.dateOfBirth,
        gender: patient.gender,
      });

      patients.push({ id: userId, index });
    }

    await seedAvailableSlots(client, doctors);
    await seedHistoricalConsultations(client, doctors, patients);

    await client.query('COMMIT');

    const counts = await query<{
      users: number;
      doctors: number;
      patients: number;
      slots: number;
      consultations: number;
      prescriptions: number;
      payments: number;
    }>(
      client,
      `
        SELECT
          (SELECT count(*)::int FROM users) AS users,
          (SELECT count(*)::int FROM doctors) AS doctors,
          (SELECT count(*)::int FROM users WHERE role = 'patient') AS patients,
          (SELECT count(*)::int FROM availability_slots) AS slots,
          (SELECT count(*)::int FROM consultations) AS consultations,
          (SELECT count(*)::int FROM prescriptions) AS prescriptions,
          (SELECT count(*)::int FROM payments) AS payments
      `,
    );

    const summary = counts[0];

    write(
      summary
        ? `Seeded demo dataset: ${summary.users} users, ${summary.doctors} doctors, ` +
            `${summary.patients} patients, ${summary.slots} slots, ` +
            `${summary.consultations} consultations, ${summary.prescriptions} prescriptions, ` +
            `${summary.payments} payments.`
        : 'Seed completed.',
    );
    write('Authentication is wired in task 5; seeded password hashes are intentionally disabled.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

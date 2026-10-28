import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = (__ENV.API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const PASSWORD = __ENV.DEMO_PASSWORD || 'DemoPass!2026';
const PATIENT_COUNT = Number(__ENV.PATIENT_COUNT || 20);

export const options = {
  scenarios: {
    browse: {
      executor: 'constant-vus',
      exec: 'browse',
      vus: Number(__ENV.BROWSE_VUS || 50),
      duration: __ENV.BROWSE_DURATION || '2m',
    },
    book_cancel: {
      executor: 'ramping-vus',
      exec: 'bookAndCancel',
      startTime: '10s',
      stages: [
        { duration: '20s', target: Number(__ENV.WRITE_VUS || 10) },
        { duration: '40s', target: Number(__ENV.WRITE_VUS || 10) },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:browse}': ['p(95)<200', 'p(99)<500'],
    'http_req_duration{scenario:book_cancel}': ['p(95)<500', 'p(99)<1200'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  const sessions = [];
  let doctorId;

  for (let index = 1; index <= PATIENT_COUNT; index += 1) {
    const login = http.post(
      `${BASE_URL}/api/v1/auth/login`,
      JSON.stringify({ email: `patient${index}@amrutam.local`, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    if (login.status !== 200) {
      throw new Error(`Seeded patient login failed for patient${index}: ${login.status}`);
    }

    sessions.push(login.json('accessToken'));

    if (!doctorId) {
      const doctors = http.get(`${BASE_URL}/api/v1/doctors?specialization=Cardiology&limit=1`);
      if (doctors.status !== 200 || doctors.json('data').length === 0) {
        throw new Error('No seeded Cardiology doctor found; run db:seed first');
      }
      doctorId = doctors.json('data.0.id');
    }
  }

  return { sessions, doctorId };
}

export function browse(data) {
  const list = http.get(`${BASE_URL}/api/v1/doctors?specialization=Cardiology&limit=10`);
  check(list, {
    'doctor search 200': (response) => response.status === 200,
    'doctor search has data': (response) => Array.isArray(response.json('data')),
  });

  const from = new Date();
  const to = new Date(from.getTime() + 7 * 86_400_000);
  const availability = http.get(
    `${BASE_URL}/api/v1/doctors/${data.doctorId}/availability?` +
      `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=20`,
  );
  check(availability, {
    'availability 200': (response) => response.status === 200,
    'availability has slots': (response) => Array.isArray(response.json('data')),
  });

  sleep(Math.random() * 0.5 + 0.1);
}

export function bookAndCancel(data) {
  const token = data.sessions[(__VU - 1) % data.sessions.length];
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const from = new Date();
  const to = new Date(from.getTime() + 14 * 86_400_000);
  const availability = http.get(
    `${BASE_URL}/api/v1/doctors/${data.doctorId}/availability?` +
      `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=100`,
  );

  if (availability.status !== 200) {
    check(availability, { 'availability 200': () => false });
    return;
  }

  const slots = availability.json('data');
  if (!Array.isArray(slots) || slots.length === 0) {
    return;
  }

  const slot = slots[Math.floor(Math.random() * slots.length)];
  const booking = http.post(`${BASE_URL}/api/v1/bookings`, JSON.stringify({ slotId: slot.id }), {
    headers: { ...headers, 'Idempotency-Key': uuid() },
  });

  const booked = check(booking, {
    'booking created': (response) => response.status === 201 || response.status === 409,
  });

  if (!booked || booking.status !== 201) {
    return;
  }

  const consultationId = booking.json('id');
  const cancel = http.post(
    `${BASE_URL}/api/v1/bookings/${consultationId}/cancel`,
    JSON.stringify({ reason: 'k6 load test cleanup' }),
    { headers: { ...headers, 'Idempotency-Key': uuid() } },
  );
  check(cancel, { 'booking cancelled': (response) => response.status === 200 });

  sleep(Math.random() * 0.5 + 0.2);
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = (Math.random() * 16) | 0;
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

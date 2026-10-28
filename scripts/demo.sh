#!/usr/bin/env bash
set -euo pipefail

# End-to-end demo: login -> doctor search -> availability -> booking -> payment
# -> cancellation. Requires curl, jq, and a running seeded API. The worker is
# not required for the synchronous steps; run it to observe the async refund.
: "${API_BASE_URL:=http://localhost:3000}"
BASE="${API_BASE_URL%/}/api/v1"
EMAIL="${DEMO_EMAIL:-patient1@amrutam.local}"
PASSWORD="${DEMO_PASSWORD:-DemoPass!2026}"
SPECIALIZATION="${DEMO_SPECIALIZATION:-Cardiology}"

for command in curl jq node; do
  command -v "$command" >/dev/null || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done

key() { node -e "console.log(crypto.randomUUID())"; }

login=$(curl -fsS -X POST "$BASE/auth/login" \
  -H 'content-type: application/json' \
  -d "$(jq -cn --arg email "$EMAIL" --arg password "$PASSWORD" '{email:$email,password:$password}')")
token=$(jq -r '.accessToken // empty' <<<"$login")
if [[ -z "$token" ]]; then
  echo "Login did not return an access token (MFA may be required for this account)." >&2
  exit 1
fi

doctor=$(curl -fsS "$BASE/doctors?specialization=${SPECIALIZATION}&limit=1" | jq -r '.data[0].id // empty')
[[ -n "$doctor" ]] || {
  echo "No doctor found for specialization $SPECIALIZATION" >&2
  exit 1
}

from=$(node -e 'console.log(new Date().toISOString())')
to=$(node -e 'console.log(new Date(Date.now() + 7 * 86400000).toISOString())')
slot=$(curl -fsS "$BASE/doctors/${doctor}/availability?from=$(jq -rn --arg v "$from" '$v|@uri')&to=$(jq -rn --arg v "$to" '$v|@uri')&limit=1" | jq -r '.data[0].id // empty')
[[ -n "$slot" ]] || {
  echo "No available slot in the next 7 days" >&2
  exit 1
}

consultation=$(curl -fsS -X POST "$BASE/bookings" \
  -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -H "idempotency-key: demo-booking-$(key)" \
  -d "$(jq -cn --arg slotId "$slot" '{slotId:$slotId}')")
consultation_id=$(jq -r '.id' <<<"$consultation")

intent=$(curl -fsS -X POST "$BASE/bookings/${consultation_id}/payments" \
  -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -H "idempotency-key: demo-payment-$(key)" \
  -d '{"provider":"mock"}')
payment_id=$(jq -r '.payment.id' <<<"$intent")

captured=$(curl -fsS -X POST "$BASE/payments/${payment_id}/confirm" \
  -H "authorization: Bearer $token" -H "idempotency-key: demo-confirm-$(key)")

cancelled=$(curl -fsS -X POST "$BASE/bookings/${consultation_id}/cancel" \
  -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -H "idempotency-key: demo-cancel-$(key)" \
  -d '{"reason":"Demo cleanup"}')

jq -n \
  --arg doctorId "$doctor" \
  --arg slotId "$slot" \
  --arg consultationId "$consultation_id" \
  --arg paymentId "$payment_id" \
  --arg paymentStatus "$(jq -r '.status' <<<"$captured")" \
  --arg consultationStatus "$(jq -r '.status' <<<"$cancelled")" \
  '{doctorId:$doctorId,slotId:$slotId,consultationId:$consultationId,paymentId:$paymentId,paymentStatus:$paymentStatus,consultationStatus:$consultationStatus,next:"Run the worker to observe the asynchronous refund ledger/audit."}'

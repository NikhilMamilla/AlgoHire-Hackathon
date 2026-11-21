#!/usr/bin/env bash
# Manual API walkthrough: Anika creates + uploads + submits, Dev and Meera approve, Farah approves -> APPROVED.
# Usage: scripts/walkthrough.sh [base_url]   (default http://localhost:4000; needs curl + jq)
set -euo pipefail
BASE="${1:-http://localhost:4000}"
CSV="$(dirname "$0")/../samples/valid-10.csv"

uid() { curl -sf "$BASE/api/auth/demo-users" | jq -r --arg n "$1" '.users[] | select(.name == $n) | .id'; }
token() { curl -sf -X POST "$BASE/api/auth/demo-login" -H 'content-type: application/json' -d "{\"userId\":\"$(uid "$1")\"}" | jq -r .token; }
decide() { curl -sf -X POST "$BASE/api/batches/$BATCH/decisions" -H "authorization: Bearer $(token "$1")" -H 'content-type: application/json' -d '{"type":"APPROVE"}' | jq -r '"\(.decision.stage) approve by '"$1"' -> \(.batch.status)"'; }

ANIKA=$(token Anika)
BATCH=$(curl -sf -X POST "$BASE/api/batches" -H "authorization: Bearer $ANIKA" -H 'content-type: application/json' -d '{"courseName":"Walkthrough Retail"}' | jq -r .batch.id)
echo "created $BATCH"
curl -sf -X POST "$BASE/api/batches/$BATCH/candidates/csv" -H "authorization: Bearer $ANIKA" -F "file=@$CSV" | jq -c .
curl -sf -X POST "$BASE/api/batches/$BATCH/submit" -H "authorization: Bearer $ANIKA" | jq -r '"submitted -> \(.batch.status)"'
decide Dev; decide Meera; decide Farah
curl -sf "$BASE/api/batches/$BATCH" -H "authorization: Bearer $ANIKA" | jq -c '{status: .batch.status, audit: [.batch.audit[].action]}'

# Phase 3: the worker issues certificates asynchronously.
for _ in $(seq 1 30); do
  STATUS=$(curl -sf "$BASE/api/batches/$BATCH" -H "authorization: Bearer $ANIKA" | jq -r .batch.status)
  [ "$STATUS" = ISSUED ] && break; sleep 1
done
echo "batch status: $STATUS"
[ "$STATUS" = ISSUED ] || { echo "batch was not ISSUED within 30s" >&2; exit 1; }
sleep 3 # let some deliveries go out (the default flaky provider retries with backoff)
CERTS=$(curl -sf "$BASE/api/batches/$BATCH/certificates" -H "authorization: Bearer $ANIKA")
echo "$CERTS" | jq -r '"certificates: \(.certificates | length)", "deliveries: \(.certificates | group_by(.delivery.status) | map("\(.[0].delivery.status)=\(length)") | join(" "))"'
NO=$(echo "$CERTS" | jq -r '.certificates[0].certificateNo')
curl -sf "$BASE/api/public/verify/$NO" | jq -c '{verify: .status, certificateNo, candidateName}'
curl -sf -X POST "$BASE/api/certificates/$NO/revoke" -H "authorization: Bearer $(token Farah)" -H 'content-type: application/json' \
  -d '{"reason":"Walkthrough: revoked to demonstrate verification"}' | jq -c '{revoke: .certificate.status}'
curl -s "$BASE/api/public/verify/$NO" | jq -c '{verify: .status, certificateNo, revokedAt}'

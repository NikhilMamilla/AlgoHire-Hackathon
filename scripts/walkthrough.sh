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

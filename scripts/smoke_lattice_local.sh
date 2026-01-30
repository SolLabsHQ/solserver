#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
USER_ID="${USER_ID:-smoke-user-1}"
RUN_ID="${RUN_ID:-$(date +%s)}"
THREAD_ID="thr_smoke_${RUN_ID}"

echo "BASE_URL=$BASE_URL"

echo
echo "1) Create two anchor messages via POST /v1/chat (capture transmission id)"
CHAT1_HEADERS=$(mktemp)
CHAT1_BODY=$(mktemp)
curl -sS -D "$CHAT1_HEADERS" -o "$CHAT1_BODY" -X POST "$BASE_URL/v1/chat" \
  -H "Content-Type: application/json" \
  -H "x-sol-user-id: $USER_ID" \
  -d '{
    "threadId": "'"$THREAD_ID"'",
    "clientRequestId": "smoke-chat-1-'"$RUN_ID"'",
    "message": "Smoke anchor message 1"
  }'
cat "$CHAT1_BODY" | head -c 800
ANCHOR_ID=$(python3 - "$CHAT1_HEADERS" "$CHAT1_BODY" <<'PY'
import json, re, sys
headers = open(sys.argv[1]).read()
body = open(sys.argv[2]).read()
m = re.search(r'(?im)^x-sol-transmission-id:\\s*(\\S+)\\s*$', headers)
if m:
    print(m.group(1))
else:
    try:
        print(json.loads(body).get("transmissionId", ""))
    except Exception:
        print("")
PY
)
if [ -z "$ANCHOR_ID" ]; then
  echo "ERROR: chat response missing transmission id (header or body)"
  exit 1
fi

CHAT2=$(curl -sS -X POST "$BASE_URL/v1/chat" \
  -H "Content-Type: application/json" \
  -H "x-sol-user-id: $USER_ID" \
  -d '{
    "threadId": "'"$THREAD_ID"'",
    "clientRequestId": "smoke-chat-2-'"$RUN_ID"'",
    "message": "Smoke anchor message 2"
  }')
echo "$CHAT2" | head -c 800

echo
echo "2) Create memory via POST /v1/memories (anchor = transmission id)"
MEM_CREATE_RESP=$(curl -sS -X POST "$BASE_URL/v1/memories" \
  -H "Content-Type: application/json" \
  -H "x-sol-user-id: $USER_ID" \
  -d '{
    "request_id": "smoke-mem-'"$RUN_ID"'",
    "thread_id": "'"$THREAD_ID"'",
    "anchor_message_id": "'"$ANCHOR_ID"'",
    "window": { "before": 6, "after": 6 },
    "memory_kind": "workflow",
    "consent": { "explicit_user_consent": true }
  }')

echo "$MEM_CREATE_RESP"
MEM_ID=$(echo "$MEM_CREATE_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["memory"]["memory_id"])')
echo "memory_id=$MEM_ID"

echo
echo "3) Deref memory by id"
curl -sS "$BASE_URL/v1/memories/$MEM_ID" -H "x-sol-user-id: $USER_ID" | head -c 800
echo

echo
echo "4) List pinned memories"
curl -sS "$BASE_URL/v1/memories?lifecycle_state=pinned&limit=10" -H "x-sol-user-id: $USER_ID" | head -c 800
echo

echo
echo "5) Reminder: verify env flags in the running server process"
echo "LATTICE_ENABLED=${LATTICE_ENABLED:-}"
echo "LATTICE_VEC_ENABLED=${LATTICE_VEC_ENABLED:-}"
echo "LATTICE_VEC_QUERY_ENABLED=${LATTICE_VEC_QUERY_ENABLED:-}"

echo
echo "Done"

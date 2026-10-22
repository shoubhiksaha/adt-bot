#!/bin/sh
# Builds and starts the server exactly as deploy/docker-compose.yml does (with a stand-in speech
# service), then checks what a fresh Oracle VM would need: the app is served, the token guards the
# server, data is writable and survives a restart, and speech goes through the relay.
#   sh deploy/test/smoke.sh        (needs Docker with Compose v2.24+, curl, openssl)
set -eu
cd "$(dirname "$0")/.."
TOKEN=$(openssl rand -hex 24)
ENV_FILE=$(mktemp)
printf 'ADT_TOKEN=%s\n' "$TOKEN" > "$ENV_FILE"
compose() { docker compose -p adt-smoke --env-file "$ENV_FILE" -f docker-compose.yml -f test/compose.test.yml "$@"; }
cleanup() {
  compose logs --tail 40 adt-bot || true
  compose down -v || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT
URL=http://127.0.0.1:18787
AUTH="authorization: Bearer $TOKEN"
fail() {
  echo "FAIL: $1"
  exit 1
}
pass() { echo "PASS: $1"; }

compose up -d --build
for _ in $(seq 1 90); do curl -fsS "$URL/api/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "$URL/api/health" | grep -q '"ok":true' || fail "the server answers"
pass "the server answers"

curl -fsS "$URL/" | grep -q "<title>ADT Bot</title>" || fail "the web app is served"
pass "the web app is served"

[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/agent")" = 401 ] || fail "routines need the token"
curl -fsS -H "$AUTH" "$URL/api/agent" | grep -q '"ok":true' || fail "routines answer with the token"
pass "routines are on and need the token"

compose exec -T adt-bot sh -c 'touch /data/.write-test && ls /data/agent >/dev/null' || fail "the data volume is writable"
pass "the data volume is writable"

for _ in $(seq 1 30); do curl -fsS -H "$AUTH" "$URL/api/speech" | grep -q '"stt":true,"tts":true' && break; sleep 2; done
curl -fsS -H "$AUTH" "$URL/api/speech" | grep -q '"stt":true,"tts":true' || fail "the speech models are fetched"
pass "the speech service is reached by name and its models are fetched"

head -c 32000 /dev/urandom > /tmp/adt-smoke.wav
curl -fsS -H "$AUTH" -F "file=@/tmp/adt-smoke.wav" -F "model=Systran/faster-whisper-base" "$URL/api/speech/v1/audio/transcriptions" | grep -q "Tell me about Rome (Systran/faster-whisper-base" || fail "speech-to-text goes through the relay"
pass "speech-to-text goes through the relay"
curl -fsS -H "$AUTH" -H "content-type: application/json" -d '{"model":"speaches-ai/Kokoro-82M-v1.0-ONNX","voice":"af_heart","input":"Hello"}' "$URL/api/speech/v1/audio/speech" | grep -q "^ID3 stand-in for: Hello" || fail "the voice goes through the relay"
pass "the voice goes through the relay"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/api/speech/v1/audio/speech")" = 401 ] || fail "speech needs the token"
pass "speech needs the token"

compose restart adt-bot
for _ in $(seq 1 60); do curl -fsS "$URL/api/health" >/dev/null 2>&1 && break; sleep 2; done
compose exec -T adt-bot test -f /data/.write-test || fail "data survives a restart"
pass "data survives a restart"
echo "All checks passed."

#!/bin/bash
# API Test Script — run after every code change
# Usage: bash test_api.sh [base_url] [token]
# Default: localhost:8080, admin token

BASE="${1:-http://localhost:8080}"
TOKEN="${2:-Bearer eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MSwicm9sZSI6ImFkbWluIiwiZW1haWwiOiJhY29mb3JrQGZveG1haWwuY29tIiwianRpIjoiMjljMzFjY2YtZjZjMS00ZDNjLTlhZjMtYTJlOWFmZGJkMDdmIiwiaWF0IjoxNzgwMjE5OTg1LCJleHAiOjE3ODA4MjQ3ODV9.wEE78ySXNzgcu2Ybw6gS7-M7qVwQ9WJvjPmql4iXOaw}"
AUTH="Authorization: $TOKEN"
PASS=0
FAIL=0

test() {
    local desc="$1" method="$2" path="$3" data="$4" exp="$5" key="$6"
    local cmd="curl -s -o /tmp/test_out.txt -w '%{http_code}' -X $method '$BASE$path' -H '$AUTH'"
    [ -n "$data" ] && cmd="$cmd -H 'Content-Type: application/json' -d '$data'"
    local status=$(eval $cmd 2>/dev/null)
    local body=$(cat /tmp/test_out.txt 2>/dev/null)
    if [ "$status" = "$exp" ] && [ -z "$key" -o -n "$(echo "$body" | grep -o "$key")" ]; then
        echo "  PASS $desc"
        PASS=$((PASS+1))
    else
        echo "  FAIL $desc (status=$status, expect=$exp, body=${body:0:80})"
        FAIL=$((FAIL+1))
    fi
}

echo "=== TTS ==="
test "speakers" GET "/api/draw/tts/speakers" "" 200 "mimo_default"
test "synthesize preset" POST "/api/draw/tts/synthesize" '{"text":"测试","mode":"preset","speaker":"mimo_default"}' 200 "filename"
test "synthesize custom" POST "/api/draw/tts/synthesize" '{"text":"测试","mode":"custom","instruct":"年轻女性"}' 200 "filename"
test "synthesize no text" POST "/api/draw/tts/synthesize" '{"mode":"preset"}' 400 "need text"

echo "=== Wallet ==="
test "balance" GET "/api/wallet/balance" "" 200 "balance"
test "points config" GET "/api/wallet/points-config" "" 200 "tts_generate"

echo "=== Output ==="
test "my-images" GET "/api/draw/my-images" "" 200 "items"
test "my-queue" GET "/api/draw/my-queue" "" 200 "items"
test "output list" GET "/api/output/list" "" 200 "items"
test "output meta" GET "/api/output/meta?path=test.png" "" 200 "prompt"
test "featured" GET "/api/output/featured" "" 200 "items"

echo "=== Chat ==="
test "chat presets" GET "/api/draw/chat-presets" "" 200 "items"

echo "=== System ==="
test "health" GET "/health" "" 200 "ok"
test "diag" GET "/api/draw/_diag" "" 200 "active_count"

echo "=== Workflows ==="
test "workflow list" GET "/api/workflows" "" 200 "workflows"

echo "=== Queue ==="
test "submit WAI txt2img" POST "/api/draw/queue" '{"direct_prompt":"test girl","workflow_path":"WAI/通用/无Lora.json","turnstile_token":"test"}' 200 "item_id"

echo ""
echo "=== SUMMARY: $PASS passed, $FAIL failed ==="
rm -f /tmp/test_out.txt
[ "$FAIL" -eq 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"

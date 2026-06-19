#!/bin/bash
set -e

PROJ="/home/user/organt_workspace/p-021-p-021-아파트-실거래가-ai-예측-웹서비스"

echo "=== STEP 1: node --version ==="
node --version

echo ""
echo "=== STEP 2: Load model ==="
node -e "
process.chdir('$PROJ');
const m = require('./model/index.js');
console.log('LOAD_OK');
console.log('predict type:', typeof m.predict);
"

echo ""
echo "=== STEP 3: Start server and run API tests ==="

node "$PROJ/server.js" &
SERVER_PID=$!
sleep 3

echo "=== TEST 1: /api/health ==="
curl -s http://localhost:3000/api/health

echo ""
echo "=== TEST 2: /api/districts ==="
curl -s http://localhost:3000/api/districts | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('status:', d.status, 'count:', d.count); d.result && console.log('sample:', JSON.stringify(d.result[0]));"

echo ""
echo "=== TEST 3: /api/trends/강남구 ==="
curl -s 'http://localhost:3000/api/trends/%EA%B0%95%EB%82%A8%EA%B5%AC' | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('status:', d.status, 'gu:', d.gu, 'count:', d.count); d.result && console.log('first:', JSON.stringify(d.result[0]));"

echo ""
echo "=== TEST 4: /api/complexes/강남구 ==="
curl -s 'http://localhost:3000/api/complexes/%EA%B0%95%EB%82%A8%EA%B5%AC' | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('status:', d.status, 'count:', d.count); d.result && d.result[0] && console.log('first:', JSON.stringify(d.result[0]));"

echo ""
echo "=== TEST 5: POST /api/predict (valid) ==="
curl -s -X POST http://localhost:3000/api/predict -H 'Content-Type: application/json' -d '{"gu":"강남구","area":84,"floor":10,"built":2010}'

echo ""
echo "=== TEST 6: POST /api/predict (invalid area=-1) ==="
curl -s -X POST http://localhost:3000/api/predict -H 'Content-Type: application/json' -d '{"gu":"강남구","area":-1,"floor":10,"built":2010}'

echo ""
echo "=== TEST 7: GET /api/predict (wrong method) ==="
curl -s http://localhost:3000/api/predict

kill $SERVER_PID 2>/dev/null

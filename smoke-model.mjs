#!/usr/bin/env node
/**
 * smoke-model.mjs — Real-model HTTP smoke test
 *
 * Requires a running server with a real model (no SWARM_FAKE).
 * Prints current git SHA and API-reported model id.
 * Runs 15+ checks across isolation, knowledge, arithmetic, concurrency.
 *
 * Usage:
 *   node smoke-model.mjs [url]
 *     url defaults to http://localhost:4173
 *
 * Excluded from normal CI (not in playwright.config.js or ci.yml).
 * Run manually to verify a real model deployment.
 */

const BASE = process.argv[2] || 'http://localhost:4173';
const ENDPOINT = `${BASE}/api/chat`;
const STATUS_ENDPOINT = `${BASE}/api/status`;

async function chat(message, sessionId) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      userId: 'smoke-test',
      sessionId: sessionId || `smoke-session-${Date.now()}`,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json();
}

async function getStatus() {
  const res = await fetch(STATUS_ENDPOINT);
  if (!res.ok) return null;
  return await res.json();
}

function sanitize(text) {
  // Replace non-printable / control characters with a clean space
  return (text || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim();
}

import { execSync } from 'node:child_process';

async function main() {
  let gitSha;
  try {
    gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    gitSha = '(unknown)';
  }

  console.log(`\n=== REAL-MODEL SMOKE TEST ===`);
  console.log(`Server: ${BASE}`);
  console.log(`Git SHA: ${gitSha}\n`);

  // Print API-reported model id
  let apiModelId = '(unknown)';
  try {
    const status = await getStatus();
    if (status && status.model) {
      apiModelId = status.model;
      console.log(`API model: ${apiModelId}  (status: ${status.status}, loaded: ${status.loaded})`);
    } else {
      console.log(`API status: ${JSON.stringify(status)}`);
    }
  } catch (err) {
    console.log(`API status unavailable: ${err.message}`);
  }
  console.log('');

  let passed = 0;
  let failed = 0;
  const checks = [];

  function check(label, condition, detail) {
    checks.push({ label, condition, detail });
    if (condition) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.log(`  ❌ ${label}: ${detail || 'FAIL'}`);
      failed++;
    }
    return condition;
  }

  // ─── TEST 1-5: Five requests with "foo" ────────────────────────────
  console.log('─── GROUP 1: Five "foo" requests (no template/inspection marker) ───');
  const fooResults = [];
  for (let i = 0; i < 5; i++) {
    const result = await chat('foo');
    fooResults.push(result);
    const cleaned = sanitize(result.response);
    check(
      `[${i + 1}] foo → finishReason=${result.finishReason}`,
      result.finishReason === 'stop' || result.finishReason === 'fallback',
      `Unexpected finishReason=${result.finishReason}`,
    );
    check(
      `[${i + 1}] no internal inspection marker`,
      !cleaned.includes('[Inspection of user message') && !cleaned.includes('Inspection of user'),
      'Contains inspection marker',
    );
    check(
      `[${i + 1}] no raw inspection serialization (messageLength/wordCount)`,
      !cleaned.includes('messageLength') && !cleaned.includes('wordCount'),
      'Contains raw inspection JSON keys',
    );
    check(
      `[${i + 1}] no template boilerplate (fallback template)`,
      !/fallback mode|model isn't available/i.test(cleaned),
      'Contains fallback template text',
    );
    const responsePreview = cleaned.length > 100 ? cleaned.slice(0, 100) + '...' : cleaned;
    console.log(`    response: ${responsePreview}`);
  }

  // ─── TEST 6: Factual knowledge ─────────────────────────────────────
  console.log('\n─── GROUP 2: Factual + arithmetic ───');
  const capitalResult = await chat('What is the capital of France?');
  const capitalResp = sanitize(capitalResult.response);
  check(
    'What is the capital of France? → contains Paris',
    /Paris/i.test(capitalResp),
    `Response: "${capitalResp.slice(0, 120)}"`,
  );
  console.log(`    response: ${capitalResp.slice(0, 120)}`);

  const mathResult = await chat('What is 2+2?');
  const mathResp = sanitize(mathResult.response);
  check(
    'What is 2+2? → contains 4',
    /\b4\b/.test(mathResp),
    `Response: "${mathResp.slice(0, 120)}"`,
  );
  console.log(`    response: ${mathResp.slice(0, 120)}`);

  // ─── TEST 7: Isolation with rare canaries ─────────────────────────
  console.log('\n─── GROUP 3: Canary isolation ───');
  const canaryId = `canary-isolation-${Date.now()}`;

  // First request with rare canary phrase
  const canaryResult = await chat("My favorite color is chartreuse and I love quasars.", canaryId);
  const canaryResp = sanitize(canaryResult.response);
  console.log(`    canary: ${canaryResp.slice(0, 120)}`);

  // Second request with same session should NOT reference the canary
  const isolatedResult = await chat('foo', canaryId);
  const isolatedResp = sanitize(isolatedResult.response);
  console.log(`    foo after canary: ${isolatedResp.slice(0, 120)}`);

  // Check for no leakage of the rare canary content
  const canaryWords = ['chartreuse', 'quasars'];
  const leakedWords = canaryWords.filter(w => isolatedResp.toLowerCase().includes(w));
  check(
    'foo after canary is isolated (no chartreuse/quasar bleed)',
    leakedWords.length === 0,
    `Leaked: ${leakedWords.join(', ')}`,
  );

  // ─── TEST 8: Concurrent isolation with rare distinct canaries ──────
  console.log('\n─── GROUP 4: Concurrent isolation (rare distinct canaries) ───');
  const concResults = await Promise.all([
    chat('canary-TOPOLOGY'),
    chat('canary-HELIOGRAPH'),
    chat('canary-SYNECDOCHE'),
    chat('canary-PHOTOTAXIS'),
    chat('canary-NEBULOSITY'),
  ]);

  for (let i = 0; i < concResults.length; i++) {
    const r = concResults[i];
    const labels = ['TOPOLOGY', 'HELIOGRAPH', 'SYNECDOCHE', 'PHOTOTAXIS', 'NEBULOSITY'];
    const label = labels[i];
    check(
      `concurrent-${label} finishes (${r.finishReason})`,
      !!r.finishReason,
      `No finishReason`,
    );
    const resp = sanitize(r.response);
    check(
      `concurrent-${label} no cross-talk`,
      !/[A-Z]{6,}/.test(resp) || resp.includes(label),
      `Response contains unexpected canary`,
    );
    console.log(`    concurrent-${label}: ${resp.slice(0, 120)}`);
  }

  // ─── SUMMARY ───────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n─── RESULTS ───`);
  console.log(`  SHA:       ${gitSha}`);
  console.log(`  Model:     ${apiModelId}`);
  console.log(`  Passed:    ${passed}/${total}`);
  if (failed > 0) {
    console.log(`  Failed:    ${failed}/${total}`);
    console.log(`\n  Failed checks:`);
    for (const c of checks) {
      if (!c.condition) {
        console.log(`    ❌ ${c.label}`);
        if (c.detail) console.log(`       ${c.detail}`);
      }
    }
    process.exit(1);
  } else {
    console.log('  All checks passed ✅');
  }
}

main().catch((err) => {
  console.error('SMOKE TEST CRASHED:', err.message);
  process.exit(1);
});

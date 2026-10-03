'use strict';
// Golden-response diff: replays the same GET requests against two running servers
// and compares status + body byte for byte.
// Usage: node tests/support/golden-diff.js <BASE_A> <BASE_B> <requests.json>
// requests.json: { "tokens": { "admin": "<jwt>" }, "requests": [ { "path": "/api/x", "auth": "admin" | null } ] }
// Volatile keys (created_at, updated_at, now, generated_at) are stripped before comparing.
const fs = require('node:fs');

const VOLATILE = new Set(['created_at', 'updated_at', 'now', 'generated_at']);

function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value)) if (!VOLATILE.has(k)) out[k] = normalize(value[k]);
        return out;
    }
    return value;
}

let seq = 0;
async function capture(base, req, tokens) {
    const headers = {};
    // GOLDEN_SPOOF_IP=1: unique X-Forwarded-For per request to avoid per-IP rate limits (needs trust proxy).
    if (process.env.GOLDEN_SPOOF_IP) { seq++; headers['X-Forwarded-For'] = `10.${(seq >> 16) & 255}.${(seq >> 8) & 255}.${seq & 255}`; }
    if (req.auth) headers.Authorization = 'Bearer ' + tokens[req.auth];
    const res = await fetch(base + req.path, { headers });
    const text = await res.text();
    let body = text;
    try { body = JSON.stringify(normalize(JSON.parse(text))); } catch { /* non-JSON: compare raw */ }
    return { status: res.status, body };
}

async function main() {
    const [baseA, baseB, file] = process.argv.slice(2);
    if (!baseA || !baseB || !file) {
        console.error('usage: golden-diff.js <BASE_A> <BASE_B> <requests.json>');
        process.exit(2);
    }
    const { tokens = {}, requests } = JSON.parse(fs.readFileSync(file, 'utf8'));
    let diffs = 0;
    for (const req of requests) {
        const [a, b] = [await capture(baseA, req, tokens), await capture(baseB, req, tokens)];
        const same = a.status === b.status && a.body === b.body;
        if (!same) diffs++;
        console.log(`${same ? 'IDENTICAL' : 'DIFFERENT'} ${a.status}/${b.status} len=${a.body.length} ${req.auth || 'anon'} ${req.path}`);
        if (!same) console.log('  A: ' + a.body.slice(0, 300) + '\n  B: ' + b.body.slice(0, 300));
    }
    console.log(diffs ? `${diffs} DIFFERENCES` : 'ALL IDENTICAL');
    process.exit(diffs ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });

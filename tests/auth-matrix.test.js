'use strict';
// Auth matrix: every route in the snapshot whose chain starts with authMiddleware must
// reject unauthenticated requests with 401 (authMiddleware runs before adminOnly, so
// admin chains answer 401 too), and adminOnly routes must answer 403 to a non-admin token.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { startServer, SKIP_DB, SKIP_REASON, JWT_SECRET } = require('./helpers');

// Authenticated routes that legitimately do not answer 401 without a token. (none today)
// Format: 'METHOD /path': reason
const UNAUTH_ALLOW_LIST = {};

function parseRoutes() {
    const out = [];
    const lines = fs.readFileSync(path.join(__dirname, 'snapshots', 'routes.txt'), 'utf8').split('\n');
    for (const line of lines) {
        const m = /^([A-Z,]+) (".*?"|\[.*?\]) \[(.*)\]$/.exec(line);
        if (!m) continue; // MW lines
        const paths = m[2].startsWith('[') ? JSON.parse(m[2]) : [JSON.parse(m[2])];
        const chain = m[3].split('>');
        for (const method of m[1].split(',')) {
            for (const p of paths) out.push({ method, path: p, chain });
        }
    }
    return out;
}

const routes = parseRoutes().filter(r =>
    r.chain[0] === 'authMiddleware'
    && !r.path.includes('*')
    && !/webhook|\/public\//.test(r.path)
);
const concrete = r => r.path.replace(/:[A-Za-z_]+/g, '1');

describe('auth matrix (HTTP)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => { s = await startServer(); });
    after(async () => { if (s) await s.stop(); });

    it('snapshot has authenticated routes to check', () => {
        assert.ok(routes.length > 50, `only ${routes.length} routes parsed`);
    });

    it('unauthenticated requests to authMiddleware routes -> 401', async () => {
        const bad = [];
        for (const r of routes) {
            const key = `${r.method} ${r.path}`;
            if (key in UNAUTH_ALLOW_LIST) continue;
            const res = await s.api(r.method, concrete(r), r.method === 'GET' ? {} : { body: {} });
            if (res.status !== 401) bad.push(`${key} -> ${res.status}`);
        }
        assert.deepEqual(bad, []);
    });

    it('non-admin token on adminOnly routes -> 403', async () => {
        const token = jwt.sign({ id: 999999, role: 'brand_user', email: 'x@test.local' }, JWT_SECRET);
        const bad = [];
        for (const r of routes.filter(r => r.chain.includes('adminOnly'))) {
            const res = await s.api(r.method, concrete(r), r.method === 'GET' ? { token } : { token, body: {} });
            if (res.status !== 403) bad.push(`${r.method} ${r.path} -> ${res.status}`);
        }
        assert.deepEqual(bad, []);
    });
});

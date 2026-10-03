'use strict';
// Route inventory safety net for the server.js split: the full Express route table
// (order, methods, paths, handler-name chain, middleware) must match the snapshot.
// No database needed. Regenerate intentionally with: UPDATE_SNAPSHOT=1 npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dumpRoutes } = require('./support/route-table');

const SNAPSHOT = path.join(__dirname, 'snapshots', 'routes.txt');

describe('route inventory', () => {
    it('matches tests/snapshots/routes.txt exactly (order matters)', () => {
        const actual = dumpRoutes();
        if (process.env.UPDATE_SNAPSHOT === '1') fs.writeFileSync(SNAPSHOT, actual);
        const expected = fs.readFileSync(SNAPSHOT, 'utf8');
        if (actual !== expected) {
            const a = actual.split('\n'), e = expected.split('\n');
            const n = Math.max(a.length, e.length);
            for (let i = 0; i < n; i++) {
                if (a[i] !== e[i]) {
                    assert.fail(`route table differs at line ${i + 1}:\n  expected: ${e[i]}\n  actual:   ${a[i]}`);
                }
            }
        }
        assert.equal(actual, expected);
    });
});

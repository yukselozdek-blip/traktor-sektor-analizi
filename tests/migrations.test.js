'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { runMigrations } = require('../database/migrate');
const { createDatabase, SKIP_DB, SKIP_REASON } = require('./helpers');

const quiet = { log() {}, error() {} };

describe('migrations', { skip: SKIP_DB && SKIP_REASON }, () => {
    let dbs = [], pools = [], tmp;
    async function fresh() {
        const db = await createDatabase('test_mig');
        const pool = new Pool({ connectionString: db.url, max: 3 });
        dbs.push(db); pools.push(pool);
        return pool;
    }
    before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')); });
    after(async () => {
        for (const p of pools) await p.end().catch(() => {});
        for (const d of dbs) await d.drop().catch(e => console.error(e.message));
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('real migrations apply on empty DB; second run applies 0', async () => {
        const pool = await fresh();
        const first = await runMigrations(pool, { logger: quiet });
        assert.ok(first.applied > 0);
        const second = await runMigrations(pool, { logger: quiet });
        assert.equal(second.applied, 0);
        const t = await pool.query(`SELECT to_regclass('public.users') AS u`);
        assert.ok(t.rows[0].u);
    });

    it('failing migration is rolled back and stops later ones', async () => {
        const pool = await fresh();
        const dir = path.join(tmp, 'bad');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, '001_ok.sql'), 'CREATE TABLE t_ok(a int);');
        fs.writeFileSync(path.join(dir, '002_bad.sql'), 'CREATE TABLE t_bad(a int); SELECT * FROM does_not_exist;');
        fs.writeFileSync(path.join(dir, '003_never.sql'), 'CREATE TABLE t_never(a int);');
        await assert.rejects(runMigrations(pool, { logger: quiet, dir }), /002_bad/);
        const rel = async n => (await pool.query('SELECT to_regclass($1) AS r', [n])).rows[0].r;
        assert.ok(await rel('public.t_ok'));
        assert.equal(await rel('public.t_bad'), null);
        assert.equal(await rel('public.t_never'), null);
        const v = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
        assert.deepEqual(v.rows.map(r => r.version), ['001']);
    });
});

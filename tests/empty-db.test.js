'use strict';
// Taze/boş veritabanı testi: satış/TÜİK verisi yokken hiçbir kimlik doğrulamalı GET rotası
// 5xx dönmemeli ve gövde geçerli JSON olmalı (yeni kurulumda ilk kullanıcı hata görmemeli).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

const SKIP_PATHS = /webhook|\/public\/|\/export|\/download|\/stream|\/oauth|\/google/;

function validJson(t) { try { JSON.parse(t); return true; } catch (_) { return false; } }

function getRoutes() {
    const out = [];
    for (const line of fs.readFileSync(path.join(__dirname, 'snapshots', 'routes.txt'), 'utf8').split('\n')) {
        const m = /^([A-Z,]+) (".*?"|\[.*?\]) \[(.*)\]$/.exec(line);
        if (!m || !m[1].split(',').includes('GET')) continue;
        if (m[3].split('>')[0] !== 'authMiddleware') continue;
        for (const p of (m[2].startsWith('[') ? JSON.parse(m[2]) : [JSON.parse(m[2])])) {
            if (!p.includes('*') && !SKIP_PATHS.test(p)) out.push(p.replace(/:[A-Za-z_]+/g, '1'));
        }
    }
    return [...new Set(out)];
}

describe('boş veritabanı (GET, admin token)', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s, admin;
    before(async () => {
        s = await startServer();
        admin = await s.createUserWithToken({ role: 'admin' });
        await s.pool.query('DELETE FROM sales_data');
        await s.pool.query('DELETE FROM tuik_veri');
    });
    after(async () => { if (s) await s.stop(); });

    it('veri yokken hiçbir GET rotası 5xx dönmez ve gövde geçerli JSON olur', async () => {
        const routes = getRoutes();
        assert.ok(routes.length > 40, 'rota listesi beklenenden kısa');
        const bad = [];
        for (const p of routes) {
            const r = await s.api('GET', p, { token: admin.token });
            if (r.status >= 500) { bad.push(`${r.status} GET ${p}`); continue; }
            if (r.status === 200 && !validJson(r.text)) bad.push(`geçersiz JSON GET ${p}`);
        }
        assert.deepEqual(bad, [], 'Bu rotalar boş DB ile hata verdi');
    });
});

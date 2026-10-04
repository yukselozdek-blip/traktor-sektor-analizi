'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('güvenlik başlıkları ve dış kaynaklar', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => { s = await startServer(); });
    after(async () => { if (s) await s.stop(); });

    it('CSP zorunlu modda: betik/obje/çerçeve/base kısıtlı', async () => {
        const r = await s.api('GET', '/login.html');
        const csp = r.headers.get('content-security-policy');
        assert.ok(csp, 'content-security-policy yok');
        assert.match(csp, /default-src 'self'/);
        assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/accounts\.google\.com\/gsi\/client/);
        assert.match(csp, /object-src 'none'/);
        assert.match(csp, /base-uri 'self'/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.doesNotMatch(csp, /cdn\.jsdelivr|unpkg|cdnjs/);
        assert.match(r.headers.get('permissions-policy') || '', /camera=\(\)/);
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    });

    it('HTML sayfaları üçüncü taraf CDN betiği/stili yüklemez (yalnızca Google ile giriş)', () => {
        const dir = path.join(__dirname, '..', 'public');
        for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.html'))) {
            const html = fs.readFileSync(path.join(dir, f), 'utf8');
            const ext = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1])
                .filter(u => !/^https:\/\/accounts\.google\.com\/gsi\/client$/.test(u) && !/w3\.org/.test(u));
            assert.deepEqual(ext, [], `${f} dış kaynak yüklüyor`);
        }
    });

    it('vendor dosyaları sunulur ve önbelleğe alınır', async () => {
        for (const p of ['/vendor/chart.umd.min.js', '/vendor/leaflet/leaflet.js', '/vendor/purify.min.js', '/vendor/fonts/fonts.css', '/vendor/fontawesome/css/all.min.css']) {
            const r = await s.api('GET', p);
            assert.equal(r.status, 200, p);
            assert.match(r.headers.get('cache-control') || '', /max-age=604800/);
        }
    });
});

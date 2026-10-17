'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

function get(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, headers }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', c => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', text }));
        }).on('error', reject);
    });
}

const LANDING_TITLE = /<title>[^<]*Traktör Sektör Analizi/;

describe('kök adres ve tanıtım sayfası yönlendirmesi', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => { s = await startServer(); });
    after(async () => { if (s) await s.stop(); });

    it('oturumsuz kök adres tanıtım sayfasını döner', async () => {
        const r = await get(s.port, '/');
        assert.equal(r.status, 200);
        assert.match(r.type, /text\/html/);
        assert.match(r.text, LANDING_TITLE);
        assert.doesNotMatch(r.text, /app_v3\.js/);
    });

    it('oturum çerezi olan kök adres uygulamaya (index.html) gider', async () => {
        const r = await get(s.port, '/', { Cookie: 'tk_session=x' });
        assert.equal(r.status, 200);
        assert.match(r.text, /app_v3\.js/);
    });

    it('Authorization: Bearer olan kök adres uygulamaya gider', async () => {
        const r = await get(s.port, '/', { Authorization: 'Bearer x' });
        assert.equal(r.status, 200);
        assert.match(r.text, /app_v3\.js/);
    });

    it('/tanitim her zaman tanıtım sayfasını döner (çerezle de)', async () => {
        for (const headers of [{}, { Cookie: 'tk_session=x' }]) {
            for (const p of ['/tanitim', '/tanitim/']) {
                const r = await get(s.port, p, headers);
                assert.equal(r.status, 200);
                assert.match(r.text, LANDING_TITLE);
            }
        }
    });

    it('/health hâlâ JSON döner', async () => {
        const r = await get(s.port, '/health');
        assert.equal(r.status, 200);
        assert.match(r.type, /application\/json/);
        assert.doesNotThrow(() => JSON.parse(r.text));
    });
});

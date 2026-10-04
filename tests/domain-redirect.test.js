'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

function get(port, path, host) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, headers: { Host: host } }, res => {
            res.resume();
            resolve({ status: res.statusCode, location: res.headers.location });
        }).on('error', reject);
    });
}

describe('ana alan adı yönlendirmesi', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => {
        s = await startServer({ env: {
            APP_BASE_URL: 'https://app.example.test',
            REDIRECT_HOSTS: 'example.test,www.example.test'
        } });
    });
    after(async () => { if (s) await s.stop(); });

    it('apex ve www -> app (301, yol + sorgu korunur)', async () => {
        for (const host of ['example.test', 'www.example.test']) {
            const r = await get(s.port, '/x?a=1', host);
            assert.equal(r.status, 301);
            assert.equal(r.location, 'https://app.example.test/x?a=1');
        }
    });

    it('/health yönlendirilmez; app alan adı yönlendirilmez', async () => {
        assert.equal((await get(s.port, '/health', 'example.test')).status, 200);
        assert.equal((await get(s.port, '/health', 'app.example.test')).status, 200);
        assert.notEqual((await get(s.port, '/', 'app.example.test')).status, 301);
    });
});

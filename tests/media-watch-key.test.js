'use strict';
// Webhook anahtarındaki baş/son boşluk ve satır sonu (Railway'e yapıştırma hatası) uyuşmazlığa yol açmamalı.
// Needs a DB (TEST_DATABASE_URL/DATABASE_URL), otherwise skipped.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, SKIP_DB, SKIP_REASON } = require('./helpers');

describe('media-watch webhook anahtarı', { skip: SKIP_DB && SKIP_REASON }, () => {
    let s;
    before(async () => { s = await startServer({ env: { MEDIA_WATCH_WEBHOOK_KEY: '  gizli-anahtar-123456789012345678901234567890\n' } }); });
    after(async () => { if (s) await s.stop(); });

    it('boşluklu ortam değeri temizlenir: temiz anahtarla ingest kabul edilir', async () => {
        const ok = await s.api('POST', '/api/media-watch/ingest', { headers: { 'x-media-watch-key': 'gizli-anahtar-123456789012345678901234567890' }, body: { items: [] } });
        assert.equal(ok.status, 200, ok.text);
        const bad = await s.api('POST', '/api/media-watch/ingest', { headers: { 'x-media-watch-key': 'yanlis' }, body: { items: [] } });
        assert.equal(bad.status, 401);
    });
});

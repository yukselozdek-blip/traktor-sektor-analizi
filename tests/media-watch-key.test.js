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
        // Unicode anahtar için özet başlığı (köprünün kullandığı yol)
        const crypto = require('node:crypto');
        const digest = crypto.createHash('sha256').update('gizli-anahtar-123456789012345678901234567890', 'utf8').digest('hex');
        const viaDigest = await s.api('POST', '/api/media-watch/ingest', { headers: { 'x-media-watch-key-sha256': digest }, body: { items: [] } });
        assert.equal(viaDigest.status, 200, viaDigest.text);
        const badDigest = await s.api('POST', '/api/media-watch/ingest', { headers: { 'x-media-watch-key-sha256': 'a'.repeat(64) }, body: { items: [] } });
        assert.equal(badDigest.status, 401);
        const bad = await s.api('POST', '/api/media-watch/ingest', { headers: { 'x-media-watch-key': 'yanlis' }, body: { items: [] } });
        assert.equal(bad.status, 401);
    });
});

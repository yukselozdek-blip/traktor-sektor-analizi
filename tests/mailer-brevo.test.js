'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('Brevo API: HTTPS isteği doğru gövdeyle gönderilir', async () => {
    process.env.BREVO_API_KEY = 'k';
    process.env.MAIL_FROM = 'Traktör Sektör Analizi <no-reply@tarimtraktor.com>';
    delete process.env.MAIL_OUTBOX_FILE;
    const calls = [];
    const orig = global.fetch;
    global.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
    try {
        const { sendMail, isMailConfigured } = require('../src/lib/mailer');
        assert.equal(isMailConfigured(), true);
        const r = await sendMail({ to: 'a@b.com', subject: 'S', text: 'T' });
        assert.equal(r.sent, true);
        assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
        assert.equal(calls[0].opts.headers['api-key'], 'k');
        const body = JSON.parse(calls[0].opts.body);
        assert.deepEqual(body.sender, { name: 'Traktör Sektör Analizi', email: 'no-reply@tarimtraktor.com' });
        assert.deepEqual(body.to, [{ email: 'a@b.com' }]);
        global.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
        const r2 = await sendMail({ to: 'a@b.com', subject: 'S', text: 'T' });
        assert.equal(r2.sent, false);
    } finally {
        global.fetch = orig;
        delete process.env.BREVO_API_KEY;
    }
});

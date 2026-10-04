'use strict';
// Statik HTML kalite kontrolleri (tarayıcı gerektirmez): dil, viewport, ana işaret (landmark), erişilebilirlik betiği.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'public');
const pages = fs.readdirSync(dir).filter(n => n.endsWith('.html'));

it('her sayfada lang, viewport, main işareti ve a11y.js var', () => {
    assert.ok(pages.length >= 4);
    for (const f of pages) {
        const html = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.match(html, /<html[^>]*\blang="tr"/, `${f}: lang`);
        assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/, `${f}: viewport`);
        assert.match(html, /<main\b|role="main"/, `${f}: main işareti`);
        assert.match(html, /<h1\b/, `${f}: h1`);
        assert.match(html, /\/a11y\.js/, `${f}: a11y.js`);
    }
});

it('görsel olmayan metin alanlarında yalnızca placeholder ile etiketlenmiş şifre alanı kalmadı', () => {
    for (const f of pages) {
        const html = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const m of html.matchAll(/<input[^>]*type="password"[^>]*>/g)) {
            const tag = m[0];
            const idMatch = tag.match(/id="([^"]+)"/);
            const labelled = /aria-label=|aria-labelledby=/.test(tag) || (idMatch && new RegExp(`<label[^>]*for="${idMatch[1]}"`).test(html));
            assert.ok(labelled || /<label[^>]*>[^<]*<input[^>]*type="password"/.test(html), `${f}: etiketsiz şifre alanı: ${tag.slice(0, 80)}`);
        }
    }
});

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

// ---- CSP: script-src 'unsafe-inline' kaldırıldı -> satır içi olay yöneticisi / satır içi betik OLMAMALI ----
const jsFiles = fs.readdirSync(dir).filter(n => n.endsWith('.js'));
const INLINE_HANDLER = /\son(click|dblclick|change|input|keyup|keydown|keypress|submit|error|load|focus|blur|mouse\w+)\s*=\s*["'`]/;

it('public/*.html ve public/*.js içinde satır içi olay yöneticisi (onclick= vb.) yok (şablon dizeleri dahil)', () => {
    for (const f of [...pages, ...jsFiles]) {
        const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
        lines.forEach((line, i) => {
            assert.ok(!INLINE_HANDLER.test(line), `${f}:${i + 1} satır içi olay yöneticisi var (data-on-* kullanın): ${line.trim().slice(0, 100)}`);
            assert.ok(!/setAttribute\(\s*['"]on[a-z]+['"]/.test(line), `${f}:${i + 1} setAttribute('on...') var (data-on-* kullanın)`);
            assert.ok(!/(?:href|src|action)\s*=\s*["']\s*javascript:/i.test(line), `${f}:${i + 1} javascript: URL var`);
        });
    }
});

it('HTML sayfalarında satır içi <script> gövdesi yok (yalnızca src li betikler) ve inline-actions.js ilk betik', () => {
    for (const f of pages) {
        const html = fs.readFileSync(path.join(dir, f), 'utf8');
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
        assert.ok(scripts.length > 0, `${f}: betik yok`);
        for (const m of scripts) {
            assert.match(m[1], /\bsrc="/, `${f}: satır içi <script> gövdesi var: ${m[2].trim().slice(0, 60)}`);
            assert.equal(m[2].trim(), '', `${f}: src li betiğin gövdesi boş olmalı`);
        }
        assert.match(scripts[0][1], /src="\/inline-actions\.js\?v=/, `${f}: ilk betik inline-actions.js olmalı`);
    }
});

it('HTML sayfalarındaki betik dosyaları var ve data-on-* ifadeleri yorumlayıcıda ayrıştırılabiliyor', () => {
    const IA = require('../public/inline-actions.js');
    for (const f of pages) {
        const html = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const m of html.matchAll(/<script\b[^>]*\bsrc="(\/[^"?]+)/g)) {
            if (/^\/(vendor)\//.test(m[1])) continue;
            assert.ok(fs.existsSync(path.join(dir, m[1])), `${f}: ${m[1]} yok`);
        }
        for (const m of html.matchAll(/\sdata-on-([a-z]+)="([^"]*)"/g)) {
            const expr = m[2].replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
            assert.equal(IA.check(expr), null, `${f}: data-on-${m[1]} ayrıştırılamadı: ${expr}`);
        }
    }
});

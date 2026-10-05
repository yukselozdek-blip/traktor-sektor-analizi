#!/usr/bin/env node
/*
 * Satır içi olay yöneticilerini CSP uyumlu `data-on-*` özniteliklerine dönüştürür.
 *
 *   onclick="X"  ->  data-on-click="X"      (ifade X AYNEN kalır; public/inline-actions.js çalıştırır)
 *
 * Kapsam: public/*.html ve public/*.js (vendor/ ve dist/ hariç), JS şablon dizelerinin içindekiler dahil
 * (`${...}` yerleştirmeleri tırnak sayımında atlanır).
 *
 * Kullanım:
 *   node scripts/codemod-inline-handlers.js --check   # kuru çalıştırma: dosyaya yazmaz; yorumlayıcının
 *                                                      # desteklemediği ifadeleri + el ile taşınacakları listeler (çıkış 1)
 *   node scripts/codemod-inline-handlers.js           # dönüştürür (dönüştürülemeyen satır varsa dosyaya YAZMAZ, çıkış 1)
 *   node scripts/codemod-inline-handlers.js --idents  # ifadelerde kullanılan kök tanımlayıcıları listeler
 *
 * Dönüştürülemeyen (yorumlayıcıda desteklenmeyen) kodlar adlandırılmış bir fonksiyona taşınıp çağrı
 * `data-on-click="adliFonksiyon(...)"` yapılmalıdır. `el.setAttribute('onclick', ...)` ve `javascript:` URL'leri de
 * otomatik dönüştürülmez; --check bunları da bildirir.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const IA = require('../public/inline-actions.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const EVENTS = ['click', 'dblclick', 'change', 'input', 'keydown', 'keyup', 'keypress', 'submit', 'error', 'load', 'focus', 'blur',
    'mousedown', 'mouseup', 'mouseover', 'mouseout', 'contextmenu', 'reset', 'select', 'toggle'];

function listFiles() {
    return fs.readdirSync(PUBLIC)
        .filter(f => /\.(html|js)$/.test(f) && f !== 'inline-actions.js')
        .map(f => path.join(PUBLIC, f));
}

// Öznitelik değerini bulur. i: açılış tırnağından sonraki dizin. Dönüş: kapanış tırnağı dizini veya -1.
function findValueEnd(src, i, quote) {
    let depth = 0;
    for (; i < src.length; i++) {
        const c = src[i];
        if (depth === 0 && c === '$' && src[i + 1] === '{') { depth = 1; i++; continue; }
        if (depth > 0) {
            if (c === '{') depth++;
            else if (c === '}') depth--;
            continue;
        }
        if (c === quote) return i;
    }
    return -1;
}

// HTML kaçışlarını çöz + ${...} yerleştirmelerini yer tutucu sayıyla değiştir (yorumlayıcı doğrulaması için)
function toSample(value) {
    let out = '';
    for (let i = 0; i < value.length; i++) {
        if (value[i] === '$' && value[i + 1] === '{') {
            let d = 1; i += 2;
            for (; i < value.length && d > 0; i++) { if (value[i] === '{') d++; else if (value[i] === '}') d--; }
            i--; out += '0';
        } else out += value[i];
    }
    return out.replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const ATTR_RE = new RegExp('(\\s)on(' + EVENTS.join('|') + ')(\\s*=\\s*)(["\'])', 'g');
const DATA_RE = new RegExp('\\sdata-on-(' + EVENTS.join('|') + ')(=)(["\'])', 'g');
const UNKNOWN_RE = /\son([a-z]+)\s*=\s*["']/g;

function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

function processFile(file, apply) {
    const src = fs.readFileSync(file, 'utf8');
    let out = '', last = 0, count = 0;
    const problems = [], found = [];
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(src))) {
        const quote = m[4];
        const valStart = m.index + m[0].length;
        const end = findValueEnd(src, valStart, quote);
        const line = lineOf(src, m.index);
        if (end < 0) { problems.push({ file, line, event: m[2], expr: '(değer sonu bulunamadı)', why: 'ayrıştırılamadı' }); continue; }
        const value = src.slice(valStart, end);
        const sample = toSample(value);
        const why = IA.check(sample);
        found.push({ file, line, event: m[2], expr: sample });
        if (why) problems.push({ file, line, event: m[2], expr: sample, why });
        out += src.slice(last, m.index) + m[1] + 'data-on-' + m[2] + '=' + quote;
        // not: "=" etrafındaki boşluklar korunmaz; temiz yazım
        last = valStart;
        count++;
        ATTR_RE.lastIndex = end + 1;
    }
    out += src.slice(last);
    // Zaten dönüştürülmüş data-on-* ifadeleri de yorumlayıcıda doğrulanır (kalıcı güvenlik ağı)
    let validated = 0;
    DATA_RE.lastIndex = 0;
    while ((m = DATA_RE.exec(src))) {
        const valStart = m.index + m[0].length;
        const end = findValueEnd(src, valStart, m[3]);
        const line = lineOf(src, m.index);
        if (end < 0) { problems.push({ file, line, event: m[1], expr: '(değer sonu bulunamadı)', why: 'ayrıştırılamadı' }); continue; }
        const sample = toSample(src.slice(valStart, end));
        const why = IA.check(sample);
        found.push({ file, line, event: m[1], expr: sample });
        validated++;
        if (why) problems.push({ file, line, event: m[1], expr: sample, why });
        DATA_RE.lastIndex = end + 1;
    }
    // Bilinmeyen/haritalanmamış olay öznitelikleri
    const stray = [];
    UNKNOWN_RE.lastIndex = 0;
    while ((m = UNKNOWN_RE.exec(src))) {
        if (!EVENTS.includes(m[1])) stray.push({ file, line: lineOf(src, m.index), event: m[1], expr: '', why: 'desteklenmeyen olay adı' });
    }
    // setAttribute('onclick', ...) ve javascript: URL
    const manual = [];
    const reSet = /setAttribute\(\s*['"]on[a-z]+['"]/g;
    while ((m = reSet.exec(src))) manual.push({ file, line: lineOf(src, m.index), event: '-', expr: src.slice(m.index, m.index + 70).split('\n')[0], why: 'setAttribute ile olay özniteliği: el ile data-on-* yap' });
    const reJs = /(?:href|src|action)\s*=\s*["']\s*javascript:/gi;
    while ((m = reJs.exec(src))) manual.push({ file, line: lineOf(src, m.index), event: '-', expr: src.slice(m.index, m.index + 70).split('\n')[0], why: 'javascript: URL: adlandırılmış işlev + data-on-click' });
    if (apply && count && !problems.length && !stray.length && !manual.length) fs.writeFileSync(file, out);
    return { file, count, validated, problems: problems.concat(stray, manual), found };
}

function rootIdents(found) {
    const roots = new Map();
    const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n.type === 'Ident') roots.set(n.name, (roots.get(n.name) || 0) + 1);
        Object.keys(n).forEach(k => { if (k !== 'type') walk(n[k]); });
    };
    for (const f of found) { try { walk(IA.parseAction(f.expr)); } catch (_) { /* bildirildi */ } }
    return roots;
}

function main() {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const idents = args.includes('--idents');
    const results = listFiles().map(f => processFile(f, !check && !idents));
    let total = 0, bad = 0, validated = 0;
    for (const r of results) {
        if (r.count || r.problems.length) console.log(`${path.relative(process.cwd(), r.file)}: ${r.count} öznitelik${check || idents ? ' (bulundu)' : ''}`);
        total += r.count; validated += r.validated;
        for (const p of r.problems) {
            bad++;
            console.log(`  ! ${path.relative(process.cwd(), p.file)}:${p.line} [${p.event}] ${p.why}\n      ${String(p.expr).slice(0, 160)}`);
        }
    }
    if (idents) {
        const roots = rootIdents(results.flatMap(r => r.found));
        console.log('Kök tanımlayıcılar:', [...roots.entries()].sort().map(([k, v]) => `${k}(${v})`).join(' '));
    }
    console.log(`Dönüştürülecek (onclick= vb.): ${total}, doğrulanan data-on-*: ${validated}`);
    console.log(`Toplam: ${total} öznitelik, sorunlu: ${bad}`);
    if (bad) {
        console.log(check ? 'Dönüştürülemeyen satırlar var (yukarıda).' : 'Sorunlu satırlar var; dosyalara YAZILMADI (yalnızca sorunsuz dosyalar yazıldı).');
        process.exit(1);
    }
}
main();

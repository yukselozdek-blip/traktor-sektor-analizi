'use strict';
// public/inline-actions.js yorumlayıcı çekirdeği (DOM'suz; jsdom gerekmez).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const IA = require('../public/inline-actions.js');

function run(src, extra = {}) {
    const calls = [];
    const g = {
        calls,
        fn: (...a) => { calls.push(['fn', a]); return a[0]; },
        selectPlan: (...a) => calls.push(['selectPlan', a]),
        parseInt,
        Obj: { method(...a) { calls.push(['Obj.method', a, this === g.Obj]); return 'm'; }, a: { b: { c(...a) { calls.push(['a.b.c', a]); } } } },
        state: { x: 1, deep: { y: 0 } },
        ...extra.globals
    };
    const res = IA.runAction(src, { thisArg: extra.thisArg, event: extra.event, globals: g });
    return { calls, g, res };
}

describe('inline-actions yorumlayıcısı', () => {
    it('basit çağrı ve argüman türleri', () => {
        const { calls } = run(`fn('a', "b", 3, -2.5, 1e2, true, false, null, undefined)`);
        assert.deepEqual(calls[0], ['fn', ['a', 'b', 3, -2.5, 100, true, false, null, undefined]]);
    });

    it('çağrı zinciri ve yöntem bağlamı (this = nesne)', () => {
        const { calls } = run(`Obj.method(1); Obj.a.b.c('z')`);
        assert.deepEqual(calls[0], ['Obj.method', [1], true]);
        assert.deepEqual(calls[1], ['a.b.c', ['z']]);
    });

    it('document.getElementById(..).classList.toggle(..) benzeri zincir', () => {
        const toggled = [];
        const document = { getElementById: id => ({ classList: { toggle: c => toggled.push([id, c]) } }) };
        run(`document.getElementById('notif').classList.toggle('open')`, { globals: { document } });
        assert.deepEqual(toggled, [['notif', 'open']]);
    });

    it('this, this.value, this.checked, this.closest(..)', () => {
        const el = { value: '42', checked: true, closest: s => ({ sel: s }) };
        const { calls } = run(`fn(this, this.value, this.checked, this.closest('[data-x]'))`, { thisArg: el });
        assert.equal(calls[0][1][0], el);
        assert.equal(calls[0][1][1], '42');
        assert.equal(calls[0][1][2], true);
        assert.deepEqual(calls[0][1][3], { sel: '[data-x]' });
    });

    it('event, event.target, preventDefault/stopPropagation', () => {
        const log = [];
        const ev = { target: { id: 't' }, preventDefault: () => log.push('pd'), stopPropagation: () => log.push('sp') };
        const { calls } = run(`fn(event.target.id); event.preventDefault(); event.stopPropagation()`, { event: ev });
        assert.deepEqual(calls[0][1], ['t']);
        assert.deepEqual(log, ['pd', 'sp']);
    });

    it('; ile ayrılmış diziler, boş ifadeler ve sondaki ;', () => {
        const { calls } = run(`fn(1);; fn(2); fn(3);`);
        assert.deepEqual(calls.map(c => c[1][0]), [1, 2, 3]);
    });

    it('atama (=, +=, -=) ve window.xxx = parseInt(this.value)', () => {
        const { g } = run(`window._bm_brand1 = parseInt(this.value); state.deep.y = 5; state.x += 2; state.x -= 1`, {
            thisArg: { value: '7' }, globals: { window: {} }
        });
        assert.equal(g.window._bm_brand1, 7);
        assert.equal(g.state.deep.y, 5);
        assert.equal(g.state.x, 2);
    });

    it("this.style.display='none' ve this.src='' (img onerror)", () => {
        const img = { style: {}, src: 'x' };
        run(`this.src=''; this.style.background='#1e293b'; this.style.display='none'`, { thisArg: img });
        assert.deepEqual(img, { style: { background: '#1e293b', display: 'none' }, src: '' });
    });

    it('HTML özniteliğinden gelen kaçışlar: JSON.stringify çıktısı ve tırnaklar', () => {
        // jsArg(value) = escapeHtml(JSON.stringify(value)); tarayıcı öznitelik değerini çözdükten sonra yorumlayıcı JS dizesini okur
        const tricky = `a"b'c\\d\nöç</script>`;
        const attr = `selectPlan(${JSON.stringify(tricky)})`;
        const { calls } = run(attr);
        assert.deepEqual(calls[0], ['selectPlan', [tricky]]);
        const { calls: c2 } = run(`selectPlan('it\\'s "x"')`);
        assert.deepEqual(c2[0][1], [`it's "x"`]);
        const { calls: c3 } = run(`fn('\\u00f6\\x41\\n')`);
        assert.deepEqual(c3[0][1], ['öA\n']);
    });

    it('nesne/dizi değişmezleri (requestAiAnalysis türü çağrılar)', () => {
        const { calls } = run(`fn('benchmark', {b1: "A", d1: {avgHp: 1.5, list: [1,2]}, 'k-2': true}, 'panel')`);
        assert.deepEqual(calls[0][1], ['benchmark', { b1: 'A', d1: { avgHp: 1.5, list: [1, 2] }, 'k-2': true }, 'panel']);
    });

    it('!x, typeof, ikili işleçler, üçlü ve ?? / ?.', () => {
        const { calls } = run(`fn(!state.x, typeof state, 1 + 2 * 3, state.x === 1 && 'ok', state.zzz ?? 'dflt', state.zzz?.a, state.x > 0 ? 'p' : 'n')`);
        assert.deepEqual(calls[0][1], [false, 'object', 7, 'ok', 'dflt', undefined, 'p']);
    });

    it('return false => returned/false; return true / değer döndürmeyen', () => {
        assert.deepEqual(run(`fn(1); return false`).res, { returned: true, value: false });
        assert.deepEqual(run(`window.location.href='/x'; return false`, { globals: { window: { location: {} } } }).res, { returned: true, value: false });
        assert.equal(run(`fn(1)`).res.returned, false);
        // return'den sonraki ifadeler çalışmaz
        assert.equal(run(`return false; fn(1)`).calls.length, 0);
    });

    it('çağrılan işlevin kendi hatası olduğu gibi yayılır', () => {
        assert.throws(() => run(`boom()`, { globals: { boom() { throw new RangeError('x'); } } }), RangeError);
    });

    it('desteklenmeyen sözdizimi InlineActionError ile reddedilir (sessiz yutma yok)', () => {
        const bad = [
            `function(){}`, `() => 1`, `x => x`, `if (a) b()`, `var a = 1`, `new Foo()`, 'fn(`a`)', `a++`, `for(;;){}`,
            `fn(`, `fn(1,)x`, `'kapanmamis`, `a b`, `1 +`, `{`, `fn() // yorum`, `a.`, `delete a.b`, `class A{}`
        ];
        for (const src of bad) {
            assert.throws(() => IA.parseAction(src), e => e.name === 'InlineActionError', `reddedilmeli: ${src}`);
            assert.ok(IA.check(src), `check hata dönmeli: ${src}`);
        }
        assert.equal(IA.check(`fn(1)`), null);
    });

    it('çalışma zamanı: tanımsız tanımlayıcı, işlev olmayan, null üzerinde erişim -> InlineActionError', () => {
        const isIAE = e => e.name === 'InlineActionError';
        assert.throws(() => run(`yokBoyleBirSey()`), isIAE);
        assert.throws(() => run(`state.x()`), isIAE);
        assert.throws(() => run(`state.nope.deeper()`), isIAE);
        assert.throws(() => run(`nullish.a`, { globals: { nullish: null } }), isIAE);
    });

    it('güvenlik: constructor/__proto__/prototype, eval ve Function kaçışları engellenir', () => {
        const isIAE = e => e.name === 'InlineActionError';
        for (const src of [
            `fn.constructor('alert(1)')()`, `state.__proto__.x = 1`, `state['constructor']`, `state['__pro'+'to__']`,
            `eval('1')`, `Function('1')()`, `window.eval('1')`, `state.constructor.constructor('1')`, `Obj.prototype`
        ]) {
            assert.throws(() => run(src, { globals: { eval, Function, window: { eval } } }), isIAE, `engellenmeli: ${src}`);
        }
        assert.throws(() => IA.parseAction(`fn({constructor: 1})`), isIAE);
    });

    it("kaynakta dinamik kod değerlendirmesi yok (eval / new Function / Function() / setTimeout('dize'))", () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'inline-actions.js'), 'utf8');
        assert.ok(!/(^|[^A-Za-z0-9_$.])eval\s*\(/.test(src), 'eval( bulundu');
        assert.ok(!/\.eval\s*\(/.test(src), '.eval( bulundu');
        assert.ok(!/new\s+Function\b/.test(src), 'new Function bulundu');
        assert.ok(!/(^|[^A-Za-z0-9_$.])Function\s*\(/.test(src), 'Function( bulundu');
        assert.ok(!/set(Timeout|Interval)\s*\(\s*['"`]/.test(src), "setTimeout('dize') bulundu");
    });

    it('depodaki tüm data-on-* ifadeleri (şablon dizeleri dahil) yorumlayıcıda ayrıştırılır (codemod --check)', () => {
        const { spawnSync } = require('node:child_process');
        const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'codemod-inline-handlers.js'), '--check'], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /Toplam: 0 öznitelik, sorunlu: 0/, 'dönüştürülmemiş onclick= kalmamalı');
        const found = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'codemod-inline-handlers.js'), '--idents'], { encoding: 'utf8' });
        assert.equal(found.status, 0);
        const n = Number((r.stdout.match(/doğrulanan data-on-\*: (\d+)/) || [])[1]);
        assert.ok(n >= 150, 'yorumlayıcıda doğrulanan data-on-* sayısı beklenenden az: ' + n);
    });
});

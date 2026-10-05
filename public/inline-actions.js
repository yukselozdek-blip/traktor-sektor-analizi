/*
 * inline-actions.js - CSP uyumlu "satır içi olay yöneticisi" yorumlayıcısı.
 *
 * Neden: Content-Security-Policy script-src 'unsafe-inline' içermez ve script-src-attr 'none' ile satır içi
 * olay öznitelikleri (onclick="..." gibi) tümden kapalıdır. Eski `onclick="fn('x')"` işaretlemesi
 * `data-on-click="fn('x')"` olarak yazılır; bu dosya belgeye tek bir delege dinleyici kurar, öznitelikteki küçük
 * ifadeyi GÜVENLİ bir yorumlayıcı ile çalıştırır. Dinamik kod değerlendirmesi (eval ve Function yapıcısı)
 * KULLANILMAZ; 'unsafe-eval' gerekmez.
 *
 * Desteklenen sözdizimi (JS alt kümesi):
 *   - `;` ile ayrılmış ifadeler, `return [ifade]` (return false => preventDefault, satır içi davranışla aynı)
 *   - çağrılar ve zincirler: fn(a), Obj.m(a), document.getElementById('x').classList.toggle('y'), a?.b?.(c)
 *   - atamalar: a.b.c = deger, +=, -=
 *   - değerler: 'dize' "dize" sayı true false null undefined this event, [dizi], {nesne}, !x, -x, typeof x,
 *     ikili işleçler (+ - * / % == != === !== < > <= >= && || ??) ve a ? b : c
 *   - tanımlayıcılar: this (öznitelik taşıyan öğe), event, ve global (window) adlar
 * Desteklenmeyenler (function, =>, if/for, şablon dizesi, new, ++/--, ...) çalışma zamanında console.error ile
 * adı + ifadesiyle loglanır (sessiz yutma yok); bu tür kodlar adlandırılmış bir fonksiyona taşınmalıdır.
 *
 * Çekirdek (parseAction / runAction) DOM'suzdur; Node'da require ile test edilir.
 */
(function (global, factory) {
    'use strict';
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        window.InlineActions = api;
        api.install(window, document);
    }
})(this, function () {
    'use strict';

    // Güvenlik: bu üye adlarına ve genel adlara erişim yasak (Function yapıcısı / prototip zinciri kaçışları)
    var BLOCKED_MEMBERS = {
        constructor: 1, __proto__: 1, prototype: 1,
        __defineGetter__: 1, __defineSetter__: 1, __lookupGetter__: 1, __lookupSetter__: 1
    };
    var BLOCKED_GLOBALS = { eval: 1, Function: 1, execScript: 1 };

    function ActionError(message, source) {
        var e = new Error(message);
        e.name = 'InlineActionError';
        e.source = source;
        return e;
    }

    // ------------------------------------------------------------------ belirteçleme
    var PUNCT3 = ['===', '!=='];
    var PUNCT2 = ['==', '!=', '<=', '>=', '&&', '||', '??', '+=', '-=', '?.'];
    var PUNCT1 = '=+-*/%<>!?:.,;()[]{}';
    var KEYWORDS = { 'true': 1, 'false': 1, 'null': 1, 'undefined': 1, 'this': 1, 'typeof': 1, 'void': 1, 'return': 1 };
    var UNSUPPORTED_WORDS = {
        'function': 1, 'new': 1, 'if': 1, 'else': 1, 'for': 1, 'while': 1, 'do': 1, 'var': 1, 'let': 1, 'const': 1,
        'class': 1, 'delete': 1, 'in': 1, 'instanceof': 1, 'switch': 1, 'try': 1, 'throw': 1, 'async': 1, 'await': 1,
        'yield': 1, 'import': 1
    };

    function isIdStart(c) { return /[A-Za-z_$]/.test(c); }
    function isIdPart(c) { return /[A-Za-z0-9_$]/.test(c); }
    function isDigit(c) { return c >= '0' && c <= '9'; }

    function tokenize(src) {
        var tokens = [];
        var i = 0, n = src.length;
        while (i < n) {
            var c = src[i];
            if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ') { i++; continue; }
            var start = i;
            if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
                var m = /^(0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
                if (!m) throw ActionError('Geçersiz sayı', src);
                tokens.push({ t: 'num', v: Number(m[0]), pos: start });
                i += m[0].length;
                continue;
            }
            if (c === '"' || c === "'") {
                var quote = c, out = '';
                i++;
                var closed = false;
                while (i < n) {
                    var ch = src[i];
                    if (ch === quote) { closed = true; i++; break; }
                    if (ch === '\\') {
                        var nx = src[i + 1];
                        if (nx === undefined) break;
                        if (nx === 'n') { out += '\n'; i += 2; }
                        else if (nx === 't') { out += '\t'; i += 2; }
                        else if (nx === 'r') { out += '\r'; i += 2; }
                        else if (nx === 'b') { out += '\b'; i += 2; }
                        else if (nx === 'f') { out += '\f'; i += 2; }
                        else if (nx === 'v') { out += '\v'; i += 2; }
                        else if (nx === '0' && !isDigit(src[i + 2] || '')) { out += '\0'; i += 2; }
                        else if (nx === 'x') {
                            var hx = src.substr(i + 2, 2);
                            if (!/^[0-9a-fA-F]{2}$/.test(hx)) throw ActionError('Geçersiz \\x kaçışı', src);
                            out += String.fromCharCode(parseInt(hx, 16)); i += 4;
                        } else if (nx === 'u') {
                            var uh = src.substr(i + 2, 4);
                            if (src[i + 2] === '{') {
                                var close = src.indexOf('}', i + 3);
                                var cp = close > 0 ? src.slice(i + 3, close) : '';
                                if (!/^[0-9a-fA-F]{1,6}$/.test(cp)) throw ActionError('Geçersiz \\u kaçışı', src);
                                out += String.fromCodePoint(parseInt(cp, 16)); i = close + 1;
                            } else {
                                if (!/^[0-9a-fA-F]{4}$/.test(uh)) throw ActionError('Geçersiz \\u kaçışı', src);
                                out += String.fromCharCode(parseInt(uh, 16)); i += 6;
                            }
                        } else if (nx === '\n') { i += 2; }
                        else { out += nx; i += 2; }
                        continue;
                    }
                    if (ch === '\n') break;
                    out += ch; i++;
                }
                if (!closed) throw ActionError('Kapanmamış dize', src);
                tokens.push({ t: 'str', v: out, pos: start });
                continue;
            }
            if (isIdStart(c)) {
                var j = i + 1;
                while (j < n && isIdPart(src[j])) j++;
                var word = src.slice(i, j);
                if (UNSUPPORTED_WORDS[word]) throw ActionError('Desteklenmeyen sözdizimi: "' + word + '"', src);
                tokens.push({ t: KEYWORDS[word] ? 'kw' : 'id', v: word, pos: start });
                i = j;
                continue;
            }
            if (c === '`') throw ActionError('Şablon dizesi (`) desteklenmiyor', src);
            if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) throw ActionError('Yorum satırı desteklenmiyor', src);
            if (c === '=' && src[i + 1] === '>') throw ActionError('Ok işlevi (=>) desteklenmiyor', src);
            if ((c === '+' && src[i + 1] === '+') || (c === '-' && src[i + 1] === '-')) throw ActionError('++/-- desteklenmiyor', src);
            var p3 = src.substr(i, 3), p2 = src.substr(i, 2);
            if (PUNCT3.indexOf(p3) >= 0) { tokens.push({ t: 'p', v: p3, pos: start }); i += 3; continue; }
            if (PUNCT2.indexOf(p2) >= 0 && !(p2 === '?.' && isDigit(src[i + 2] || ''))) { tokens.push({ t: 'p', v: p2, pos: start }); i += 2; continue; }
            if (PUNCT1.indexOf(c) >= 0) { tokens.push({ t: 'p', v: c, pos: start }); i++; continue; }
            throw ActionError('Beklenmeyen karakter "' + c + '"', src);
        }
        tokens.push({ t: 'eof', v: '', pos: n });
        return tokens;
    }

    // ------------------------------------------------------------------ ayrıştırıcı
    var BINARY = {
        '??': 1, '||': 2, '&&': 3,
        '==': 4, '!=': 4, '===': 4, '!==': 4,
        '<': 5, '>': 5, '<=': 5, '>=': 5,
        '+': 6, '-': 6, '*': 7, '/': 7, '%': 7
    };

    function Parser(src) {
        this.src = src;
        this.toks = tokenize(src);
        this.i = 0;
    }
    Parser.prototype.peek = function () { return this.toks[this.i]; };
    Parser.prototype.next = function () { return this.toks[this.i++]; };
    Parser.prototype.is = function (v) { var t = this.peek(); return (t.t === 'p' || t.t === 'kw') && t.v === v; };
    Parser.prototype.eat = function (v) { if (this.is(v)) { this.i++; return true; } return false; };
    Parser.prototype.expect = function (v) {
        if (!this.eat(v)) throw ActionError('"' + v + '" bekleniyordu (konum ' + this.peek().pos + ')', this.src);
    };
    Parser.prototype.program = function () {
        var stmts = [];
        while (this.peek().t !== 'eof') {
            if (this.eat(';')) continue;
            stmts.push(this.statement());
            if (this.peek().t !== 'eof' && !this.is(';')) {
                throw ActionError('Beklenmeyen "' + this.peek().v + '" (konum ' + this.peek().pos + ')', this.src);
            }
        }
        return { type: 'Program', body: stmts };
    };
    Parser.prototype.statement = function () {
        if (this.is('return')) {
            this.next();
            var arg = null;
            if (this.peek().t !== 'eof' && !this.is(';')) arg = this.expression();
            return { type: 'Return', arg: arg };
        }
        return { type: 'Expr', expr: this.expression() };
    };
    Parser.prototype.expression = function () { return this.assignment(); };
    Parser.prototype.assignment = function () {
        var left = this.conditional();
        if (this.is('=') || this.is('+=') || this.is('-=')) {
            var op = this.next().v;
            if (left.type !== 'Ident' && left.type !== 'Member') throw ActionError('Geçersiz atama hedefi', this.src);
            var right = this.assignment();
            return { type: 'Assign', op: op, target: left, value: right };
        }
        return left;
    };
    Parser.prototype.conditional = function () {
        var test = this.binary(1);
        if (this.eat('?')) {
            var a = this.assignment();
            this.expect(':');
            var b = this.assignment();
            return { type: 'Cond', test: test, a: a, b: b };
        }
        return test;
    };
    Parser.prototype.binary = function (minPrec) {
        var left = this.unary();
        for (;;) {
            var t = this.peek();
            var prec = t.t === 'p' ? BINARY[t.v] : undefined;
            if (!prec || prec < minPrec) return left;
            this.next();
            var right = this.binary(prec + 1);
            left = { type: 'Binary', op: t.v, left: left, right: right };
        }
    };
    Parser.prototype.unary = function () {
        var t = this.peek();
        if ((t.t === 'p' && (t.v === '!' || t.v === '-' || t.v === '+')) || (t.t === 'kw' && (t.v === 'typeof' || t.v === 'void'))) {
            this.next();
            return { type: 'Unary', op: t.v, arg: this.unary() };
        }
        return this.postfix();
    };
    Parser.prototype.postfix = function () {
        var node = this.primary();
        for (;;) {
            if (this.eat('.')) {
                node = { type: 'Member', obj: node, prop: this.memberName(), computed: false, optional: false };
            } else if (this.eat('?.')) {
                if (this.is('(')) {
                    node = { type: 'Call', callee: node, args: this.args(), optional: true };
                } else if (this.eat('[')) {
                    var k = this.expression(); this.expect(']');
                    node = { type: 'Member', obj: node, prop: k, computed: true, optional: true };
                } else {
                    node = { type: 'Member', obj: node, prop: this.memberName(), computed: false, optional: true };
                }
            } else if (this.is('[')) {
                this.next();
                var key = this.expression(); this.expect(']');
                node = { type: 'Member', obj: node, prop: key, computed: true, optional: false };
            } else if (this.is('(')) {
                node = { type: 'Call', callee: node, args: this.args(), optional: false };
            } else {
                return node;
            }
        }
    };
    Parser.prototype.memberName = function () {
        var t = this.next();
        if (t.t !== 'id' && t.t !== 'kw') throw ActionError('Üye adı bekleniyordu (konum ' + t.pos + ')', this.src);
        return t.v;
    };
    Parser.prototype.args = function () {
        this.expect('(');
        var out = [];
        while (!this.is(')')) {
            out.push(this.assignment());
            if (!this.eat(',')) break;
        }
        this.expect(')');
        return out;
    };
    Parser.prototype.primary = function () {
        var t = this.next();
        if (t.t === 'num' || t.t === 'str') return { type: 'Lit', value: t.v };
        if (t.t === 'kw') {
            if (t.v === 'true') return { type: 'Lit', value: true };
            if (t.v === 'false') return { type: 'Lit', value: false };
            if (t.v === 'null') return { type: 'Lit', value: null };
            if (t.v === 'undefined') return { type: 'Lit', value: undefined };
            if (t.v === 'this') return { type: 'This' };
            throw ActionError('Beklenmeyen "' + t.v + '" (konum ' + t.pos + ')', this.src);
        }
        if (t.t === 'id') return { type: 'Ident', name: t.v };
        if (t.t === 'p') {
            if (t.v === '(') { var e = this.expression(); this.expect(')'); return e; }
            if (t.v === '[') {
                var items = [];
                while (!this.is(']')) { items.push(this.assignment()); if (!this.eat(',')) break; }
                this.expect(']');
                return { type: 'Array', items: items };
            }
            if (t.v === '{') {
                var props = [];
                while (!this.is('}')) {
                    var kt = this.next(), key;
                    if (kt.t === 'id' || kt.t === 'kw' || kt.t === 'str') key = String(kt.v);
                    else if (kt.t === 'num') key = String(kt.v);
                    else throw ActionError('Nesne anahtarı bekleniyordu (konum ' + kt.pos + ')', this.src);
                    if (BLOCKED_MEMBERS[key]) throw ActionError('Yasak üye adı: ' + key, this.src);
                    this.expect(':');
                    props.push({ key: key, value: this.assignment() });
                    if (!this.eat(',')) break;
                }
                this.expect('}');
                return { type: 'Object', props: props };
            }
        }
        throw ActionError('Beklenmeyen "' + (t.t === 'eof' ? 'ifade sonu' : t.v) + '" (konum ' + t.pos + ')', this.src);
    };

    var parseCache = Object.create(null);
    var parseCacheSize = 0;
    function parseAction(src) {
        if (typeof src !== 'string') throw ActionError('İfade dize olmalı', String(src));
        var hit = parseCache[src];
        if (hit) return hit;
        var ast = new Parser(src).program();
        if (parseCacheSize > 2000) { parseCache = Object.create(null); parseCacheSize = 0; }
        parseCache[src] = ast; parseCacheSize++;
        return ast;
    }

    // ------------------------------------------------------------------ değerlendirme
    function checkMember(key, src) {
        var k = typeof key === 'symbol' ? '' : String(key);
        if (BLOCKED_MEMBERS[k]) throw ActionError('Yasak üye erişimi: ' + k, src);
        return key;
    }

    function lookupGlobal(name, env) {
        if (BLOCKED_GLOBALS[name]) throw ActionError('Yasak tanımlayıcı: ' + name, env.src);
        if (name === 'event') return env.event;
        var g = env.globals;
        if (!(name in g)) throw ActionError('Tanımsız tanımlayıcı: ' + name, env.src);
        return g[name];
    }

    function evalNode(node, env) {
        switch (node.type) {
            case 'Lit': return node.value;
            case 'This': return env.thisArg;
            case 'Ident': return lookupGlobal(node.name, env);
            case 'Array': return node.items.map(function (n) { return evalNode(n, env); });
            case 'Object': {
                var o = {};
                node.props.forEach(function (p) { o[p.key] = evalNode(p.value, env); });
                return o;
            }
            case 'Unary': {
                if (node.op === 'typeof' && node.arg.type === 'Ident' && node.arg.name !== 'event' && !(node.arg.name in env.globals)) return 'undefined';
                var v = evalNode(node.arg, env);
                switch (node.op) {
                    case '!': return !v;
                    case '-': return -v;
                    case '+': return +v;
                    case 'typeof': return typeof v;
                    case 'void': return undefined;
                }
                break;
            }
            case 'Binary': {
                if (node.op === '&&') { var l1 = evalNode(node.left, env); return l1 ? evalNode(node.right, env) : l1; }
                if (node.op === '||') { var l2 = evalNode(node.left, env); return l2 ? l2 : evalNode(node.right, env); }
                if (node.op === '??') { var l3 = evalNode(node.left, env); return l3 != null ? l3 : evalNode(node.right, env); }
                var a = evalNode(node.left, env), b = evalNode(node.right, env);
                switch (node.op) {
                    case '+': return a + b;
                    case '-': return a - b;
                    case '*': return a * b;
                    case '/': return a / b;
                    case '%': return a % b;
                    case '==': return a == b; // eslint-disable-line eqeqeq
                    case '!=': return a != b; // eslint-disable-line eqeqeq
                    case '===': return a === b;
                    case '!==': return a !== b;
                    case '<': return a < b;
                    case '>': return a > b;
                    case '<=': return a <= b;
                    case '>=': return a >= b;
                }
                break;
            }
            case 'Cond': return evalNode(node.test, env) ? evalNode(node.a, env) : evalNode(node.b, env);
            case 'Member': {
                var obj = evalNode(node.obj, env);
                if (node.optional && obj == null) return undefined;
                if (obj == null) throw ActionError('null/undefined üzerinde üye erişimi: ' + describe(node.obj), env.src);
                var key = node.computed ? evalNode(node.prop, env) : node.prop;
                return obj[checkMember(key, env.src)];
            }
            case 'Call': return evalCall(node, env);
            case 'Assign': return evalAssign(node, env);
        }
        throw ActionError('Desteklenmeyen düğüm: ' + node.type, env.src);
    }

    function describe(node) {
        if (node.type === 'Ident') return node.name;
        if (node.type === 'This') return 'this';
        if (node.type === 'Member') return describe(node.obj) + (node.computed ? '[...]' : '.' + node.prop);
        if (node.type === 'Call') return describe(node.callee) + '(...)';
        return node.type;
    }

    function evalCall(node, env) {
        var callee = node.callee, fn, self;
        if (callee.type === 'Member') {
            self = evalNode(callee.obj, env);
            if (callee.optional && self == null) return undefined;
            if (self == null) throw ActionError('null/undefined üzerinde çağrı: ' + describe(callee.obj), env.src);
            var key = callee.computed ? evalNode(callee.prop, env) : callee.prop;
            fn = self[checkMember(key, env.src)];
        } else {
            fn = evalNode(callee, env);
            self = env.globals;
        }
        if (node.optional && fn == null) return undefined;
        if (typeof fn !== 'function') throw ActionError(describe(callee) + ' bir işlev değil', env.src);
        if (fn === env.globals.Function || fn === env.globals.eval) throw ActionError('Yasak işlev', env.src);
        var args = node.args.map(function (a) { return evalNode(a, env); });
        return fn.apply(self, args);
    }

    function evalAssign(node, env) {
        var t = node.target, obj, key;
        if (t.type === 'Ident') {
            if (BLOCKED_GLOBALS[t.name]) throw ActionError('Yasak tanımlayıcı: ' + t.name, env.src);
            obj = env.globals; key = t.name;
            if (node.op !== '=' && !(key in obj)) throw ActionError('Tanımsız tanımlayıcı: ' + key, env.src);
        } else {
            obj = evalNode(t.obj, env);
            if (obj == null) throw ActionError('null/undefined üzerine atama: ' + describe(t.obj), env.src);
            key = checkMember(t.computed ? evalNode(t.prop, env) : t.prop, env.src);
        }
        var val = evalNode(node.value, env);
        if (node.op === '+=') val = obj[key] + val;
        else if (node.op === '-=') val = obj[key] - val;
        obj[key] = val;
        return val;
    }

    // ctx: { thisArg, event, globals }. Dönüş: { returned: bool, value }
    function runAction(src, ctx) {
        var ast = parseAction(src);
        var env = {
            src: src,
            thisArg: ctx && ctx.thisArg,
            event: ctx && ctx.event,
            globals: (ctx && ctx.globals) || (typeof globalThis !== 'undefined' ? globalThis : {})
        };
        for (var i = 0; i < ast.body.length; i++) {
            var st = ast.body[i];
            if (st.type === 'Return') {
                return { returned: true, value: st.arg ? evalNode(st.arg, env) : undefined };
            }
            evalNode(st.expr, env);
        }
        return { returned: false, value: undefined };
    }

    // Ayrıştırılabilir mi? (kod dönüştürücü ve testler için). Dönüş: null (tamam) veya hata iletisi.
    function check(src) {
        try { parseAction(src); return null; } catch (e) { return e.message; }
    }

    // ------------------------------------------------------------------ DOM bağlama
    var BUBBLING = ['click', 'dblclick', 'change', 'input', 'keydown', 'keyup', 'keypress', 'submit',
        'mousedown', 'mouseup', 'mouseover', 'mouseout', 'contextmenu', 'reset', 'select', 'toggle'];
    var CAPTURED = ['error', 'load', 'focus', 'blur'];

    function install(win, doc) {
        if (win.__inlineActionsInstalled) return;
        win.__inlineActionsInstalled = true;

        function report(err, expr, attr) {
            if (err && err.name === 'InlineActionError') {
                // Yorumlanamayan ifade: sessiz yutma yok, adı + ifadesiyle logla
                if (win.console && win.console.error) win.console.error('[inline-actions] ' + attr + ' yorumlanamadı: ' + err.message + ' | ifade: ' + expr);
            } else {
                // Çağrılan işlevin kendi hatası: satır içi yöneticideki gibi yakalanmamış hata olarak yüzeye çıkar
                win.setTimeout(function () { throw err; }, 0);
            }
        }

        function wrapEvent(ev, el, state) {
            return new Proxy(ev, {
                get: function (target, prop) {
                    if (prop === 'currentTarget') return el;
                    if (prop === 'stopPropagation' || prop === 'stopImmediatePropagation') {
                        return function () { state.stopped = true; return target.stopImmediatePropagation(); };
                    }
                    var v = Reflect.get(target, prop, target);
                    return typeof v === 'function' ? v.bind(target) : v;
                }
            });
        }

        function handle(ev, attr, capture) {
            var node = ev.target;
            if (!node || node.nodeType !== 1) node = node && node.parentElement;
            if (!node || !node.closest) return;
            var state = { stopped: false };
            while (node && node.nodeType === 1) {
                var el = capture ? node : node.closest('[' + attr + ']');
                if (!el) return;
                var expr = el.getAttribute(attr);
                if (expr) {
                    try {
                        var res = runAction(expr, { thisArg: el, event: wrapEvent(ev, el, state), globals: win });
                        if (res.returned && res.value === false) ev.preventDefault();
                    } catch (err) {
                        report(err, expr, attr);
                    }
                }
                if (capture || state.stopped) return;
                node = el.parentElement; // olay kabarcığı: dıştaki öğelerin yöneticileri de (satır içi davranışla aynı) çalışır
            }
        }

        BUBBLING.forEach(function (name) {
            var attr = 'data-on-' + name;
            doc.addEventListener(name, function (ev) { handle(ev, attr, false); });
        });
        CAPTURED.forEach(function (name) {
            var attr = 'data-on-' + name;
            doc.addEventListener(name, function (ev) {
                var t = ev.target;
                if (!t || t.nodeType !== 1 || !t.hasAttribute || !t.hasAttribute(attr)) return;
                handle(ev, attr, true);
            }, true);
        });
    }

    return {
        parseAction: parseAction,
        runAction: runAction,
        check: check,
        install: install,
        ActionError: ActionError
    };
});

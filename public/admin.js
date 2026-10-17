/* Yönetim konsolu (/admin). Çerçevesiz düz JS. Satır içi olay yok (CSP): tüm etkileşim
   data-act / data-change / data-form öznitelikleri ve olay temsilcisi (delegation) ile çalışır. */
(function () {
    'use strict';

    var API = '/api/admin/console';
    var PAGE_SIZE = 50;

    var ROUTES = {
        overview: { title: 'Genel Bakış', perm: 'dashboard.view' },
        orgs: { title: 'Kurumlar', perm: 'orgs.read' },
        users: { title: 'Kullanıcılar', perm: 'users.read' },
        staff: { title: 'Ekip & Roller', perm: 'staff.manage' },
        features: { title: 'Özellikler', perm: 'orgs.read' },
        audit: { title: 'Denetim Kaydı', perm: 'audit.read' }
    };
    var ROUTE_ORDER = ['overview', 'orgs', 'users', 'staff', 'features', 'audit'];

    var STATUS_LABELS = { trial: 'Deneme', active: 'Aktif', suspended: 'Askıda', expired: 'Süresi doldu' };
    var STATUS_KIND = { trial: 'info', active: 'ok', suspended: 'danger', expired: 'muted' };
    var STATUS_OPTIONS = [['trial', 'Deneme'], ['active', 'Aktif'], ['suspended', 'Askıda'], ['expired', 'Süresi doldu']];
    var BILLING_OPTIONS = [['contract', 'Sözleşme'], ['invoice', 'Fatura'], ['card', 'Kart'], ['free', 'Ücretsiz']];
    var BILLING_LABELS = { contract: 'Sözleşme', invoice: 'Fatura', card: 'Kart', free: 'Ücretsiz' };
    var MEMBER_ROLE_OPTIONS = [['member', 'Üye'], ['org_admin', 'Kurum yöneticisi']];
    var JOINED_LABELS = { admin: 'Yönetici ekledi', domain: 'Alan adı', invitation: 'Davet', org_admin: 'Kurum yöneticisi' };
    var DEFAULT_ROLE_NAMES = {
        super_admin: 'Süper Yönetici',
        account_manager: 'Müşteri Yöneticisi',
        support: 'Destek',
        finance: 'Finans',
        viewer: 'Salt Okunur'
    };
    var LIMIT_LABELS = {
        max_rivals: 'En fazla rakip sayısı',
        history_months: 'Geçmiş veri (ay)',
        ai_queries_monthly: 'Aylık AI sorgusu',
        export_rows_monthly: 'Aylık dışa aktarma satırı',
        api_requests_monthly: 'Aylık API isteği',
        whatsapp_phones: 'WhatsApp telefon sayısı'
    };
    var TAB_DEFS = [
        { key: 'general', label: 'Genel & Sözleşme' },
        { key: 'members', label: 'Üyeler' },
        { key: 'domains', label: 'Alan adları' },
        { key: 'features', label: 'Özellik & Limitler' }
    ];
    var ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;

    var state = {
        me: null,
        perms: [],
        refs: { brands: null, plans: null, features: null, roles: null, catalog: null },
        filters: {
            orgs: { q: '', status: '' },
            users: { q: '', status: '', kind: '', page: 1 },
            audit: { action: '', actor: '', page: 1 }
        },
        orgId: null,
        org: null,
        orgTab: 'general',
        userDetail: null,
        seq: 0,
        dlgSeq: 0
    };

    var viewEl = null;
    var regionEl = null;

    /* ---------- Yardımcılar ---------- */

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function arr(v) { return Array.isArray(v) ? v : []; }

    function pairOpts(pairs) {
        return pairs.map(function (p) { return { value: p[0], label: p[1] }; });
    }

    function listOf(d, keys) {
        if (Array.isArray(d)) return d;
        for (var i = 0; i < keys.length; i++) {
            if (d && Array.isArray(d[keys[i]])) return d[keys[i]];
        }
        return [];
    }

    function findById(list, id) {
        var found = arr(list).filter(function (x) { return String(x.id) === String(id); });
        return found[0] || null;
    }

    function uniq(list) {
        return list.filter(function (x, i) { return list.indexOf(x) === i; });
    }

    function fmtNum(n) { return Number(n || 0).toLocaleString('tr-TR'); }

    function fmtDate(v) {
        if (!v) return '—';
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
        if (m) return m[3] + '.' + m[2] + '.' + m[1];
        var d = new Date(v);
        return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('tr-TR');
    }

    function fmtDateTime(v) {
        if (!v) return '—';
        var d = new Date(v);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function toDateInput(v) {
        var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ''));
        return m ? m[1] : '';
    }

    function daysUntil(v) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
        if (!m) return null;
        var end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        var now = new Date();
        now.setHours(0, 0, 0, 0);
        return Math.round((end - now) / 86400000);
    }

    function buildQuery(obj) {
        var p = new URLSearchParams();
        Object.keys(obj).forEach(function (k) {
            var v = obj[k];
            if (v === '' || v === null || v === undefined) return;
            p.set(k, String(v));
        });
        var s = p.toString();
        return s ? '?' + s : '';
    }

    function selectOptions(pairs, selected) {
        return pairs.map(function (p) {
            var v = String(p[0]);
            return '<option value="' + escapeHtml(v) + '"' + (v === String(selected == null ? '' : selected) ? ' selected' : '') + '>' + escapeHtml(p[1]) + '</option>';
        }).join('');
    }

    function badge(kind, text) {
        return '<span class="badge badge-' + kind + '">' + escapeHtml(text) + '</span>';
    }

    function statusBadge(s) {
        return badge(STATUS_KIND[s] || 'muted', STATUS_LABELS[s] || s || '—');
    }

    function effBadge(v) {
        return v ? badge('ok', 'Geçerli') : badge('danger', 'Geçerli değil');
    }

    function seatBar(used, limit) {
        var u = Number(used) || 0;
        var l = Number(limit) || 0;
        var pct = l > 0 ? Math.min(100, Math.round(u / l * 100)) : 0;
        var label = fmtNum(u) + ' / ' + fmtNum(l);
        return '<div class="seat"><span class="seat-text">' + escapeHtml(label) + '</span>' +
            '<div class="progress' + (l > 0 && u >= l ? ' is-full' : '') + '" role="progressbar" aria-label="Koltuk kullanımı" aria-valuemin="0" aria-valuemax="' + l + '" aria-valuenow="' + u + '" aria-valuetext="' + escapeHtml(label + ' koltuk kullanımda') + '">' +
            '<span style="width:' + pct + '%"></span></div></div>';
    }

    function emptyRow(cols, text) {
        return '<tr><td class="empty" colspan="' + cols + '">' + escapeHtml(text) + '</td></tr>';
    }

    function tableHtml(caption, headers, rowsHtml) {
        return '<div class="table-wrap" tabindex="0"><table class="data-table"><caption class="sr-only">' + escapeHtml(caption) + '</caption>' +
            '<thead><tr>' + headers.map(function (h) { return '<th scope="col">' + escapeHtml(h) + '</th>'; }).join('') + '</tr></thead>' +
            '<tbody>' + rowsHtml + '</tbody></table></div>';
    }

    function loadingHtml(text) {
        return '<p class="loading" role="status">' + escapeHtml(text || 'Yükleniyor…') + '</p>';
    }

    function errorHtml(message) {
        return '<div class="error-box" role="alert"><p>' + escapeHtml(message || 'Bir hata oluştu.') + '</p>' +
            '<button type="button" class="btn btn-secondary" data-act="retry">Yeniden dene</button></div>';
    }

    function noAccessHtml() {
        return '<section class="empty-state"><i class="fas fa-lock" aria-hidden="true"></i>' +
            '<h2>Bu alana erişim yetkiniz yok</h2>' +
            '<p>Gerekli yetki için süper yöneticiyle iletişime geçin.</p></section>';
    }

    function pagerHtml(target, page, total) {
        var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        return '<nav class="pager" aria-label="Sayfalama">' +
            '<button type="button" class="btn btn-secondary" data-act="page" data-target="' + target + '" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>Önceki</button>' +
            '<span class="pager-text">Sayfa ' + page + ' / ' + pages + ' · Toplam ' + fmtNum(total) + ' kayıt</span>' +
            '<button type="button" class="btn btn-secondary" data-act="page" data-target="' + target + '" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>Sonraki</button>' +
            '</nav>';
    }

    function fact(label, valueHtml) {
        return '<div class="fact"><dt>' + escapeHtml(label) + '</dt><dd>' + valueHtml + '</dd></div>';
    }

    function contractHtml(o) {
        if (!o.contract_start && !o.contract_end) return 'Süresiz';
        var parts = [];
        if (o.contract_start) parts.push('Başlangıç: ' + fmtDate(o.contract_start));
        parts.push('Bitiş: ' + (o.contract_end ? fmtDate(o.contract_end) : 'Süresiz'));
        return escapeHtml(parts.join(' · '));
    }

    function roleName(key) {
        var roles = state.refs.roles || [];
        for (var i = 0; i < roles.length; i++) {
            if (roles[i].key === key) return roles[i].name || key;
        }
        return DEFAULT_ROLE_NAMES[key] || key || '—';
    }

    function permName(key) {
        var cat = state.refs.catalog || [];
        for (var i = 0; i < cat.length; i++) {
            if (cat[i].key === key) return cat[i].name || key;
        }
        return key;
    }

    function rolePerms(role) {
        var p = arr(role.permissions);
        if (p.indexOf('*') !== -1) return arr(state.refs.catalog).map(function (c) { return c.key; });
        return p;
    }

    function planBySlug(slug) {
        var plans = state.refs.plans || [];
        for (var i = 0; i < plans.length; i++) {
            if (plans[i].slug === slug) return plans[i];
        }
        return null;
    }

    function planName(slug) {
        var p = planBySlug(slug);
        return p ? (p.name || p.slug) : slug;
    }

    function planFeatureKeys(plan) {
        return arr(plan && plan.feature_keys).map(function (k) { return typeof k === 'string' ? k : k.key; });
    }

    function limitKeys() {
        var keys = Object.keys(LIMIT_LABELS);
        arr(state.refs.plans).forEach(function (p) {
            Object.keys(p.plan_limits || {}).forEach(function (k) {
                if (keys.indexOf(k) === -1) keys.push(k);
            });
        });
        return keys;
    }

    function limitValueLabel(v) {
        if (v === -1) return 'Sınırsız';
        return fmtNum(v);
    }

    function isSuper() { return !!(state.me && state.me.is_superuser); }

    function can(perm) {
        if (!state.me) return false;
        return isSuper() || state.perms.indexOf(perm) !== -1;
    }

    function canRoute(name) {
        return !!ROUTES[name] && can(ROUTES[name].perm);
    }

    function myId() {
        return state.me && state.me.user ? Number(state.me.user.id) : null;
    }

    /* ---------- Ağ ---------- */

    function redirectToLogin() {
        window.location.replace('/login.html');
    }

    async function api(method, path, body) {
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, 20000);
        var opts = {
            method: method,
            credentials: 'same-origin',
            cache: 'no-store',
            signal: ctrl.signal,
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-Web-Session': '1', 'Accept': 'application/json' }
        };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        var res;
        try {
            res = await fetch(path, opts);
        } catch (e) {
            var netErr = new Error(e && e.name === 'AbortError' ? 'İstek zaman aşımına uğradı.' : 'Bağlantı hatası. Lütfen tekrar deneyin.');
            netErr.status = 0;
            throw netErr;
        } finally {
            clearTimeout(timer);
        }
        var data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (res.status === 401) {
            redirectToLogin();
            var unauth = new Error('Oturum gerekli.');
            unauth.status = 401;
            throw unauth;
        }
        if (!res.ok) {
            var err = new Error((data && data.error) || ('İstek başarısız (HTTP ' + res.status + ')'));
            err.status = res.status;
            err.code = data && data.code;
            throw err;
        }
        return data;
    }

    /* Yazma işlemi: başarıda true, hatada toast gösterip false döner. */
    async function action(fn, okMsg) {
        try {
            await fn();
            if (okMsg) toast('ok', okMsg);
            return true;
        } catch (e) {
            if (e && e.status !== 401) toast('err', (e && e.message) || 'İşlem tamamlanamadı.');
            return false;
        }
    }

    function ensureRef(name) {
        if (state.refs[name]) return Promise.resolve(state.refs[name]);
        var paths = { brands: API + '/brands', plans: API + '/plans', features: API + '/features' };
        var keys = { brands: ['brands', 'items'], plans: ['plans', 'items'], features: ['features', 'flags', 'items'] };
        return api('GET', paths[name]).then(function (d) {
            state.refs[name] = listOf(d, keys[name]);
            return state.refs[name];
        }, function (e) {
            if (e && e.status === 401) throw e;
            return [];
        });
    }

    function ensureRoles() {
        if (state.refs.roles) return Promise.resolve(state.refs.roles);
        return api('GET', API + '/roles').then(function (d) {
            state.refs.roles = listOf(d, ['roles', 'items']);
            state.refs.catalog = listOf(d, ['permission_catalog', 'catalog', 'permissions']);
            return state.refs.roles;
        });
    }

    /* ---------- Bildirim ---------- */

    function toast(kind, message) {
        if (!regionEl) return;
        var t = document.createElement('div');
        t.className = 'toast toast-' + (kind === 'err' ? 'err' : 'ok');
        t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
        t.textContent = message;
        regionEl.appendChild(t);
        setTimeout(function () { t.remove(); }, kind === 'err' ? 8000 : 4500);
    }

    /* ---------- Form yardımcıları ---------- */

    function fieldHtml(f, prefix) {
        var id = prefix + '_' + f.name;
        var help = f.help ? '<p class="field-help" id="' + id + '_h">' + escapeHtml(f.help) + '</p>' : '';
        var desc = f.help ? ' aria-describedby="' + id + '_h"' : '';
        var cls = 'field' + (f.wide ? ' wide' : '');
        var req = f.required ? ' required' : '';
        var star = f.required ? ' <span class="req" aria-hidden="true">*</span>' : '';
        var val = f.value == null ? '' : f.value;

        if (f.type === 'checkbox') {
            return '<div class="' + cls + ' field-check"><label class="check-label" for="' + id + '">' +
                '<input type="checkbox" id="' + id + '" name="' + f.name + '"' + (val === true ? ' checked' : '') + desc + '> ' +
                '<span>' + escapeHtml(f.label) + '</span></label>' + help + '</div>';
        }

        if (f.type === 'checks') {
            var sel = Array.isArray(f.value) ? f.value : [];
            var items = arr(f.options).map(function (o, i) {
                var cid = id + '_' + i;
                return '<label class="check-item" for="' + cid + '"><input type="checkbox" id="' + cid + '" name="' + f.name + '" value="' + escapeHtml(o.value) + '"' +
                    (sel.indexOf(o.value) !== -1 ? ' checked' : '') + '> <span>' + escapeHtml(o.label) + '</span></label>';
            }).join('');
            return '<fieldset class="' + cls + ' fieldset"><legend>' + escapeHtml(f.label) + star + '</legend>' + help +
                '<div class="check-grid">' + items + '</div></fieldset>';
        }

        if (f.type === 'select') {
            var opts = arr(f.options).map(function (o) {
                var v = String(o.value);
                return '<option value="' + escapeHtml(v) + '"' + (v === String(val) ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>';
            }).join('');
            return '<div class="' + cls + '"><label for="' + id + '">' + escapeHtml(f.label) + star + '</label>' +
                '<select id="' + id + '" name="' + f.name + '"' + req + desc + '>' + opts + '</select>' + help + '</div>';
        }

        if (f.type === 'textarea') {
            return '<div class="' + cls + '"><label for="' + id + '">' + escapeHtml(f.label) + star + '</label>' +
                '<textarea id="' + id + '" name="' + f.name + '" rows="3"' + (f.maxlength ? ' maxlength="' + f.maxlength + '"' : '') + desc + '>' + escapeHtml(val) + '</textarea>' + help + '</div>';
        }

        var extra = '';
        if (f.placeholder) extra += ' placeholder="' + escapeHtml(f.placeholder) + '"';
        if (f.maxlength) extra += ' maxlength="' + f.maxlength + '"';
        if (f.min != null) extra += ' min="' + f.min + '"';
        if (f.max != null) extra += ' max="' + f.max + '"';
        if (f.type === 'number') extra += ' step="1" inputmode="numeric"';
        return '<div class="' + cls + '"><label for="' + id + '">' + escapeHtml(f.label) + star + '</label>' +
            '<input id="' + id + '" name="' + f.name + '" type="' + (f.type || 'text') + '"' + req + desc +
            ' value="' + escapeHtml(val) + '"' + extra + ' autocomplete="off">' + help + '</div>';
    }

    function fieldsHtml(defs, prefix) {
        return defs.map(function (f) { return fieldHtml(f, prefix); }).join('');
    }

    function readForm(form, defs) {
        var out = {};
        defs.forEach(function (f) {
            if (f.type === 'checkbox') {
                var c = form.querySelector('input[name="' + f.name + '"]');
                out[f.name] = !!(c && c.checked);
            } else if (f.type === 'checks') {
                out[f.name] = Array.prototype.map.call(form.querySelectorAll('input[name="' + f.name + '"]:checked'), function (i) { return i.value; });
            } else {
                var el = form.querySelector('[name="' + f.name + '"]');
                out[f.name] = el ? String(el.value).trim() : '';
            }
        });
        return out;
    }

    function validateValues(defs, vals) {
        for (var i = 0; i < defs.length; i++) {
            var f = defs[i];
            var v = vals[f.name];
            if (f.required && (v === '' || v === undefined || v === null)) return f.label + ' alanı zorunludur.';
            if (f.type === 'number' && v !== '' && v !== undefined) {
                var n = Number(v);
                if (!Number.isInteger(n) || (f.min != null && n < f.min) || (f.max != null && n > f.max)) {
                    return f.label + ' için ' + (f.min != null ? f.min : '') + (f.max != null ? ' ile ' + f.max + ' arasında' : ' geçerli') + ' bir tam sayı girin.';
                }
            }
        }
        return null;
    }

    function defaultsOf(defs) {
        var o = {};
        defs.forEach(function (d) { o[d.name] = d.value; });
        return o;
    }

    /* ---------- Diyalog ---------- */

    function openFormDialog(opts) {
        return new Promise(function (resolve) {
            var uid = 'dlg' + (++state.dlgSeq);
            var opener = document.activeElement;
            var defs = opts.fields || [];
            var dlg = document.createElement('dialog');
            dlg.className = 'dialog';
            dlg.setAttribute('aria-labelledby', uid + 'T');
            dlg.innerHTML =
                '<form class="dialog-form" novalidate>' +
                '<div class="dialog-head"><h2 id="' + uid + 'T">' + escapeHtml(opts.title) + '</h2>' +
                '<button type="button" class="icon-btn" data-dlg-close aria-label="Pencereyi kapat"><i class="fas fa-xmark" aria-hidden="true"></i></button></div>' +
                (opts.intro ? '<p class="dialog-intro">' + escapeHtml(opts.intro) + '</p>' : '') +
                (defs.length ? '<div class="dialog-body">' + fieldsHtml(defs, uid) + '</div>' : '') +
                '<p class="form-error" role="alert" hidden></p>' +
                '<div class="dialog-foot"><button type="button" class="btn btn-secondary" data-dlg-close>Vazgeç</button>' +
                '<button type="submit" class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '">' + escapeHtml(opts.submitLabel || 'Kaydet') + '</button></div>' +
                '</form>';
            document.body.appendChild(dlg);

            var form = dlg.querySelector('form');
            var errEl = dlg.querySelector('.form-error');
            var submitBtn = dlg.querySelector('button[type="submit"]');
            var outcome = null;

            dlg.addEventListener('close', function () {
                dlg.remove();
                if (opener && typeof opener.focus === 'function' && document.body.contains(opener)) opener.focus();
                resolve(outcome);
            });
            dlg.querySelectorAll('[data-dlg-close]').forEach(function (b) {
                b.addEventListener('click', function () { dlg.close(); });
            });
            form.addEventListener('submit', async function (ev) {
                ev.preventDefault();
                errEl.hidden = true;
                var vals = readForm(form, defs);
                var msg = validateValues(defs, vals);
                if (msg) {
                    errEl.textContent = msg;
                    errEl.hidden = false;
                    return;
                }
                submitBtn.disabled = true;
                try {
                    var r = opts.onSubmit ? await opts.onSubmit(vals) : true;
                    outcome = r === undefined ? true : r;
                    dlg.close();
                } catch (e) {
                    if (!e || e.status !== 401) {
                        errEl.textContent = (e && e.message) || 'İşlem tamamlanamadı.';
                        errEl.hidden = false;
                    }
                } finally {
                    submitBtn.disabled = false;
                }
            });

            dlg.showModal();
            var first = form.querySelector('.dialog-body input, .dialog-body select, .dialog-body textarea');
            if (first) first.focus();
        });
    }

    function confirmDialog(title, message, label, danger) {
        return openFormDialog({
            title: title,
            intro: message,
            fields: [],
            submitLabel: label || 'Onayla',
            danger: !!danger,
            onSubmit: function () { return true; }
        });
    }

    /* ---------- Kabuk, yönlendirme ---------- */

    function setTitle(text) {
        var h = document.getElementById('pageTitle');
        if (h) h.textContent = text;
        document.title = text + ' · Yönetim · Traktör Sektör Analizi';
    }

    function setView(html) {
        if (viewEl) viewEl.innerHTML = html;
    }

    function resultsEl() { return document.getElementById('resultsArea'); }

    /* Liste sonuçlarını #resultsArea içinde yükler; hata ve yükleme durumlarını yönetir. */
    function inResults(fn) {
        var seq = state.seq;
        var box = resultsEl();
        if (box) box.innerHTML = loadingHtml();
        return Promise.resolve().then(fn).then(function (html) {
            if (seq === state.seq && resultsEl()) resultsEl().innerHTML = html;
        }, function (e) {
            if (e && e.status === 401) return;
            if (seq === state.seq && resultsEl()) resultsEl().innerHTML = errorHtml(e && e.message);
        });
    }

    function applyNavPermissions() {
        document.querySelectorAll('[data-route]').forEach(function (a) {
            a.hidden = !canRoute(a.getAttribute('data-route'));
        });
    }

    function currentRoute() {
        var parts = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
        return { name: ROUTES[parts[0]] ? parts[0] : null, id: parts[1] || null };
    }

    function firstAllowed() {
        for (var i = 0; i < ROUTE_ORDER.length; i++) {
            if (canRoute(ROUTE_ORDER[i])) return ROUTE_ORDER[i];
        }
        return null;
    }

    function route() {
        if (!state.me) return;
        var seq = ++state.seq;
        var cur = currentRoute();
        var name = cur.name || firstAllowed() || 'overview';

        document.querySelectorAll('[data-route]').forEach(function (a) {
            if (a.getAttribute('data-route') === name) a.setAttribute('aria-current', 'page');
            else a.removeAttribute('aria-current');
        });

        if (!canRoute(name)) {
            setTitle(ROUTES[name] ? ROUTES[name].title : 'Erişim yok');
            setView(noAccessHtml());
            return;
        }

        var handlers = {
            overview: renderOverview,
            orgs: cur.id ? renderOrgDetail : renderOrgs,
            users: cur.id ? renderUserDetail : renderUsers,
            staff: renderStaff,
            features: renderFeatures,
            audit: renderAudit
        };
        var fn = handlers[name];
        window.scrollTo(0, 0);
        Promise.resolve().then(function () { return fn(seq, cur.id); }).catch(function (e) {
            if (e && e.status === 401) return;
            if (seq === state.seq) setView(errorHtml(e && e.message));
        });
    }

    async function loadMe() {
        setView(loadingHtml('Yönetim paneli yükleniyor…'));
        try {
            state.me = await api('GET', API + '/me');
        } catch (e) {
            if (e && e.status === 401) return;
            if (e && e.status === 403) {
                setTitle('Erişim yok');
                setView(noAccessHtml());
                return;
            }
            setView(errorHtml(e && e.message));
            return;
        }
        state.perms = arr(state.me.permissions);
        var u = state.me.user || {};
        var display = u.full_name || u.email || '';
        document.getElementById('userName').textContent = display;
        document.getElementById('userRole').textContent = state.me.role_name || (isSuper() ? 'Süper Yönetici' : 'Ekip üyesi');
        document.getElementById('userAvatar').textContent = (display || 'Y').charAt(0).toUpperCase();
        applyNavPermissions();
        window.addEventListener('hashchange', route);
        route();
    }

    /* ---------- Olay temsilcileri ---------- */

    var ACTIONS = {};
    var FORMS = {};
    var CHANGES = {};

    function onViewClick(ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!t || t.disabled) return;
        var fn = ACTIONS[t.getAttribute('data-act')];
        if (fn) {
            ev.preventDefault();
            fn(t, ev);
        }
    }

    function onViewSubmit(ev) {
        var f = ev.target;
        var name = f && f.getAttribute ? f.getAttribute('data-form') : null;
        if (!name) return;
        ev.preventDefault();
        if (FORMS[name]) FORMS[name](f);
    }

    function onViewChange(ev) {
        var t = ev.target;
        var name = t && t.getAttribute ? t.getAttribute('data-change') : null;
        if (name && CHANGES[name]) CHANGES[name](t);
    }

    function onViewKeydown(ev) {
        var t = ev.target;
        if (!t || !t.getAttribute || t.getAttribute('role') !== 'tab') return;
        var tabs = Array.prototype.slice.call(t.parentNode.querySelectorAll('[role="tab"]'));
        var i = tabs.indexOf(t);
        var next = null;
        if (ev.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
        else if (ev.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (ev.key === 'Home') next = tabs[0];
        else if (ev.key === 'End') next = tabs[tabs.length - 1];
        if (next) {
            ev.preventDefault();
            next.click();
        }
    }

    function logout() {
        var go = function () { window.location.href = '/login.html'; };
        fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-Web-Session': '1' }
        }).then(go, go);
    }

    ACTIONS.retry = function () { route(); };

    ACTIONS.page = function (btn) {
        var target = btn.getAttribute('data-target');
        var p = Number(btn.getAttribute('data-page'));
        if (!(p >= 1) || !state.filters[target]) return;
        state.filters[target].page = p;
        var load = target === 'users' ? loadUsers : loadAudit;
        load().then(function () {
            var r = resultsEl();
            if (r) r.focus();
        });
    };

    /* ---------- Genel Bakış ---------- */

    function kpiHtml(label, value, subHtml, icon) {
        return '<div class="kpi"><div class="kpi-icon" aria-hidden="true"><i class="fas ' + icon + '"></i></div>' +
            '<div class="kpi-body"><p class="kpi-label">' + escapeHtml(label) + '</p>' +
            '<p class="kpi-value">' + escapeHtml(value) + '</p>' +
            (subHtml ? '<div class="kpi-sub">' + subHtml + '</div>' : '') + '</div></div>';
    }

    function auditRowHtml(r) {
        var who = r.actor_email || (r.actor_user_id ? 'Kullanıcı #' + r.actor_user_id : 'Sistem');
        var target = [r.target_type, r.target_id != null ? '#' + r.target_id : ''].filter(Boolean).join(' ');
        return '<tr><td>' + escapeHtml(fmtDateTime(r.created_at)) + '</td><td>' + escapeHtml(who) + '</td>' +
            '<td><code>' + escapeHtml(r.action) + '</code></td><td>' + escapeHtml(target || '—') + '</td></tr>';
    }

    async function renderOverview(seq) {
        setTitle('Genel Bakış');
        setView(loadingHtml());
        var ov = (await api('GET', API + '/overview')) || {};
        if (seq !== state.seq) return;
        var u = ov.users || {};
        var o = ov.organizations || {};
        var bs = o.by_status || {};
        var seats = ov.seats || {};
        var kpis = [
            kpiHtml('Toplam kullanıcı', fmtNum(u.total), escapeHtml('Son 30 günde ' + fmtNum(u.new_30d) + ' yeni'), 'fa-users'),
            kpiHtml('Aktif kullanıcı', fmtNum(u.active), '', 'fa-user-check'),
            kpiHtml('Aktif kişisel abonelik', fmtNum(ov.active_subscriptions), '', 'fa-id-card'),
            kpiHtml('Aktif kurum', fmtNum(bs.active), escapeHtml('Toplam ' + fmtNum(o.total) + ' kurum'), 'fa-building'),
            kpiHtml('Koltuk kullanımı', fmtNum(seats.used) + ' / ' + fmtNum(seats.total), seatBar(seats.used, seats.total), 'fa-chair'),
            kpiHtml('Askıda veya süresi dolmuş', fmtNum(Number(bs.suspended || 0) + Number(bs.expired || 0)), '', 'fa-triangle-exclamation')
        ].join('');

        var exp = arr(ov.expiring_contracts);
        var expRows = exp.map(function (x) {
            var d = daysUntil(x.contract_end);
            var left = d == null ? '—' : (d <= 0 ? 'Bugün' : d + ' gün');
            return '<tr><th scope="row"><a href="#/orgs/' + escapeHtml(x.id) + '">' + escapeHtml(x.name) + '</a></th>' +
                '<td>' + escapeHtml(x.plan_name || x.plan_slug || '—') + '</td>' +
                '<td>' + escapeHtml(fmtDate(x.contract_end)) + '</td>' +
                '<td>' + escapeHtml(left) + '</td>' +
                '<td>' + seatBar(x.seats_used, x.seat_limit) + '</td>' +
                '<td>' + statusBadge(x.status) + '</td></tr>';
        }).join('');

        var recent = arr(ov.recent_audit).map(auditRowHtml).join('');

        setView(
            '<div class="kpi-grid">' + kpis + '</div>' +
            '<section class="section"><h2>30 gün içinde bitecek sözleşmeler</h2>' +
            tableHtml('30 gün içinde bitecek sözleşmeler', ['Kurum', 'Plan', 'Bitiş', 'Kalan süre', 'Koltuk', 'Durum'],
                expRows || emptyRow(6, 'Önümüzdeki 30 gün içinde biten sözleşme yok.')) + '</section>' +
            '<section class="section"><div class="section-head"><h2>Son işlemler</h2>' +
            (can('audit.read') ? '<a href="#/audit">Tüm kayıtlar</a>' : '') + '</div>' +
            tableHtml('Son denetim kayıtları', ['Zaman', 'Kişi', 'İşlem', 'Hedef'], recent || emptyRow(4, 'Henüz kayıt yok.')) + '</section>'
        );
    }

    /* ---------- Kurumlar ---------- */

    function orgRowHtml(o) {
        return '<tr><th scope="row"><a href="#/orgs/' + escapeHtml(o.id) + '">' + escapeHtml(o.name) + '</a></th>' +
            '<td>' + escapeHtml(o.brand_name || '—') + '</td>' +
            '<td>' + escapeHtml(o.plan_name || o.plan_slug || '—') + '</td>' +
            '<td>' + seatBar(o.seats_used, o.seat_limit) + '</td>' +
            '<td>' + statusBadge(o.status) + '</td>' +
            '<td>' + escapeHtml(o.contract_end ? fmtDate(o.contract_end) : 'Süresiz') + '</td>' +
            '<td>' + effBadge(o.is_effective) + '</td></tr>';
    }

    function renderOrgs(seq) {
        setTitle('Kurumlar');
        var f = state.filters.orgs;
        setView(
            '<section class="section">' +
            '<div class="toolbar">' +
            '<form class="filter-form" data-form="orgFilter" role="search" aria-label="Kurum arama ve filtreleme">' +
            '<div class="field"><label for="orgQ">Ara</label><input type="search" id="orgQ" name="q" value="' + escapeHtml(f.q) + '" maxlength="100" placeholder="Kurum adı veya alan adı" autocomplete="off"></div>' +
            '<div class="field"><label for="orgStatus">Durum</label><select id="orgStatus" name="status">' + selectOptions([['', 'Tümü']].concat(STATUS_OPTIONS), f.status) + '</select></div>' +
            '<button type="submit" class="btn btn-secondary"><i class="fas fa-filter" aria-hidden="true"></i> Filtrele</button>' +
            '</form>' +
            (can('orgs.write') ? '<button type="button" class="btn btn-primary" data-act="org-new"><i class="fas fa-plus" aria-hidden="true"></i> Yeni kurum</button>' : '') +
            '</div>' +
            '<div id="resultsArea" tabindex="-1" aria-live="polite"></div>' +
            '</section>'
        );
        return loadOrgResults();
    }

    function loadOrgResults() {
        return inResults(async function () {
            var f = state.filters.orgs;
            var d = await api('GET', API + '/organizations' + buildQuery({ q: f.q, status: f.status }));
            var rows = listOf(d, ['items', 'organizations']);
            return tableHtml('Kurum listesi', ['Kurum', 'Marka', 'Plan', 'Koltuk', 'Durum', 'Sözleşme bitişi', 'Geçerlilik'],
                rows.map(orgRowHtml).join('') || emptyRow(7, 'Kayıt bulunamadı.'));
        });
    }

    FORMS.orgFilter = function (form) {
        var f = state.filters.orgs;
        f.q = (form.querySelector('[name="q"]').value || '').trim();
        f.status = form.querySelector('[name="status"]').value;
        loadOrgResults();
    };

    function orgFieldDefs(org, isCreate) {
        var o = org || {};
        var brands = state.refs.brands || [];
        var plans = state.refs.plans || [];
        var defs = [
            { name: 'name', label: 'Kurum adı', type: 'text', required: true, maxlength: 200, wide: true, value: o.name || '' },
            { name: 'brand_id', label: 'Marka', type: 'select', required: true,
                options: [{ value: '', label: 'Marka seçin…' }].concat(brands.map(function (b) { return { value: String(b.id), label: b.name }; })),
                value: o.brand_id != null ? String(o.brand_id) : '' },
            { name: 'plan_slug', label: 'Plan', type: 'select', required: true,
                options: plans.map(function (p) { return { value: p.slug, label: p.name || p.slug }; }),
                value: o.plan_slug || (plans[0] ? plans[0].slug : '') },
            { name: 'seat_limit', label: 'Koltuk sayısı', type: 'number', required: true, min: 0, max: 100000,
                value: o.seat_limit != null ? o.seat_limit : (isCreate ? 5 : ''), help: 'Kurumun kullanabileceği en fazla kullanıcı sayısı.' },
            { name: 'status', label: 'Durum', type: 'select', options: pairOpts(STATUS_OPTIONS), value: o.status || 'active' },
            { name: 'billing_type', label: 'Ödeme türü', type: 'select', options: pairOpts(BILLING_OPTIONS), value: o.billing_type || 'contract' },
            { name: 'contract_start', label: 'Sözleşme başlangıcı', type: 'date', value: toDateInput(o.contract_start) },
            { name: 'contract_end', label: 'Sözleşme bitişi', type: 'date', value: toDateInput(o.contract_end), help: 'Boş bırakılırsa süresiz. Bu tarih dahil geçerlidir.' },
            { name: 'contract_ref', label: 'Sözleşme / referans no', type: 'text', maxlength: 100, value: o.contract_ref || '' },
            { name: 'contact_name', label: 'Yetkili kişi', type: 'text', maxlength: 200, value: o.contact_name || '' },
            { name: 'contact_email', label: 'Yetkili e-posta', type: 'email', maxlength: 254, value: o.contact_email || '' },
            { name: 'auto_join', label: 'Alan adı eşleşen e-postalar davet kodsuz katılabilsin', type: 'checkbox', wide: true,
                value: o.auto_join != null ? !!o.auto_join : true }
        ];
        if (isCreate) {
            defs.push({ name: 'domains', label: 'Kurum alan adları', type: 'text', wide: true, maxlength: 600,
                placeholder: 'deere.com, johndeere.com', help: 'Virgülle ayırın. Genel e-posta sağlayıcıları (gmail.com vb.) kabul edilmez.' });
        }
        defs.push({ name: 'notes', label: 'Notlar', type: 'textarea', maxlength: 2000, wide: true, value: o.notes || '' });
        return defs;
    }

    function orgPayload(v, isCreate) {
        var p = {
            name: v.name,
            brand_id: Number(v.brand_id),
            plan_slug: v.plan_slug,
            seat_limit: Number(v.seat_limit),
            status: v.status,
            billing_type: v.billing_type,
            auto_join: !!v.auto_join,
            contract_start: v.contract_start || null,
            contract_end: v.contract_end || null,
            contract_ref: v.contract_ref || null,
            contact_name: v.contact_name || null,
            contact_email: v.contact_email || null,
            notes: v.notes || null
        };
        if (isCreate) {
            p.domains = String(v.domains || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
        }
        return p;
    }

    ACTIONS['org-new'] = async function () {
        await Promise.all([ensureRef('brands'), ensureRef('plans')]);
        var defs = orgFieldDefs(null, true);
        var created = null;
        var ok = await openFormDialog({
            title: 'Yeni kurum',
            intro: 'Kurumsal sözleşmeli müşteri oluşturur. Koltuk sayısı, plan ve sözleşme tarihleri buradan belirlenir.',
            fields: defs,
            submitLabel: 'Kurumu oluştur',
            onSubmit: async function (vals) {
                created = await api('POST', API + '/organizations', orgPayload(vals, true));
                return true;
            }
        });
        if (!ok) return;
        toast('ok', 'Kurum oluşturuldu.');
        var id = created && (created.id || (created.organization && created.organization.id));
        if (id) location.hash = '#/orgs/' + id;
        else route();
    };

    /* ---------- Kurum detayı ---------- */

    async function renderOrgDetail(seq, id) {
        if (!/^\d+$/.test(id || '')) throw new Error('Geçersiz kurum kimliği.');
        setTitle('Kurum');
        setView(loadingHtml());
        await Promise.all([ensureRef('brands'), ensureRef('plans'), ensureRef('features')]);
        var org = await api('GET', API + '/organizations/' + id);
        if (seq !== state.seq) return;
        state.org = org || {};
        state.orgId = id;
        renderOrgPage();
    }

    function renderOrgPage() {
        var org = state.org;
        if (!org) return;
        setTitle(org.name || 'Kurum');
        var tabs = '<div class="tabs" role="tablist" aria-label="Kurum bölümleri">' + TAB_DEFS.map(function (t) {
            var sel = state.orgTab === t.key;
            return '<button type="button" role="tab" class="tab" id="tab-' + t.key + '" aria-selected="' + sel + '" aria-controls="orgPanel" tabindex="' + (sel ? '0' : '-1') + '" data-act="org-tab" data-tab="' + t.key + '">' + escapeHtml(t.label) + '</button>';
        }).join('') + '</div>';
        var panel = '<div class="tab-panel" id="orgPanel" role="tabpanel" aria-labelledby="tab-' + state.orgTab + '">' + orgTabHtml(state.orgTab, org) + '</div>';

        setView(
            '<p class="back-link"><a href="#/orgs"><i class="fas fa-arrow-left" aria-hidden="true"></i> Kurumlar</a></p>' +
            '<section class="card org-summary"><h2 class="sr-only">Kurum özeti</h2>' +
            '<div class="org-summary-top">' + statusBadge(org.status) + ' ' + effBadge(org.is_effective) + '</div>' +
            '<dl class="facts">' +
            fact('Marka', escapeHtml(org.brand_name || '—')) +
            fact('Plan', escapeHtml(org.plan_name || org.plan_slug || '—')) +
            fact('Koltuk', seatBar(org.seats_used, org.seat_limit)) +
            fact('Sözleşme', contractHtml(org)) +
            fact('Ödeme türü', escapeHtml(BILLING_LABELS[org.billing_type] || '—')) +
            '</dl></section>' +
            tabs + panel
        );
    }

    function orgTabHtml(tab, org) {
        if (tab === 'members') return orgMembersHtml(org);
        if (tab === 'domains') return orgDomainsHtml(org);
        if (tab === 'features') return orgFeaturesHtml(org);
        return orgGeneralHtml(org);
    }

    function orgGeneralHtml(org) {
        if (!can('orgs.write')) {
            return '<section class="section"><h2>Bilgiler ve sözleşme</h2><dl class="facts">' +
                fact('Kurum adı', escapeHtml(org.name || '—')) +
                fact('Marka', escapeHtml(org.brand_name || '—')) +
                fact('İletişim', escapeHtml([org.contact_name, org.contact_email].filter(Boolean).join(' · ') || '—')) +
                fact('Sözleşme referansı', escapeHtml(org.contract_ref || '—')) +
                fact('Notlar', escapeHtml(org.notes || '—')) +
                '</dl></section>';
        }
        var btns = '';
        if (org.status !== 'active') btns += '<button type="button" class="btn btn-secondary" data-act="org-status" data-status="active"><i class="fas fa-circle-check" aria-hidden="true"></i> Aktifleştir</button>';
        if (org.status !== 'suspended') btns += '<button type="button" class="btn btn-danger" data-act="org-status" data-status="suspended"><i class="fas fa-ban" aria-hidden="true"></i> Askıya al</button>';
        var defs = orgFieldDefs(org, false);
        return '<section class="section"><h2>Durum</h2>' +
            '<div class="status-actions">' + btns + '</div>' +
            '<p class="field-help">Askıya alınan kurumun üyeleri erişimini kaybeder. Sözleşme bitiş tarihi geçtiğinde erişim otomatik kapanır.</p></section>' +
            '<section class="section"><h2>Bilgiler ve sözleşme</h2>' +
            '<form data-form="orgEdit" class="form-grid" novalidate>' + fieldsHtml(defs, 'oe') +
            '<div class="form-actions"><button type="submit" class="btn btn-primary">Değişiklikleri kaydet</button></div></form></section>';
    }

    ACTIONS['org-status'] = async function (btn) {
        var st = btn.getAttribute('data-status');
        if (st === 'suspended') {
            var go = await confirmDialog('Kurumu askıya al', 'Askıya alınan kurumun üyeleri erişimini kaybeder. Devam edilsin mi?', 'Askıya al', true);
            if (!go) return;
        }
        var vals = defaultsOf(orgFieldDefs(state.org, false));
        vals.status = st;
        if (await action(function () { return api('PUT', API + '/organizations/' + state.orgId, orgPayload(vals, false)); },
            st === 'active' ? 'Kurum aktifleştirildi.' : 'Kurum askıya alındı.')) route();
    };

    FORMS.orgEdit = async function (form) {
        var defs = orgFieldDefs(state.org, false);
        var vals = readForm(form, defs);
        var msg = validateValues(defs, vals);
        if (msg) return toast('err', msg);
        if (await action(function () { return api('PUT', API + '/organizations/' + state.orgId, orgPayload(vals, false)); }, 'Kurum bilgileri kaydedildi.')) route();
    };

    ACTIONS['org-tab'] = function (btn) {
        state.orgTab = btn.getAttribute('data-tab');
        renderOrgPage();
        var t = document.getElementById('tab-' + state.orgTab);
        if (t) t.focus();
    };

    /* Üyeler */

    function orgMembersHtml(org) {
        var canW = can('members.write');
        var members = arr(org.members);
        var invs = arr(org.invitations);
        var h = '';
        if (canW) {
            h += '<section class="section"><h2>Üye ekle</h2>' +
                '<form data-form="orgMemberAdd" class="inline-form" novalidate>' +
                '<div class="field"><label for="memberEmail">E-posta</label><input type="email" id="memberEmail" name="email" required maxlength="254" autocomplete="off" placeholder="ad@sirket.com"></div>' +
                '<div class="field"><label for="memberRole">Kurum rolü</label><select id="memberRole" name="member_role">' + selectOptions(MEMBER_ROLE_OPTIONS, 'member') + '</select></div>' +
                '<button type="submit" class="btn btn-primary">Üye ekle</button></form>' +
                '<p class="field-help">Kullanıcı kayıtlıysa doğrudan kuruma eklenir; değilse bu e-posta için kurum daveti oluşturulur.</p>' +
                '<button type="button" class="btn btn-secondary" data-act="org-link-domain"><i class="fas fa-link" aria-hidden="true"></i> Alan adındaki mevcut kullanıcıları bağla</button>' +
                '</section>';
        }
        var rows = members.map(function (m) {
            var roleCell = canW
                ? '<select data-change="orgMemberRole" data-id="' + escapeHtml(m.id) + '" data-prev="' + escapeHtml(m.member_role) + '" aria-label="Kurum rolü: ' + escapeHtml(m.email) + '">' + selectOptions(MEMBER_ROLE_OPTIONS, m.member_role) + '</select>'
                : escapeHtml(MEMBER_ROLE_OPTIONS.filter(function (o) { return o[0] === m.member_role; }).map(function (o) { return o[1]; })[0] || m.member_role);
            var removeBtn = canW ? '<button type="button" class="btn btn-danger btn-sm" data-act="org-member-remove" data-id="' + escapeHtml(m.id) + '" aria-label="Çıkar: ' + escapeHtml(m.email) + '"><i class="fas fa-user-minus" aria-hidden="true"></i> Çıkar</button>' : '';
            return '<tr><th scope="row">' + escapeHtml(m.email) + '</th>' +
                '<td>' + escapeHtml(m.full_name || '—') + '</td>' +
                '<td>' + roleCell + '</td>' +
                '<td>' + (m.email_verified ? badge('ok', 'Doğrulandı') : badge('warn', 'Doğrulanmadı')) + '</td>' +
                '<td>' + escapeHtml(fmtDateTime(m.last_login)) + '</td>' +
                '<td>' + escapeHtml(JOINED_LABELS[m.joined_via] || m.joined_via || '—') + '</td>' +
                '<td>' + removeBtn + '</td></tr>';
        }).join('');
        h += '<section class="section"><h2>Üyeler (' + fmtNum(members.length) + ')</h2>' +
            tableHtml('Kurum üyeleri', ['E-posta', 'Ad soyad', 'Kurum rolü', 'Doğrulama', 'Son giriş', 'Kaynak', 'İşlem'], rows || emptyRow(7, 'Bu kurumda henüz üye yok.')) + '</section>';
        h += '<section class="section"><h2>Bekleyen davetler (' + fmtNum(invs.length) + ')</h2>' +
            tableHtml('Bekleyen davetler', ['E-posta', 'Kurum rolü', 'Davet tarihi', 'İşlem'],
                invs.map(function (i) {
                    var btn = canW ? '<button type="button" class="btn btn-secondary btn-sm" data-act="org-invite-revoke" data-id="' + escapeHtml(i.id) + '" aria-label="Daveti iptal et: ' + escapeHtml(i.email) + '">İptal et</button>' : '';
                    return '<tr><th scope="row">' + escapeHtml(i.email) + '</th><td>' + escapeHtml(MEMBER_ROLE_OPTIONS.filter(function (o) { return o[0] === i.member_role; }).map(function (o) { return o[1]; })[0] || i.member_role) +
                        '</td><td>' + escapeHtml(fmtDate(i.created_at)) + '</td><td>' + btn + '</td></tr>';
                }).join('') || emptyRow(4, 'Bekleyen davet yok.')) + '</section>';
        return h;
    }

    FORMS.orgMemberAdd = async function (form) {
        var email = (form.querySelector('[name="email"]').value || '').trim();
        var role = form.querySelector('[name="member_role"]').value;
        if (!email) return toast('err', 'E-posta adresi zorunludur.');
        var res = null;
        if (await action(async function () {
            res = await api('POST', API + '/organizations/' + state.orgId + '/members', { email: email, member_role: role });
        }, null)) {
            toast('ok', res && res.result === 'invited'
                ? 'Davet oluşturuldu. Kişi bu e-posta ile kayıt olduğunda kurumunuza katılacak.'
                : 'Kullanıcı kuruma eklendi.');
            route();
        }
    };

    CHANGES.orgMemberRole = async function (sel) {
        var id = sel.getAttribute('data-id');
        var prev = sel.getAttribute('data-prev');
        var ok = await action(function () {
            return api('PUT', API + '/organizations/' + state.orgId + '/members/' + id, { member_role: sel.value });
        }, 'Kurum rolü güncellendi.');
        if (ok) sel.setAttribute('data-prev', sel.value);
        else sel.value = prev;
    };

    ACTIONS['org-member-remove'] = async function (btn) {
        var id = btn.getAttribute('data-id');
        var m = findById(state.org && state.org.members, id);
        var go = await confirmDialog('Üyeyi kurumdan çıkar',
            (m ? m.email : 'Bu kullanıcı') + ' kurumdan çıkarılacak. Kullanıcı hesabı silinmez; koltuk boşalır. Devam edilsin mi?',
            'Çıkar', true);
        if (!go) return;
        if (await action(function () { return api('DELETE', API + '/organizations/' + state.orgId + '/members/' + id); }, 'Üye kurumdan çıkarıldı.')) route();
    };

    ACTIONS['org-invite-revoke'] = async function (btn) {
        var id = btn.getAttribute('data-id');
        if (await action(function () { return api('DELETE', API + '/organizations/' + state.orgId + '/invitations/' + id); }, 'Davet iptal edildi.')) route();
    };

    ACTIONS['org-link-domain'] = async function () {
        var res = null;
        var ok = await action(async function () {
            res = await api('POST', API + '/organizations/' + state.orgId + '/link-domain-users');
        }, null);
        if (!ok) return;
        var linked = Number(res && res.linked) || 0;
        var skipped = Number(res && res.skipped_no_seat) || 0;
        toast('ok', fmtNum(linked) + ' kullanıcı kuruma bağlandı' + (skipped ? '; koltuk yetersizliği nedeniyle ' + fmtNum(skipped) + ' kullanıcı bağlanamadı.' : '.'));
        route();
    };

    /* Alan adları */

    function orgDomainsHtml(org) {
        var canW = can('orgs.write');
        var doms = arr(org.domains).map(function (d) { return typeof d === 'string' ? { id: null, domain: d } : d; });
        var rows = doms.map(function (d) {
            var btn = canW && d.id != null
                ? '<button type="button" class="btn btn-danger btn-sm" data-act="org-domain-remove" data-id="' + escapeHtml(d.id) + '" aria-label="Kaldır: ' + escapeHtml(d.domain) + '"><i class="fas fa-trash-can" aria-hidden="true"></i> Kaldır</button>'
                : '';
            return '<tr><th scope="row">' + escapeHtml(d.domain) + '</th><td>' + btn + '</td></tr>';
        }).join('');
        var form = canW
            ? '<section class="section"><h2>Alan adı ekle</h2>' +
              '<form data-form="orgDomainAdd" class="inline-form" novalidate>' +
              '<div class="field"><label for="domainInput">Alan adı</label><input type="text" id="domainInput" name="domain" required maxlength="253" placeholder="ornek.com" autocomplete="off" aria-describedby="domainHelp"></div>' +
              '<button type="submit" class="btn btn-primary">Alan adı ekle</button></form>' +
              '<p class="field-help" id="domainHelp">Yalnızca kurumsal alan adları. Genel e-posta sağlayıcıları (gmail.com, outlook.com vb.) kabul edilmez. Bir alan adı yalnızca bir kuruma bağlanabilir.</p></section>'
            : '';
        return form + '<section class="section"><h2>Alan adları (' + fmtNum(doms.length) + ')</h2>' +
            tableHtml('Kurum alan adları', ['Alan adı', 'İşlem'], rows || emptyRow(2, 'Alan adı tanımlı değil.')) + '</section>';
    }

    FORMS.orgDomainAdd = async function (form) {
        var domain = (form.querySelector('[name="domain"]').value || '').trim();
        if (!domain) return toast('err', 'Alan adı girin.');
        if (await action(function () { return api('POST', API + '/organizations/' + state.orgId + '/domains', { domain: domain }); }, 'Alan adı eklendi.')) route();
    };

    ACTIONS['org-domain-remove'] = async function (btn) {
        var id = btn.getAttribute('data-id');
        var go = await confirmDialog('Alan adını kaldır', 'Bu alan adı kuruma artık bağlı olmayacak. Devam edilsin mi?', 'Kaldır', true);
        if (!go) return;
        if (await action(function () { return api('DELETE', API + '/organizations/' + state.orgId + '/domains/' + id); }, 'Alan adı kaldırıldı.')) route();
    };

    /* Özellik ve limitler */

    function orgFeaturesHtml(org) {
        var canW = can('orgs.write');
        var plan = planBySlug(org.plan_slug);
        var planKeys = planFeatureKeys(plan);
        var ov = org.feature_overrides || {};
        var add = arr(ov.add);
        var rem = arr(ov.remove);
        var flags = arr(state.refs.features);
        var effKeys = arr(org.effective_features).map(function (k) { return typeof k === 'string' ? k : k.key; });
        var effNames = flags.filter(function (f) { return effKeys.indexOf(f.key) !== -1; }).map(function (f) { return f.name || f.key; });

        var featRows = flags.map(function (f) {
            var base = planKeys.indexOf(f.key) !== -1;
            var checked = base ? rem.indexOf(f.key) === -1 : add.indexOf(f.key) !== -1;
            var note = base
                ? (rem.indexOf(f.key) !== -1 ? 'Plan kapsamında, kurum için kapatıldı' : 'Plan kapsamında')
                : (add.indexOf(f.key) !== -1 ? 'Kuruma özel eklendi' : 'Plan kapsamında değil');
            var globalOff = f.is_enabled === false ? ' <span class="badge badge-warn">Genel olarak kapalı</span>' : '';
            return '<label class="check-item check-feature" for="feat_' + escapeHtml(f.key) + '">' +
                '<input type="checkbox" id="feat_' + escapeHtml(f.key) + '" name="feat" value="' + escapeHtml(f.key) + '"' + (checked ? ' checked' : '') + (canW ? '' : ' disabled') + '> ' +
                '<span class="feat-name">' + escapeHtml(f.name || f.key) + '</span> ' +
                '<span class="note">' + escapeHtml(note) + '</span>' + globalOff + '</label>';
        }).join('');

        var limitOv = org.limit_overrides || {};
        var planLimits = (plan && plan.plan_limits) || {};
        var effLimits = org.effective_limits || {};
        var limitSummary = limitKeys().map(function (k) {
            return fact(LIMIT_LABELS[k] || k, escapeHtml(limitValueLabel(effLimits[k] != null ? effLimits[k] : planLimits[k])));
        }).join('');
        var limitFields = limitKeys().map(function (k) {
            var ov2 = limitOv[k];
            var pv = planLimits[k];
            var ph = 'Plan: ' + limitValueLabel(pv == null ? 0 : pv);
            var hid = 'lim_' + escapeHtml(k) + '_h';
            return '<div class="field"><label for="lim_' + escapeHtml(k) + '">' + escapeHtml(LIMIT_LABELS[k] || k) + '</label>' +
                '<input type="number" inputmode="numeric" step="1" min="-1" id="lim_' + escapeHtml(k) + '" name="lim_' + escapeHtml(k) + '" value="' + (ov2 != null ? escapeHtml(ov2) : '') + '" placeholder="' + escapeHtml(ph) + '"' +
                (canW ? '' : ' disabled') + ' aria-describedby="' + hid + '">' +
                '<p class="field-help" id="' + hid + '">' + (ov2 != null ? 'Kuruma özel değer.' : 'Boş: plan varsayılanı kullanılır.') + ' -1 sınırsız demektir.</p></div>';
        }).join('');

        var form = canW
            ? '<form data-form="orgFeatures" novalidate>' +
              '<fieldset class="fieldset"><legend>Özellikler</legend><p class="field-help">İşaretli özellikler kurumda açıktır. Plan dışı özellikleri ekleyebilir, plan özelliklerini kapatabilirsiniz.</p>' +
              '<div class="check-grid">' + featRows + '</div></fieldset>' +
              '<fieldset class="fieldset"><legend>Limitler</legend><div class="form-grid">' + limitFields + '</div></fieldset>' +
              '<div class="form-actions"><button type="submit" class="btn btn-primary">Özellik ve limitleri kaydet</button></div></form>'
            : '<section class="section"><h2>Özellikler</h2><div class="check-grid">' + featRows + '</div></section>' +
              '<section class="section"><h2>Limitler</h2><div class="form-grid">' + limitFields + '</div></section>';

        return '<section class="section"><h2>Etkin durum</h2>' +
            '<p class="field-help">Kurumda şu an etkin olan özellikler:</p>' +
            '<p>' + (effNames.length ? effNames.map(function (n) { return '<span class="chip">' + escapeHtml(n) + '</span>'; }).join(' ') : '<span class="field-help">Etkin özellik yok.</span>') + '</p>' +
            '<dl class="facts">' + limitSummary + '</dl></section>' +
            '<section class="section"><h2>Özellik ve limit istisnaları</h2>' + form + '</section>';
    }

    FORMS.orgFeatures = async function (form) {
        var org = state.org;
        var flags = arr(state.refs.features);
        if (!flags.length) return toast('err', 'Özellik listesi yüklenemedi. Kaydetmek için sayfayı yenileyin.');
        var planKeys = planFeatureKeys(planBySlug(org.plan_slug));
        var ov = org.feature_overrides || {};
        var prevAdd = arr(ov.add);
        var prevRem = arr(ov.remove);
        var flagKeys = flags.map(function (f) { return f.key; });
        var checked = Array.prototype.map.call(form.querySelectorAll('input[name="feat"]:checked'), function (i) { return i.value; });
        var add = prevAdd.filter(function (k) { return flagKeys.indexOf(k) === -1; });
        var remove = prevRem.filter(function (k) { return flagKeys.indexOf(k) === -1; });
        flagKeys.forEach(function (k) {
            var base = planKeys.indexOf(k) !== -1;
            var on = checked.indexOf(k) !== -1;
            if (base && !on) remove.push(k);
            if (!base && on) add.push(k);
        });

        var limit = {};
        var err = null;
        limitKeys().forEach(function (k) {
            var el = form.querySelector('[name="lim_' + k + '"]');
            if (!el) return;
            var raw = String(el.value || '').trim();
            if (raw === '') return;
            var n = Number(raw);
            if (!Number.isInteger(n) || n < -1) {
                err = (LIMIT_LABELS[k] || k) + ' için -1 veya 0 ya da daha büyük bir tam sayı girin.';
                return;
            }
            limit[k] = n;
        });
        if (err) return toast('err', err);

        if (await action(function () {
            return api('PUT', API + '/organizations/' + state.orgId, {
                feature_overrides: { add: uniq(add), remove: uniq(remove) },
                limit_overrides: limit
            });
        }, 'Özellik ve limitler kaydedildi.')) route();
    };

    /* ---------- Kullanıcılar ---------- */

    var USER_STATUS_OPTIONS = [['', 'Tümü'], ['active', 'Aktif'], ['inactive', 'Pasif']];
    var USER_KIND_OPTIONS = [['', 'Tümü'], ['customer', 'Müşteri'], ['staff', 'Ekip']];

    function renderUsers(seq) {
        setTitle('Kullanıcılar');
        var f = state.filters.users;
        setView(
            '<section class="section">' +
            '<div class="toolbar"><form class="filter-form" data-form="usersFilter" role="search" aria-label="Kullanıcı arama ve filtreleme">' +
            '<div class="field"><label for="usrQ">Ara</label><input type="search" id="usrQ" name="q" value="' + escapeHtml(f.q) + '" maxlength="100" placeholder="E-posta veya ad" autocomplete="off"></div>' +
            '<div class="field"><label for="usrStatus">Hesap durumu</label><select id="usrStatus" name="status">' + selectOptions(USER_STATUS_OPTIONS, f.status) + '</select></div>' +
            '<div class="field"><label for="usrKind">Hesap türü</label><select id="usrKind" name="kind">' + selectOptions(USER_KIND_OPTIONS, f.kind) + '</select></div>' +
            '<button type="submit" class="btn btn-secondary"><i class="fas fa-filter" aria-hidden="true"></i> Filtrele</button>' +
            '</form></div>' +
            '<div id="resultsArea" tabindex="-1" aria-live="polite"></div>' +
            '</section>'
        );
        return loadUsers();
    }

    function loadUsers() {
        return inResults(async function () {
            var f = state.filters.users;
            var d = await api('GET', API + '/users' + buildQuery({ q: f.q, status: f.status, kind: f.kind, page: f.page }));
            var items = listOf(d, ['items', 'users']);
            var total = Number(d && d.total) || 0;
            var rows = items.map(function (u) {
                var tur = u.role === 'admin' ? 'Ekip: ' + roleName(u.staff_role) : 'Müşteri';
                return '<tr><th scope="row"><a href="#/users/' + escapeHtml(u.id) + '">' + escapeHtml(u.email) + '</a></th>' +
                    '<td>' + escapeHtml(u.full_name || '—') + '</td>' +
                    '<td>' + escapeHtml(tur) + '</td>' +
                    '<td>' + escapeHtml(u.organization_name || '—') + '</td>' +
                    '<td>' + escapeHtml(u.plan_slug || '—') + '</td>' +
                    '<td>' + (u.is_active ? badge('ok', 'Aktif') : badge('muted', 'Pasif')) + '</td>' +
                    '<td>' + (u.email_verified ? badge('ok', 'Doğrulandı') : badge('warn', 'Doğrulanmadı')) + '</td>' +
                    '<td>' + escapeHtml(fmtDateTime(u.last_login)) + '</td></tr>';
            }).join('');
            return tableHtml('Kullanıcı listesi', ['E-posta', 'Ad soyad', 'Tür', 'Kurum', 'Plan', 'Durum', 'E-posta doğrulama', 'Son giriş'],
                rows || emptyRow(8, 'Kayıt bulunamadı.')) + pagerHtml('users', f.page, total);
        });
    }

    FORMS.usersFilter = function (form) {
        var f = state.filters.users;
        f.q = (form.querySelector('[name="q"]').value || '').trim();
        f.status = form.querySelector('[name="status"]').value;
        f.kind = form.querySelector('[name="kind"]').value;
        f.page = 1;
        loadUsers();
    };

    async function renderUserDetail(seq, id) {
        if (!/^\d+$/.test(id || '')) throw new Error('Geçersiz kullanıcı kimliği.');
        setView(loadingHtml());
        var d = await api('GET', API + '/users/' + id);
        if (seq !== state.seq) return;
        var u = (d && d.user) || d || {};
        var org = d && d.organization;
        var subs = listOf(d, ['subscriptions']);
        var events = listOf(d, ['auth_events', 'auth_audit', 'events']);
        state.userDetail = u;
        setTitle(u.full_name || u.email || 'Kullanıcı');

        var isSelf = myId() != null && Number(u.id) === myId();
        var locked = !!u.is_superuser || isSelf;
        var canW = can('users.write');
        var kind = u.role === 'admin' ? 'Ekip: ' + roleName(u.staff_role) : 'Müşteri';

        var actions = '';
        if (canW) {
            actions += u.is_active
                ? '<button type="button" class="btn btn-danger" data-act="user-status" data-next="0"' + (locked ? ' disabled' : '') + '><i class="fas fa-user-lock" aria-hidden="true"></i> Pasifleştir</button>'
                : '<button type="button" class="btn btn-secondary" data-act="user-status" data-next="1"' + (locked ? ' disabled' : '') + '><i class="fas fa-user-check" aria-hidden="true"></i> Aktifleştir</button>';
            actions += ' <button type="button" class="btn btn-primary" data-act="user-sub"><i class="fas fa-id-card" aria-hidden="true"></i> Elle abonelik tanımla</button>';
        }

        var subRows = subs.map(function (s) {
            return '<tr><td>' + escapeHtml(s.plan_name || s.plan_slug || '—') + '</td>' +
                '<td>' + escapeHtml(s.status || '—') + '</td>' +
                '<td>' + escapeHtml(fmtDate(s.current_period_start)) + '</td>' +
                '<td>' + escapeHtml(fmtDate(s.current_period_end)) + '</td>' +
                '<td>' + escapeHtml(s.provider === 'manual' ? 'Elle tanımlandı' : (s.provider || '—')) + '</td></tr>';
        }).join('');

        var evRows = events.map(function (e) {
            var outcome = e.success === true ? badge('ok', 'Başarılı') : (e.success === false ? badge('danger', 'Başarısız') : '—');
            return '<tr><td>' + escapeHtml(fmtDateTime(e.created_at)) + '</td>' +
                '<td>' + escapeHtml(e.event_type || e.event || e.action || '—') + '</td>' +
                '<td>' + outcome + '</td>' +
                '<td>' + escapeHtml(e.ip_address || e.ip || '—') + '</td></tr>';
        }).join('');

        setView(
            '<p class="back-link"><a href="#/users"><i class="fas fa-arrow-left" aria-hidden="true"></i> Kullanıcılar</a></p>' +
            '<section class="card"><div class="org-summary-top">' + (u.is_active ? badge('ok', 'Aktif') : badge('muted', 'Pasif')) + '</div>' +
            '<dl class="facts">' +
            fact('E-posta', escapeHtml(u.email || '—')) +
            fact('Ad soyad', escapeHtml(u.full_name || '—')) +
            fact('Tür', escapeHtml(kind)) +
            fact('Marka', escapeHtml(u.brand_name || '—')) +
            fact('E-posta doğrulama', u.email_verified ? badge('ok', 'Doğrulandı') : badge('warn', 'Doğrulanmadı')) +
            fact('Kayıt tarihi', escapeHtml(fmtDateTime(u.created_at))) +
            fact('Son giriş', escapeHtml(fmtDateTime(u.last_login))) +
            '</dl>' +
            (locked ? '<p class="field-help">Süper yönetici ve kendi hesabınız pasifleştirilemez.</p>' : '') +
            (actions ? '<div class="status-actions">' + actions + '</div>' : '') +
            '</section>' +
            '<section class="section"><h2>Kurum</h2>' +
            (org
                ? '<dl class="facts">' + fact('Kurum', '<a href="#/orgs/' + escapeHtml(org.id) + '">' + escapeHtml(org.name) + '</a>') +
                  fact('Kurum rolü', escapeHtml(MEMBER_ROLE_OPTIONS.filter(function (o) { return o[0] === org.member_role; }).map(function (o) { return o[1]; })[0] || org.member_role || '—')) + '</dl>'
                : '<p class="field-help">Bir kuruma bağlı değil.</p>') + '</section>' +
            '<section class="section"><h2>Abonelikler (son 10)</h2>' +
            tableHtml('Abonelikler', ['Plan', 'Durum', 'Dönem başlangıcı', 'Dönem bitişi', 'Kaynak'], subRows || emptyRow(5, 'Abonelik kaydı yok.')) + '</section>' +
            '<section class="section"><h2>Son oturum olayları (son 20)</h2>' +
            tableHtml('Oturum olayları', ['Zaman', 'Olay', 'Sonuç', 'IP'], evRows || emptyRow(4, 'Olay kaydı yok.')) + '</section>'
        );
    }

    ACTIONS['user-status'] = async function (btn) {
        var u = state.userDetail;
        if (!u) return;
        var next = btn.getAttribute('data-next') === '1';
        var go = await confirmDialog(
            next ? 'Kullanıcıyı aktifleştir' : 'Kullanıcıyı pasifleştir',
            next ? 'Kullanıcı yeniden giriş yapabilecek.' : 'Kullanıcı pasifleştirilir ve giriş yapamaz hale gelir. Devam edilsin mi?',
            next ? 'Aktifleştir' : 'Pasifleştir', !next);
        if (!go) return;
        if (await action(function () { return api('POST', API + '/users/' + u.id + '/status', { is_active: next }); },
            next ? 'Kullanıcı aktifleştirildi.' : 'Kullanıcı pasifleştirildi.')) route();
    };

    ACTIONS['user-sub'] = async function () {
        var u = state.userDetail;
        if (!u) return;
        var plans = await ensureRef('plans');
        var planField = plans.length
            ? { name: 'plan_slug', label: 'Plan', type: 'select', required: true, options: plans.map(function (p) { return { value: p.slug, label: p.name || p.slug }; }), value: plans[0].slug }
            : { name: 'plan_slug', label: 'Plan anahtarı (slug)', type: 'text', required: true, maxlength: 50, help: 'Plan listesi okunamadı; plan anahtarını elle girin.' };
        var defs = [planField,
            { name: 'period_end', label: 'Dönem bitişi', type: 'date', required: true, help: 'Bu tarih dahil geçerlidir.' }];
        var ok = await openFormDialog({
            title: 'Elle abonelik tanımla',
            intro: 'Kartsız abonelik yöneticiler tarafından tanımlanır. Kullanıcının mevcut aktif abonelikleri iptal edilir.',
            fields: defs,
            submitLabel: 'Aboneliği tanımla',
            onSubmit: async function (v) {
                await api('POST', API + '/users/' + u.id + '/subscription', { plan_slug: v.plan_slug, period_end: v.period_end });
                toast('ok', 'Abonelik tanımlandı.');
                return true;
            }
        });
        if (ok) route();
    };

    /* ---------- Denetim kaydı ---------- */

    function renderAudit(seq) {
        setTitle('Denetim Kaydı');
        var f = state.filters.audit;
        setView(
            '<section class="section">' +
            '<div class="toolbar"><form class="filter-form" data-form="auditFilter" role="search" aria-label="Denetim kaydı filtreleme">' +
            '<div class="field"><label for="auditAction">İşlem</label><input type="text" id="auditAction" name="action" value="' + escapeHtml(f.action) + '" maxlength="80" placeholder="ör. org.create" autocomplete="off"></div>' +
            '<div class="field"><label for="auditActor">Kişi</label><input type="text" id="auditActor" name="actor" value="' + escapeHtml(f.actor) + '" maxlength="100" placeholder="E-posta veya kullanıcı no" autocomplete="off"></div>' +
            '<button type="submit" class="btn btn-secondary"><i class="fas fa-filter" aria-hidden="true"></i> Filtrele</button>' +
            '</form></div>' +
            '<div id="resultsArea" tabindex="-1" aria-live="polite"></div>' +
            '</section>'
        );
        return loadAudit();
    }

    function loadAudit() {
        return inResults(async function () {
            var f = state.filters.audit;
            var d = await api('GET', API + '/audit' + buildQuery({ action: f.action, actor: f.actor, page: f.page }));
            var items = listOf(d, ['items', 'rows']);
            var total = Number(d && d.total) || items.length;
            var rows = items.map(function (r) {
                var who = r.actor_email || (r.actor_user_id ? 'Kullanıcı #' + r.actor_user_id : 'Sistem');
                var target = [r.target_type, r.target_id != null ? '#' + r.target_id : ''].filter(Boolean).join(' ');
                var json = JSON.stringify(r.details == null ? {} : r.details, null, 2);
                return '<tr><td>' + escapeHtml(fmtDateTime(r.created_at)) + '</td>' +
                    '<td>' + escapeHtml(who) + '</td>' +
                    '<td><code>' + escapeHtml(r.action) + '</code></td>' +
                    '<td>' + escapeHtml(target || '—') + '</td>' +
                    '<td><details class="json-details"><summary>Ayrıntıyı göster</summary><pre>' + escapeHtml(json) + '</pre></details></td></tr>';
            }).join('');
            return tableHtml('Denetim kayıtları', ['Zaman', 'Kişi', 'İşlem', 'Hedef', 'Ayrıntı'], rows || emptyRow(5, 'Kayıt bulunamadı.')) +
                pagerHtml('audit', f.page, total);
        });
    }

    FORMS.auditFilter = function (form) {
        var f = state.filters.audit;
        f.action = (form.querySelector('[name="action"]').value || '').trim();
        f.actor = (form.querySelector('[name="actor"]').value || '').trim();
        f.page = 1;
        loadAudit();
    };

    /* ---------- Ekip & Roller ---------- */

    function roleOptionsHtml(roles, selected) {
        return roles.filter(function (r) {
            return isSuper() || r.key !== 'super_admin' || r.key === selected;
        }).map(function (r) {
            return '<option value="' + escapeHtml(r.key) + '"' + (r.key === selected ? ' selected' : '') + '>' + escapeHtml(r.name || r.key) + '</option>';
        }).join('');
    }

    function renderStaffRow(s, roles) {
        var protectedRow = !!s.is_superuser || (myId() != null && Number(s.id) === myId());
        var effRole = s.effective_staff_role || s.staff_role || 'super_admin';
        var superTarget = effRole === 'super_admin';
        var editable = can('staff.manage') && !protectedRow && (isSuper() || !superTarget);
        var sel = '<select data-change="staffRole" data-id="' + escapeHtml(s.id) + '" data-prev="' + escapeHtml(s.staff_role || '') + '" aria-label="Rol: ' + escapeHtml(s.email) + '"' + (editable ? '' : ' disabled') + '>' +
            roleOptionsHtml(roles, effRole) + '</select>';
        var rem = editable
            ? '<button type="button" class="btn btn-danger btn-sm" data-act="staff-remove" data-id="' + escapeHtml(s.id) + '" aria-label="Kaldır: ' + escapeHtml(s.email) + '"><i class="fas fa-user-minus" aria-hidden="true"></i> Kaldır</button>'
            : '';
        return '<tr><th scope="row">' + escapeHtml(s.email) + '</th>' +
            '<td>' + escapeHtml(s.full_name || '—') + '</td>' +
            '<td>' + sel + '</td>' +
            '<td>' + (s.is_active ? badge('ok', 'Aktif') : badge('muted', 'Pasif')) + '</td>' +
            '<td>' + rem + '</td></tr>';
    }

    function matrixHtml(roles, catalog) {
        if (!roles.length || !catalog.length) return '<p class="field-help">Yetki kataloğu veya rol bulunamadı.</p>';
        var head = '<tr><th scope="col">Yetki</th>' + roles.map(function (r) {
            return '<th scope="col">' + escapeHtml(r.name || r.key) + '<br><code>' + escapeHtml(r.key) + '</code></th>';
        }).join('') + '</tr>';
        var body = catalog.map(function (p) {
            return '<tr><th scope="row">' + escapeHtml(p.name || p.key) + '<span class="feat-desc">' + escapeHtml(p.description || '') + '</span></th>' +
                roles.map(function (r) {
                    var has = rolePerms(r).indexOf(p.key) !== -1;
                    if (isSuper() && r.key !== 'super_admin') {
                        return '<td><input type="checkbox" data-change="rolePerm" data-role="' + escapeHtml(r.key) + '" value="' + escapeHtml(p.key) + '"' + (has ? ' checked' : '') +
                            ' aria-label="' + escapeHtml((r.name || r.key) + ': ' + (p.name || p.key)) + '"></td>';
                    }
                    return has
                        ? '<td><span class="yes"><i class="fas fa-check" aria-hidden="true"></i><span class="sr-only">Var</span></span></td>'
                        : '<td><span class="no" aria-hidden="true">—</span><span class="sr-only">Yok</span></td>';
                }).join('') + '</tr>';
        }).join('');
        return '<div class="table-wrap" tabindex="0"><table class="data-table matrix"><caption class="sr-only">Rol yetki matrisi</caption>' +
            '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
    }

    async function renderStaff(seq) {
        setTitle('Ekip & Roller');
        setView(loadingHtml('Ekip ve roller yükleniyor…'));
        state.refs.roles = null;
        var results = await Promise.all([api('GET', API + '/staff'), ensureRoles()]);
        if (seq !== state.seq) return;
        var staff = listOf(results[0], ['items', 'staff']);
        var roles = results[1];
        var catalog = arr(state.refs.catalog);

        var roleRows = roles.map(function (r) {
            var n = rolePerms(r).length;
            var del = isSuper() && !r.is_system
                ? '<button type="button" class="btn btn-danger btn-sm" data-act="role-delete" data-key="' + escapeHtml(r.key) + '" aria-label="Sil: ' + escapeHtml(r.name || r.key) + '"><i class="fas fa-trash-can" aria-hidden="true"></i> Sil</button>'
                : '';
            return '<tr><th scope="row">' + escapeHtml(r.name || r.key) + '</th><td><code>' + escapeHtml(r.key) + '</code></td>' +
                '<td>' + escapeHtml(r.description || '—') + '</td>' +
                '<td>' + (r.is_system ? badge('info', 'Sistem') : badge('muted', 'Özel')) + '</td>' +
                '<td>' + fmtNum(n) + '</td><td>' + del + '</td></tr>';
        }).join('');

        var staffRows = staff.map(function (s) { return renderStaffRow(s, roles); }).join('');

        setView(
            '<section class="section"><h2>Ekip üyeleri</h2>' +
            '<div class="toolbar"><p class="field-help">Ekip üyesi olarak eklenecek kişinin önce kayıt olup e-postasını doğrulamış olması gerekir.</p>' +
            (can('staff.manage') ? '<button type="button" class="btn btn-primary" data-act="staff-add"><i class="fas fa-user-plus" aria-hidden="true"></i> Ekip üyesi ekle</button>' : '') +
            '</div>' +
            tableHtml('Ekip üyeleri', ['E-posta', 'Ad soyad', 'Rol', 'Durum', 'İşlem'], staffRows || emptyRow(5, 'Ekip üyesi yok.')) + '</section>' +
            '<section class="section"><h2>Roller</h2>' +
            '<div class="toolbar"><p class="field-help">' + (isSuper()
                ? 'Yetki kutularını işaretleyerek rol yetkilerini değiştirebilirsiniz. Süper yönetici rolü değiştirilemez.'
                : 'Rol yetkilerini yalnızca süper yönetici değiştirebilir.') + '</p>' +
            (isSuper() ? '<button type="button" class="btn btn-primary" data-act="role-new"><i class="fas fa-plus" aria-hidden="true"></i> Yeni rol</button>' : '') +
            '</div>' +
            tableHtml('Roller', ['Ad', 'Anahtar', 'Açıklama', 'Tür', 'Yetki sayısı', 'İşlem'], roleRows || emptyRow(6, 'Rol yok.')) + '</section>' +
            '<section class="section"><h2>Yetki matrisi</h2>' + matrixHtml(roles, catalog) + '</section>'
        );
    }

    ACTIONS['staff-add'] = async function () {
        var roles = await ensureRoles();
        var defs = [
            { name: 'email', label: 'E-posta', type: 'email', required: true, maxlength: 254, help: 'Kişi önce kayıt olmalı ve e-postasını doğrulamış olmalıdır.' },
            { name: 'staff_role', label: 'Rol', type: 'select', required: true,
                options: roles.filter(function (r) { return isSuper() || r.key !== 'super_admin'; }).map(function (r) { return { value: r.key, label: r.name || r.key }; }),
                value: 'viewer' }
        ];
        var ok = await openFormDialog({
            title: 'Ekip üyesi ekle',
            intro: 'Kayıtlı ve e-postası doğrulanmış bir kullanıcıya ekip rolü verilir.',
            fields: defs,
            submitLabel: 'Ekip üyesi ekle',
            onSubmit: async function (v) {
                await api('POST', API + '/staff', { email: v.email.toLowerCase(), staff_role: v.staff_role });
                toast('ok', 'Ekip üyesi eklendi.');
                return true;
            }
        });
        if (ok) route();
    };

    CHANGES.staffRole = async function (sel) {
        var id = sel.getAttribute('data-id');
        var prev = sel.getAttribute('data-prev');
        var ok = await action(function () {
            return api('PUT', API + '/staff/' + id, { staff_role: sel.value });
        }, 'Rol güncellendi.');
        if (ok) sel.setAttribute('data-prev', sel.value);
        else sel.value = prev;
    };

    ACTIONS['staff-remove'] = async function (btn) {
        var id = btn.getAttribute('data-id');
        var go = await confirmDialog('Ekip üyesini kaldır', 'Bu kişinin ekip yetkisi kaldırılır. Müşteri hesabı silinmez. Devam edilsin mi?', 'Kaldır', true);
        if (!go) return;
        if (await action(function () { return api('DELETE', API + '/staff/' + id); }, 'Ekip üyesi kaldırıldı.')) route();
    };

    CHANGES.rolePerm = async function (cb) {
        var key = cb.getAttribute('data-role');
        var perms = Array.prototype.map.call(document.querySelectorAll('input[data-role="' + key + '"]:checked'), function (i) { return i.value; });
        var ok = await action(function () {
            return api('PUT', API + '/roles/' + encodeURIComponent(key), { permissions: perms });
        }, 'Rol yetkileri güncellendi.');
        if (ok) {
            var role = arr(state.refs.roles).filter(function (r) { return r.key === key; })[0];
            if (role) role.permissions = perms;
        } else {
            cb.checked = !cb.checked;
        }
    };

    ACTIONS['role-new'] = async function () {
        var catalog = arr(state.refs.catalog);
        var defs = [
            { name: 'key', label: 'Anahtar', type: 'text', required: true, maxlength: 50, placeholder: 'ornek_rol',
                help: 'Küçük harfle başlamalı; yalnızca küçük harf, rakam ve alt çizgi içermeli (2-50 karakter).' },
            { name: 'name', label: 'Ad', type: 'text', required: true, maxlength: 100, placeholder: 'Örnek Rol' },
            { name: 'description', label: 'Açıklama', type: 'textarea', maxlength: 500, wide: true },
            { name: 'permissions', label: 'Yetkiler', type: 'checks', wide: true, value: [],
                options: catalog.map(function (p) { return { value: p.key, label: p.name || p.key }; }) }
        ];
        var ok = await openFormDialog({
            title: 'Yeni rol',
            intro: 'Özel rol yalnızca süper yönetici tarafından oluşturulabilir.',
            fields: defs,
            submitLabel: 'Rolü oluştur',
            onSubmit: async function (v) {
                if (!ROLE_KEY_RE.test(v.key)) throw new Error('Anahtar küçük harfle başlamalı; yalnızca küçük harf, rakam ve alt çizgi içermeli.');
                await api('POST', API + '/roles', { key: v.key, name: v.name, description: v.description || null, permissions: v.permissions });
                toast('ok', 'Rol oluşturuldu.');
                return true;
            }
        });
        if (ok) {
            state.refs.roles = null;
            route();
        }
    };

    ACTIONS['role-delete'] = async function (btn) {
        var key = btn.getAttribute('data-key');
        var go = await confirmDialog('Rolü sil', '"' + key + '" rolü silinecek. Bu rolü kullanan ekip üyesi varsa işlem reddedilir.', 'Sil', true);
        if (!go) return;
        if (await action(function () { return api('DELETE', API + '/roles/' + encodeURIComponent(key)); }, 'Rol silindi.')) {
            state.refs.roles = null;
            route();
        }
    };

    /* ---------- Özellikler ---------- */

    async function renderFeatures(seq) {
        setTitle('Özellikler');
        setView(loadingHtml());
        state.refs.features = null;
        await Promise.all([ensureRef('features'), ensureRef('plans')]);
        if (seq !== state.seq) return;
        var canToggle = can('features.manage');
        var rows = arr(state.refs.features).map(function (f) {
            var on = f.is_enabled !== false;
            var plans = arr(f.plans).map(function (p) {
                return typeof p === 'string' ? planName(p) : (p.name || p.slug || '');
            }).filter(Boolean);
            var label = f.name || f.key;
            var ctrl = canToggle
                ? '<button type="button" class="switch" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-label="' + escapeHtml(label) + '" data-act="feature-toggle" data-key="' + escapeHtml(f.key) + '"><span class="switch-knob" aria-hidden="true"></span></button>'
                : '';
            return '<tr><th scope="row"><span class="feat-title">' + escapeHtml(label) + '</span>' +
                (f.description ? '<span class="feat-desc">' + escapeHtml(f.description) + '</span>' : '') +
                '<code>' + escapeHtml(f.key) + '</code></th>' +
                '<td>' + escapeHtml(plans.length ? plans.join(', ') : '—') + '</td>' +
                '<td><div class="switch-row">' + ctrl + '<span class="switch-text">' + (on ? 'Açık' : 'Kapalı') + '</span></div></td></tr>';
        }).join('');
        setView(
            '<div class="callout callout-warn" role="note"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>' +
            '<p><strong>Dikkat:</strong> Kapatılan özellik yöneticiler dışında tüm müşterilere anında kapanır.</p></div>' +
            tableHtml('Özellik bayrakları', ['Özellik', 'Planlar', 'Durum'], rows || emptyRow(3, 'Özellik bulunamadı.'))
        );
    }

    ACTIONS['feature-toggle'] = async function (btn) {
        var key = btn.getAttribute('data-key');
        var next = btn.getAttribute('aria-checked') !== 'true';
        var flag = arr(state.refs.features).filter(function (f) { return f.key === key; })[0];
        var label = flag ? (flag.name || key) : key;
        if (!next) {
            var go = await confirmDialog('Özelliği kapat',
                '"' + label + '" özelliğini kapatmak üzeresiniz. Kapatılan özellik yöneticiler dışında tüm müşterilere anında kapanır.',
                'Kapat', true);
            if (!go) return;
        }
        if (await action(function () {
            return api('PUT', API + '/features/' + encodeURIComponent(key), { is_enabled: next });
        }, next ? 'Özellik açıldı.' : 'Özellik kapatıldı.')) route();
    };

    /* ---------- Başlat ---------- */

    function init() {
        viewEl = document.getElementById('view');
        regionEl = document.getElementById('toastRegion');
        viewEl.addEventListener('click', onViewClick);
        viewEl.addEventListener('submit', onViewSubmit);
        viewEl.addEventListener('change', onViewChange);
        viewEl.addEventListener('keydown', onViewKeydown);
        document.getElementById('btnLogout').addEventListener('click', logout);
        loadMe();
    }

    document.addEventListener('DOMContentLoaded', init);
})();

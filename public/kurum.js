/* Kurum yöneticisi paneli (/kurum). /api/org/* uçlarını kullanır. Satır içi olay yok (CSP). */
(function () {
    'use strict';

    var API = '/api/org';
    var MEMBER_ROLE_LABELS = { member: 'Üye', org_admin: 'Kurum yöneticisi' };
    var JOINED_LABELS = { admin: 'Yönetici ekledi', domain: 'Alan adı', invitation: 'Davet', org_admin: 'Kurum yöneticisi' };
    var STATUS_LABELS = { trial: 'Deneme', active: 'Aktif', suspended: 'Askıda', expired: 'Süresi doldu' };
    var STATUS_KIND = { trial: 'info', active: 'ok', suspended: 'danger', expired: 'muted' };

    var state = { meId: null, org: null, role: null, viewEl: null, regionEl: null, seq: 0 };

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
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

    function badge(kind, text) {
        return '<span class="badge badge-' + kind + '">' + escapeHtml(text) + '</span>';
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

    function tableHtml(caption, headers, rowsHtml) {
        return '<div class="table-wrap" tabindex="0"><table class="data-table"><caption class="sr-only">' + escapeHtml(caption) + '</caption>' +
            '<thead><tr>' + headers.map(function (h) { return '<th scope="col">' + escapeHtml(h) + '</th>'; }).join('') + '</tr></thead>' +
            '<tbody>' + rowsHtml + '</tbody></table></div>';
    }

    function emptyRow(cols, text) {
        return '<tr><td class="empty" colspan="' + cols + '">' + escapeHtml(text) + '</td></tr>';
    }

    function fact(label, valueHtml) {
        return '<div class="fact"><dt>' + escapeHtml(label) + '</dt><dd>' + valueHtml + '</dd></div>';
    }

    function toast(kind, message) {
        if (!state.regionEl) return;
        var t = document.createElement('div');
        t.className = 'toast toast-' + (kind === 'err' ? 'err' : 'ok');
        t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
        t.textContent = message;
        state.regionEl.appendChild(t);
        setTimeout(function () { t.remove(); }, kind === 'err' ? 8000 : 4500);
    }

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

    function setView(html) {
        if (state.viewEl) state.viewEl.innerHTML = html;
    }

    function loadingHtml(text) {
        return '<p class="loading" role="status">' + escapeHtml(text || 'Yükleniyor…') + '</p>';
    }

    function errorHtml(message) {
        return '<div class="error-box" role="alert"><p>' + escapeHtml(message || 'Bir hata oluştu.') + '</p>' +
            '<button type="button" class="btn btn-secondary" data-act="retry">Yeniden dene</button></div>';
    }

    function setTitle(text) {
        var h = document.getElementById('pageTitle');
        if (h) h.textContent = text;
        document.title = text + ' · Traktör Sektör Analizi';
    }

    /* ---------- Sayfa ---------- */

    async function load() {
        var seq = ++state.seq;
        setView(loadingHtml('Kurum bilgileri yükleniyor…'));
        var data;
        try {
            data = await api('GET', API + '/me');
        } catch (e) {
            if (e && e.status === 401) return;
            setView(errorHtml(e && e.message));
            return;
        }
        if (seq !== state.seq) return;
        state.org = data && data.organization ? data.organization : null;
        state.role = data ? data.member_role : null;

        if (!state.org) {
            setTitle('Kurum Yönetimi');
            setView('<section class="empty-state"><i class="fas fa-building" aria-hidden="true"></i>' +
                '<h2>Bir kuruma bağlı değilsiniz</h2>' +
                '<p>Kurumsal erişim için kurum yöneticinizle iletişime geçin.</p></section>');
            return;
        }

        setTitle(state.org.name || 'Kurum Yönetimi');
        var isAdmin = state.role === 'org_admin';
        var html = orgCardHtml(state.org, isAdmin);

        if (!isAdmin) {
            html += '<section class="section"><p class="field-help">Üye ve davet yönetimi yalnızca kurum yöneticileri içindir.</p></section>';
            setView(html);
            return;
        }

        html += '<section class="section" id="membersSection">' + loadingHtml('Üyeler yükleniyor…') + '</section>';
        setView(html);
        await loadMembers(seq);
    }

    function orgCardHtml(org, isAdmin) {
        var roleLabel = MEMBER_ROLE_LABELS[state.role] || state.role || '—';
        return '<section class="card" aria-label="Kurum özeti">' +
            '<div class="org-summary-top">' +
            badge(STATUS_KIND[org.status] || 'muted', STATUS_LABELS[org.status] || org.status || '—') + ' ' +
            (org.is_effective ? badge('ok', 'Geçerli') : badge('danger', 'Geçerli değil')) + ' ' +
            badge('info', roleLabel) +
            '</div>' +
            '<dl class="facts">' +
            fact('Plan', escapeHtml(org.plan_name || '—')) +
            fact('Koltuk kullanımı', seatBar(org.seats_used, org.seat_limit)) +
            fact('Sözleşme bitişi', escapeHtml(org.contract_end ? fmtDate(org.contract_end) : 'Süresiz')) +
            '</dl>' +
            '</section>';
    }

    async function loadMembers(seq) {
        var d = await api('GET', API + '/members');
        if (seq !== state.seq) return;
        var members = Array.isArray(d && d.members) ? d.members : [];
        var invs = Array.isArray(d && d.invitations) ? d.invitations : [];
        var sec = document.getElementById('membersSection');
        if (!sec) return;
        sec.innerHTML = membersHtml(members, invs);
    }

    function membersHtml(members, invs) {
        var inviteForm =
            '<h2>Üye davet et</h2>' +
            '<form data-form="invite" class="inline-form" novalidate>' +
            '<div class="field"><label for="inviteEmail">E-posta</label>' +
            '<input type="email" id="inviteEmail" name="email" required maxlength="254" autocomplete="off" placeholder="ad@sirket.com" aria-describedby="inviteHelp"></div>' +
            '<button type="submit" class="btn btn-primary"><i class="fas fa-paper-plane" aria-hidden="true"></i> Davet et</button></form>' +
            '<p class="field-help" id="inviteHelp">Davet edilen kişi bu e-posta ile kayıt olduğunda kurumunuza üye olarak eklenir. Koltuk sayınız dolu ise davet gönderilemez.</p>';

        var rows = members.map(function (m) {
            var isSelf = state.meId != null && Number(m.id) === Number(state.meId);
            var removeBtn = isSelf
                ? '<span class="note">Siz</span>'
                : '<button type="button" class="btn btn-danger btn-sm" data-act="member-remove" data-id="' + escapeHtml(m.id) + '" aria-label="Çıkar: ' + escapeHtml(m.email) + '"><i class="fas fa-user-minus" aria-hidden="true"></i> Çıkar</button>';
            return '<tr><th scope="row">' + escapeHtml(m.email) + '</th>' +
                '<td>' + escapeHtml(m.full_name || '—') + '</td>' +
                '<td>' + escapeHtml(MEMBER_ROLE_LABELS[m.member_role] || m.member_role || '—') + '</td>' +
                '<td>' + (m.email_verified ? badge('ok', 'Doğrulandı') : badge('warn', 'Doğrulanmadı')) + '</td>' +
                '<td>' + escapeHtml(fmtDateTime(m.last_login)) + '</td>' +
                '<td>' + escapeHtml(JOINED_LABELS[m.joined_via] || m.joined_via || '—') + '</td>' +
                '<td>' + removeBtn + '</td></tr>';
        }).join('');

        var invRows = invs.map(function (i) {
            return '<tr><th scope="row">' + escapeHtml(i.email) + '</th>' +
                '<td>' + escapeHtml(fmtDate(i.created_at)) + '</td>' +
                '<td><button type="button" class="btn btn-secondary btn-sm" data-act="invite-revoke" data-id="' + escapeHtml(i.id) + '" aria-label="Daveti iptal et: ' + escapeHtml(i.email) + '">İptal et</button></td></tr>';
        }).join('');

        return '<section class="section">' + inviteForm + '</section>' +
            '<section class="section"><h2>Üyeler (' + fmtNum(members.length) + ')</h2>' +
            tableHtml('Kurum üyeleri', ['E-posta', 'Ad soyad', 'Rol', 'Doğrulama', 'Son giriş', 'Kaynak', 'İşlem'],
                rows || emptyRow(7, 'Henüz üye yok.')) + '</section>' +
            '<section class="section"><h2>Bekleyen davetler (' + fmtNum(invs.length) + ')</h2>' +
            tableHtml('Bekleyen davetler', ['E-posta', 'Davet tarihi', 'İşlem'], invRows || emptyRow(3, 'Bekleyen davet yok.')) + '</section>';
    }

    function refreshAll() {
        load();
    }

    /* ---------- Olaylar ---------- */

    var ACTIONS = {
        retry: function () { load(); },
        'member-remove': async function (btn) {
            var id = btn.getAttribute('data-id');
            if (!window.confirm('Bu kişi kurumdan çıkarılacak. Kullanıcı hesabı silinmez; koltuk boşalır. Devam edilsin mi?')) return;
            if (await action(function () { return api('DELETE', API + '/members/' + id); }, 'Üye kurumdan çıkarıldı.')) refreshAll();
        },
        'invite-revoke': async function (btn) {
            var id = btn.getAttribute('data-id');
            if (await action(function () { return api('DELETE', API + '/invitations/' + id); }, 'Davet iptal edildi.')) refreshAll();
        }
    };

    var FORMS = {
        invite: async function (form) {
            var email = (form.querySelector('[name="email"]').value || '').trim();
            if (!email) return toast('err', 'E-posta adresi zorunludur.');
            if (await action(function () { return api('POST', API + '/members', { email: email }); }, 'Davet gönderildi.')) {
                form.reset();
                refreshAll();
            }
        }
    };

    function onClick(ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!t || t.disabled) return;
        var fn = ACTIONS[t.getAttribute('data-act')];
        if (fn) {
            ev.preventDefault();
            fn(t, ev);
        }
    }

    function onSubmit(ev) {
        var f = ev.target;
        var name = f && f.getAttribute ? f.getAttribute('data-form') : null;
        if (!name) return;
        ev.preventDefault();
        if (FORMS[name]) FORMS[name](f);
    }

    function logout() {
        var go = function () { window.location.href = '/login.html'; };
        fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-Web-Session': '1' }
        }).then(go, go);
    }

    async function loadUser() {
        try {
            var me = await api('GET', '/api/auth/me');
            var u = me && me.user ? me.user : me;
            state.meId = u && u.id != null ? u.id : null;
            var el = document.getElementById('userName');
            if (el && u) el.textContent = u.full_name || u.email || '';
        } catch (e) {
            // Kullanıcı bilgisi yalnızca kendi satırını gizlemek için kullanılır; hata akışı bozmaz.
        }
    }

    function init() {
        state.viewEl = document.getElementById('view');
        state.regionEl = document.getElementById('toastRegion');
        state.viewEl.addEventListener('click', onClick);
        state.viewEl.addEventListener('submit', onSubmit);
        document.getElementById('btnLogout').addEventListener('click', logout);
        loadUser().then(load);
    }

    document.addEventListener('DOMContentLoaded', init);
})();

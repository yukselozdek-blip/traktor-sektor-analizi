(function () {
    var POLICY = /^(?=.*[A-ZÇĞİÖŞÜ])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{10,}$/;
    var POLICY_MSG = 'Şifre en az 10 karakter, 1 büyük harf, 1 sayı ve 1 özel karakter içermeli';
    var token = new URLSearchParams(location.search).get('token') || '';
    // Token adres çubuğundan ve geçmişten çıkarılır.
    try { history.replaceState(null, '', location.pathname); } catch (e) {}

    var $ = function (id) { return document.getElementById(id); };
    function show(name) {
        ['stateLoading', 'stateInvalid', 'stateForm', 'stateDone'].forEach(function (s) {
            $(s).classList.toggle('is-active', s === name);
        });
    }
    function msg(kind, text) {
        $('errorMsg').style.display = kind === 'error' ? 'block' : 'none';
        $('infoMsg').style.display = kind === 'info' ? 'block' : 'none';
        if (kind === 'error') $('errorMsg').textContent = text;
        if (kind === 'info') $('infoMsg').textContent = text;
    }

    document.querySelectorAll('[data-toggle]').forEach(function (b) {
        b.addEventListener('click', function () {
            var inp = $(b.getAttribute('data-toggle'));
            var hide = inp.type === 'password';
            inp.type = hide ? 'text' : 'password';
            b.textContent = hide ? 'Gizle' : 'Göster';
        });
    });

    async function validate() {
        if (!/^[0-9a-f]{64}$/.test(token)) return show('stateInvalid');
        try {
            var r = await fetch('/api/auth/reset-password/validate?token=' + encodeURIComponent(token));
            var d = await r.json().catch(function () { return {}; });
            show(d && d.valid ? 'stateForm' : 'stateInvalid');
        } catch (e) {
            show('stateInvalid');
            msg('error', 'Bağlantı hatası. Lütfen sayfayı yenileyin.');
        }
    }

    $('resetForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        msg('none');
        var p1 = $('pw1').value, p2 = $('pw2').value;
        if (!POLICY.test(p1)) return msg('error', POLICY_MSG);
        if (p1 !== p2) return msg('error', 'Şifreler eşleşmiyor');
        var btn = $('submitBtn');
        btn.disabled = true;
        try {
            var r = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: token, password: p1 })
            });
            var d = await r.json().catch(function () { return {}; });
            if (r.ok && d.ok) {
                $('pw1').value = ''; $('pw2').value = '';
                msg('none');
                show('stateDone');
            } else if (r.status === 400 && d.error && d.error.indexOf('Şifre en az') === 0) {
                msg('error', d.error);
            } else if (r.status === 400) {
                show('stateInvalid');
            } else {
                msg('error', d.error || 'İşlem başarısız. Lütfen tekrar deneyin.');
            }
        } catch (err) {
            msg('error', 'Bağlantı hatası. Lütfen tekrar deneyin.');
        } finally {
            btn.disabled = false;
        }
    });

    validate();
})();

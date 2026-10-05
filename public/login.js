const SUPERUSER_HINT = ['yukselozdek@gmail.com'];
let allBrands = [];
let signupCurrentStage = 1;

function showPreview(slug) {
    document.querySelectorAll('.preview-tab').forEach(t => t.classList.toggle('is-active', t.dataset.preview === slug));
    document.querySelectorAll('.preview-content').forEach(c => c.classList.toggle('is-active', c.id === `preview-${slug}`));
}

function syncPreview(slug) { showPreview(slug); }

function showTab(name) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === name));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.toggle('is-active', f.dataset.form === name));
    hideMessages();
}

function showError(msg) {
    const el = document.getElementById('errorMsg');
    el.textContent = msg; el.style.display = 'block';
    document.getElementById('infoMsg').style.display = 'none';
}
function showInfo(msg) {
    const el = document.getElementById('infoMsg');
    el.textContent = msg; el.style.display = 'block';
    document.getElementById('errorMsg').style.display = 'none';
}
function hideMessages() {
    document.getElementById('errorMsg').style.display = 'none';
    document.getElementById('infoMsg').style.display = 'none';
}

function checkPasswordStrength(input) {
    const v = input.value;
    const strength = document.getElementById('passwordStrength');
    const len = v.length, hasUpper = /[A-ZÇĞİÖŞÜ]/.test(v), hasNum = /\d/.test(v), hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(v);
    if (len === 0) { strength.textContent = 'Şifre güvenliği değerlendirilecek'; strength.className = 'password-strength'; return; }
    if (len < 10 || !hasUpper || !hasNum || !hasSpecial) {
        strength.textContent = `Eksik: ${[len<10?'10+ karakter':null, !hasUpper?'büyük harf':null, !hasNum?'rakam':null, !hasSpecial?'özel karakter':null].filter(Boolean).join(', ')}`;
        strength.className = 'password-strength is-weak';
    } else if (len < 14) {
        strength.textContent = '✓ Güvenli — daha güçlü için 14+ karakter önerilir'; strength.className = 'password-strength is-medium';
    } else {
        strength.textContent = '✓ Çok güçlü'; strength.className = 'password-strength is-strong';
    }
}

function checkSuperuserHint() {
    const emailInput = document.querySelector('#loginForm input[name="email"]');
    const banner = document.getElementById('superuserBanner');
    if (!emailInput) return;
    emailInput.addEventListener('input', () => {
        const v = emailInput.value.trim().toLowerCase();
        banner.style.display = SUPERUSER_HINT.includes(v) ? 'block' : 'none';
    });
}

function wizardGoTo(stage) {
    signupCurrentStage = stage;
    document.querySelectorAll('.wizard-stage').forEach(s => s.style.display = (Number(s.dataset.stage) === stage ? 'flex' : 'none'));
    document.querySelectorAll('.wizard-stage').forEach(s => s.style.flexDirection = 'column');
    document.querySelectorAll('.wizard-stage').forEach(s => s.style.gap = '12px');
    document.querySelectorAll('.wizard-step').forEach(el => {
        const n = Number(el.dataset.step);
        el.classList.toggle('is-done', n < stage);
        el.classList.toggle('is-active', n === stage);
    });
    hideMessages();
}

function wizardNext(currentStage) {
    const form = document.getElementById('signupForm');
    const stage = form.querySelector(`.wizard-stage[data-stage="${currentStage}"]`);
    // Validate stage inputs
    if (currentStage === 2) {
        const required = ['full_name', 'email', 'password'];
        for (const f of required) {
            const inp = stage.querySelector(`[name="${f}"]`);
            if (!inp.value || !inp.checkValidity()) { showError(`${inp.previousElementSibling?.textContent || f} alanı eksik veya geçersiz`); return; }
        }
        const pw = stage.querySelector('[name="password"]').value;
        const policy = /^(?=.*[A-ZÇĞİÖŞÜ])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{10,}$/;
        if (!policy.test(pw)) { showError('Şifre politikasını karşılamıyor (10+ karakter, büyük harf, sayı, özel karakter)'); return; }
    }
    if (currentStage === 3) {
        const brandId = document.getElementById('brandIdHidden').value;
        if (!brandId) { showError('Marka seçimi zorunludur'); return; }
        if (!document.getElementById('inviteCodeInput').value.trim()) { showError('Davet kodu zorunludur'); return; }
    }
    wizardGoTo(currentStage + 1);
}

function wizardBack(currentStage) {
    wizardGoTo(currentStage - 1);
}

async function loadBrandsForSignup() {
    try {
        const r = await fetch('/api/brand-portals/directory').then(r => r.json());
        allBrands = (Array.isArray(r) ? r : []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr'));
        renderBrands(allBrands);
    } catch (e) {
        showError('Marka listesi yüklenemedi');
    }
}

function renderBrands(list) {
    const grid = document.getElementById('brandGrid');
    grid.innerHTML = list.map(b => `<div class="brand-mini-card" data-brand-id="${Number(b.id)}" data-on-click="selectBrand(${Number(b.id)})">${escapeHtml(b.name || '')}</div>`).join('') || '<p style="color: var(--muted); font-size: 12px;">Marka bulunamadı.</p>';
}

function filterBrands(query) {
    const q = String(query || '').toLowerCase();
    renderBrands(allBrands.filter(b => (b.name || '').toLowerCase().includes(q)));
}

function selectBrand(id, name) {
    document.getElementById('brandIdHidden').value = id;
    document.querySelectorAll('.brand-mini-card').forEach(el => el.classList.toggle('is-selected', Number(el.dataset.brandId) === Number(id)));
}

function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function togglePassword(btn) {
    const input = btn.parentElement.querySelector('input[type="password"], input[type="text"]');
    if (!input) return;
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    btn.querySelector('i').className = isHidden ? 'fas fa-eye-slash' : 'fas fa-eye';
}

function triggerGooglePrompt() {
    if (!window.GOOGLE_OAUTH_CLIENT_ID) {
        showError('Google girişi henüz yapılandırılmamış (GOOGLE_OAUTH_CLIENT_ID boş). Yönetici .env dosyasına Google OAuth Client ID ekledikten sonra çalışacak. Şu an kurumsal e-posta + şifre ile giriş yapabilir veya Üye Ol sekmesinden kayıt olabilirsiniz.');
        return;
    }
    if (!window.google || !google.accounts || !google.accounts.id) {
        showError('Google kütüphanesi yüklenemedi. İnternet bağlantınızı kontrol edip sayfayı yenileyin.');
        return;
    }
    try {
        // One-tap promptu tetikle; kullanıcı reddederse popup butonu fallback olarak görünür hale getir
        google.accounts.id.prompt((notification) => {
            if (notification.isNotDisplayed && notification.isNotDisplayed()) {
                // Pop-up engellendi ya da kullanıcı zaten kapattı → görünür native butona geç
                const native = document.getElementById('googleLoginContainer');
                if (native) {
                    native.style.display = 'flex';
                    showInfo('Google penceresi açılmadı. Beyaz Google butonu yerine altta beliren resmi Google butonunu kullanın.');
                }
            }
        });
    } catch (e) {
        console.warn('Google prompt hatası', e);
        showError('Google penceresi açılamadı: ' + (e.message || 'bilinmeyen hata'));
    }
}

function updateGoogleButtonState() {
    const btn = document.querySelector('.btn-google-strong');
    if (!btn) return;
    if (!window.GOOGLE_OAUTH_CLIENT_ID) {
        btn.classList.add('is-disabled');
        btn.title = 'Google OAuth henüz yapılandırılmamış';
    } else {
        btn.classList.remove('is-disabled');
        btn.title = '';
    }
}

function onForgotPassword() {
    showTab('forgot');
    const lt = document.querySelector('.auth-tab[data-tab="login"]');
    if (lt) lt.classList.add('is-active');
    const le = document.querySelector('#loginForm input[name="email"]');
    const fe = document.getElementById('forgotEmail');
    if (le && fe && le.value && !fe.value) fe.value = le.value.trim();
    if (fe) fe.focus();
}

document.getElementById('forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();
    const btn = document.getElementById('forgotSubmit');
    const email = document.getElementById('forgotEmail').value.trim().toLowerCase();
    if (!email) { showError('E-posta adresi gerekli'); return; }
    btn.disabled = true;
    try {
        const res = await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showInfo(data.message || 'Eğer bu e-posta kayıtlıysa, şifre sıfırlama bağlantısı gönderildi. Lütfen gelen kutunuzu kontrol edin.');
        } else {
            showError(data.error || 'İstek gönderilemedi. Lütfen daha sonra tekrar deneyin.');
        }
    } catch (err) {
        showError('Bağlantı hatası. Lütfen tekrar deneyin.');
    } finally {
        btn.disabled = false;
    }
});

function showMoreSignInWays() {
    showInfo('Şu anda Google ve kurumsal e-posta + şifre giriş yolları desteklenir. Kurumsal SSO/SAML Enterprise paketlere özel olarak yapılandırılabilir.');
}

// Login submit
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();
    const fd = new FormData(e.target);
    const email = fd.get('email').trim().toLowerCase();
    const remember = !!fd.get('remember_me');
    try {
        const data = await API.login(email, fd.get('password'));
        if (data?.mfa_required) { startMfa(data, { email, remember }); return; }
        finishPasswordLogin(data, { email, remember });
    } catch (err) {
        showError(err.message || 'Giriş başarısız');
        document.getElementById('btnResendLogin').style.display = err.code === 'EMAIL_NOT_VERIFIED' ? 'inline-flex' : 'none';
    }
});


function finishPasswordLogin(data, { email, remember }) {
    if (!(data?.session || data?.token)) return;
    if (data.user?.brand?.slug) localStorage.setItem('last_brand_slug', data.user.brand.slug);
    if (remember) localStorage.setItem('remember_email', email);
    else localStorage.removeItem('remember_email');
    let plan = null;
    try { plan = localStorage.getItem('post_login_plan'); localStorage.removeItem('post_login_plan'); } catch (_) { /* noop */ }
    // Kayıtta plan seçildiyse doğrulama sonrası ilk girişte abonelik sayfasına gidilir.
    window.location.href = plan && /^[a-z0-9_-]{1,50}$/i.test(plan) ? `/?page=subscription&plan=${encodeURIComponent(plan)}&billing=start` : '/';
}

// QR kod (kendi sunucumuzdan yüklenen qrcode-generator; çıktı yalnızca kütüphanenin ürettiği SVG'dir)
function renderQr(el, text) {
    if (!el) return;
    try {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (_) { el.style.display = 'none'; }
}

// ---- İki adımlı doğrulama: kod girişi veya (yönetici için) zorunlu kurulum ----
const mfaState = { token: null, setup: false, ctx: null, pendingData: null };

async function startMfa(data, ctx) {
    mfaState.token = data.mfa_token; mfaState.setup = !!data.mfa_setup_required; mfaState.ctx = ctx; mfaState.pendingData = null;
    showTab('mfa');
    document.getElementById('mfaRecoveryBox').style.display = 'none';
    document.getElementById('mfaSubmit').style.display = '';
    document.getElementById('mfaCode').value = '';
    document.getElementById('mfaCode').closest('.field').style.display = '';
    const setupBox = document.getElementById('mfaSetupBox');
    setupBox.style.display = mfaState.setup ? 'flex' : 'none';
    document.getElementById('mfaTitle').textContent = mfaState.setup ? 'İki Adımlı Doğrulamayı Kur' : 'İki Adımlı Doğrulama';
    document.getElementById('mfaHint').textContent = mfaState.setup
        ? 'Anahtarı uygulamaya ekledikten sonra uygulamanın gösterdiği 6 haneli kodu girin.'
        : 'Doğrulayıcı uygulamanızdaki 6 haneli kodu girin. Cihazınıza erişemiyorsanız kurtarma kodlarınızdan birini yazabilirsiniz.';
    if (mfaState.setup) {
        try {
            const s = await API.mfaSetup(mfaState.token);
            document.getElementById('mfaSecret').textContent = s.secret;
            const a = document.getElementById('mfaUri'); a.href = s.otpauth_uri;
            renderQr(document.getElementById('mfaQr'), s.otpauth_uri);
        } catch (err) { showError(err.message || 'Kurulum başlatılamadı'); return; }
    }
    document.getElementById('mfaCode').focus();
}

document.getElementById('mfaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();
    const code = document.getElementById('mfaCode').value.trim();
    const btn = document.getElementById('mfaSubmit');
    btn.disabled = true;
    try {
        if (mfaState.setup) {
            const r = await API.mfaEnable(code, mfaState.token);
            mfaState.pendingData = r;
            document.getElementById('mfaRecoveryList').textContent = (r.recovery_codes || []).join('\n');
            document.getElementById('mfaRecoveryBox').style.display = 'flex';
            document.getElementById('mfaSetupBox').style.display = 'none';
            document.getElementById('mfaCode').closest('.field').style.display = 'none';
            btn.style.display = 'none';
            document.getElementById('mfaContinue').focus();
        } else {
            const r = await API.mfaVerify(mfaState.token, code);
            if (r?.token || r?.session) {
                localStorage.setItem('user_data', JSON.stringify(r.user));
                finishPasswordLogin(r, mfaState.ctx || { email: '', remember: false });
            }
        }
    } catch (err) {
        showError(err.message || 'Doğrulama başarısız');
        if (/^Oturum süresi doldu/.test(err.message || '')) setTimeout(() => window.location.reload(), 1500);
    } finally { btn.disabled = false; }
});

document.getElementById('mfaContinue').addEventListener('click', () => {
    const r = mfaState.pendingData;
    if (r?.token || r?.session) {
        localStorage.setItem('user_data', JSON.stringify(r.user));
        finishPasswordLogin(r, mfaState.ctx || { email: '', remember: false });
    } else {
        window.location.reload(); // zorunlu olmayan akış: yeniden giriş
    }
});

async function resendVerification(email, btn) {
    email = String(email || '').trim().toLowerCase();
    if (!email) { showError('Önce e-posta adresinizi girin'); return; }
    if (btn) btn.disabled = true;
    try {
        const r = await API.resendVerification(email);
        showInfo(r?.message || 'Doğrulama e-postası gönderildi.');
    } catch (err) {
        showError(err.message || 'Gönderilemedi');
    } finally {
        if (btn) setTimeout(() => { btn.disabled = false; }, 5000);
    }
}

// Doğrulama bağlantısından dönüş
(function showVerifiedResult() {
    const v = new URLSearchParams(window.location.search).get('verified');
    if (v === '1') showInfo('E-posta adresiniz doğrulandı. Şimdi giriş yapabilirsiniz.');
    else if (v === '0') showError('Doğrulama bağlantısı geçersiz veya süresi dolmuş. Giriş yapmayı deneyip bağlantıyı tekrar isteyebilirsiniz.');
})();

// Beni hatırla — sayfa açılışında doldur
(function prefillRememberedEmail() {
    const remembered = localStorage.getItem('remember_email');
    if (remembered) {
        const emailInput = document.querySelector('#loginForm input[name="email"]');
        const cb = document.getElementById('rememberMe');
        if (emailInput) emailInput.value = remembered;
        if (cb) cb.checked = true;
    }
})();

// Signup submit (final stage)
document.getElementById('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();
    const btn = document.getElementById('btnSignup');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Hesap oluşturuluyor...';
    const fd = new FormData(e.target);
    const payload = {
        email: fd.get('email').trim().toLowerCase(),
        password: fd.get('password'),
        full_name: fd.get('full_name').trim(),
        brand_id: Number(document.getElementById('brandIdHidden').value),
        invite_code: String(fd.get('invite_code') || '').trim(),
        plan_slug: fd.get('plan_slug') || 'growth',
        company_name: fd.get('company_name').trim(),
        company_tax_office: fd.get('company_tax_office') || null,
        company_tax_number: fd.get('company_tax_number') || null,
        job_title: fd.get('job_title'),
        dealer_or_distributor: fd.get('dealer_or_distributor'),
        phone: fd.get('phone') || null,
        city: fd.get('city') || null
    };
    try {
        const data = await API.signup(payload);
        if (data?.email_verify_required) {
            // Oturum açılmaz; doğrulama sonrası giriş yapılır ve abonelik sayfasına gidilir.
            try { localStorage.setItem('post_login_plan', payload.plan_slug); } catch (_) { /* noop */ }
            hideMessages();
            document.querySelector('.auth-tabs').style.display = 'none';
            document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('is-active'));
            document.getElementById('verifyEmailLabel').textContent = payload.email;
            const vp = document.getElementById('verifyPanel');
            vp.style.display = 'flex';
            document.getElementById('btnResendSignup').onclick = function () { resendVerification(payload.email, this); };
        }
    } catch (err) {
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-check-circle"></i> Üyeliği Tamamla';
        showError(err.message || 'Kayıt başarısız');
    }
});

// Google Sign-in
function initGoogle() {
    if (!window.google) return setTimeout(initGoogle, 500);
    const clientId = window.GOOGLE_OAUTH_CLIENT_ID || '';
    if (!clientId) {
        document.getElementById('googleLoginContainer').innerHTML = '<small style="color: var(--muted); font-size: 11px;">Google OAuth yapılandırılmadı</small>';
        document.getElementById('googleSignupContainer').innerHTML = '';
        return;
    }
    try {
        google.accounts.id.initialize({
            client_id: clientId,
            callback: handleGoogleCredential,
            auto_select: false,
            cancel_on_tap_outside: true
        });
        ['googleLoginContainer', 'googleSignupContainer'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'rectangular', width: 320 });
            }
        });
    } catch (e) {
        console.warn('Google init hatası', e);
    }
}

async function handleGoogleCredential(response) {
    hideMessages();
    try {
        const fd = new FormData(document.getElementById('signupForm'));
        const payload = {
            id_token: response.credential,
            brand_id: document.getElementById('brandIdHidden').value ? Number(document.getElementById('brandIdHidden').value) : null,
            invite_code: String(fd.get('invite_code') || '').trim() || null,
            plan_slug: fd.get('plan_slug') || 'growth',
            company_name: fd.get('company_name') || null,
            job_title: fd.get('job_title') || null
        };
        const r = await fetch('/api/auth/google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-Web-Session': '1' },
            credentials: 'same-origin',
            body: JSON.stringify(payload)
        });
        const data = await r.json();
        if (r.status === 202 && data.code === 'GOOGLE_NEEDS_PROFILE') {
            showInfo(`Google hesabınız tanımlandı (${data.google_email}). Üye Ol sekmesinde davet kodu, marka ve firma bilgisi girin.`);
            showTab('signup');
            return;
        }
        if (!r.ok) { showError(data.error || 'Google girişi başarısız'); return; }
        if (data?.mfa_required) { startMfa(data, { email: '', remember: false }); return; }
        if (data?.session || data?.token) {
            localStorage.setItem('user_data', JSON.stringify(data.user));
            if (data.user?.brand?.slug) localStorage.setItem('last_brand_slug', data.user.brand.slug);
            if (data.is_new && data.pending_subscription) {
                window.location.href = `/?page=subscription&plan=${data.pending_subscription.plan_slug || 'growth'}&billing=start`;
            } else {
                window.location.href = '/';
            }
        }
    } catch (err) {
        showError(err.message || 'Google işlemi başarısız');
    }
}

// Init
loadBrandsForSignup();
checkSuperuserHint();
initGoogle();

// Auto-redirect if already logged in
API.probeSession().then(u => { if (u) window.location.href = '/'; });

// Backend'den Google client ID'sini opsiyonel olarak al, butonun durumunu güncelle
fetch('/api/auth/google-config')
    .then(r => r.ok ? r.json() : {})
    .then(c => {
        if (c && c.client_id) {
            window.GOOGLE_OAUTH_CLIENT_ID = c.client_id;
            initGoogle();
        }
        if (typeof updateGoogleButtonState === 'function') updateGoogleButtonState();
    })
    .catch(() => { if (typeof updateGoogleButtonState === 'function') updateGoogleButtonState(); });

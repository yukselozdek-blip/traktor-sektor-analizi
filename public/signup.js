let allPlans = [];
let selectedPlanSlug = null;

async function loadInitialData() {
    try {
        const [plans, brandsRes] = await Promise.all([
            fetch('/api/plans').then(r => r.json()),
            fetch('/api/brand-portals/directory').then(r => r.json()).catch(() => [])
        ]);
        allPlans = plans;
        renderPlans(plans);
        renderBrands(brandsRes);
    } catch (err) {
        showError('Sistem verisi yüklenemedi. Sayfayı yenileyin.');
    }
}

function renderPlans(plans) {
    const grid = document.getElementById('plansGrid');
    grid.innerHTML = plans.map(p => {
        const features = (() => { try { return typeof p.features === 'string' ? JSON.parse(p.features) : (p.features || []); } catch (e) { return []; } })();
        return `
            <div class="plan-card" data-slug="${escapeHtml(p.slug)}" data-on-click="selectPlan(this.dataset.slug)">
                <div class="plan-tier">Tier ${p.tier_rank || 1}</div>
                <div class="plan-name">${escapeHtml(p.name)}</div>
                <div class="plan-price">₺${formatNumber(p.price_monthly)}<small>/ay</small></div>
                <div class="plan-desc">${escapeHtml(p.description || '')}</div>
                <ul class="plan-features">
                    ${features.slice(0, 5).map(f => `<li><i class="fas fa-check"></i><span>${escapeHtml(f)}</span></li>`).join('')}
                </ul>
            </div>
        `;
    }).join('');

    // Default Pro plan seçili
    const defaultSlug = plans.find(p => p.slug === 'pro')?.slug || plans[0]?.slug;
    if (defaultSlug) selectPlan(defaultSlug);
}

function renderBrands(directory) {
    const sel = document.getElementById('brandSelect');
    const list = (Array.isArray(directory) ? directory : []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr'));
    sel.innerHTML = '<option value="">Marka seçin...</option>' +
        list.map(b => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('');
}

function selectPlan(slug) {
    selectedPlanSlug = slug;
    document.querySelectorAll('.plan-card').forEach(el => {
        el.classList.toggle('is-active', el.dataset.slug === slug);
    });
    const plan = allPlans.find(p => p.slug === slug);
    document.getElementById('selectedPlanLabel').value = plan ? `${plan.name} — ₺${formatNumber(plan.price_monthly)}/ay` : '';
    document.getElementById('btnSignup').disabled = !slug;
}

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatNumber(n) {
    return new Intl.NumberFormat('tr-TR').format(Number(n) || 0);
}

function showError(msg) {
    const el = document.getElementById('errorMsg');
    el.style.color = '';
    el.textContent = msg;
    el.style.display = 'block';
}
function showInfoMsg(msg) {
    const el = document.getElementById('errorMsg');
    el.textContent = msg;
    el.style.display = 'block';
    el.style.color = '#86efac';
}

document.getElementById('signupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = document.getElementById('btnSignup');
    const errorEl = document.getElementById('errorMsg');
    errorEl.style.display = 'none';
    if (!selectedPlanSlug) { showError('Önce bir plan seçin'); return; }
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Hesap oluşturuluyor...</span>';

    const fd = new FormData(event.target);
    const payload = {
        email: fd.get('email').trim().toLowerCase(),
        password: fd.get('password'),
        full_name: fd.get('full_name').trim(),
        brand_id: Number(fd.get('brand_id')),
        invite_code: String(fd.get('invite_code') || '').trim(),
        phone: fd.get('phone') || null,
        company_name: fd.get('company_name') || null,
        city: fd.get('city') || null,
        plan_slug: selectedPlanSlug
    };

    try {
        const data = await API.signup(payload);
        if (data?.email_verify_required) {
            // Oturum açılmaz; e-posta doğrulandıktan sonra giriş yapılır ve abonelik sayfasına gidilir.
            try { localStorage.setItem('post_login_plan', selectedPlanSlug); } catch (_) { /* noop */ }
            document.getElementById('signupForm').style.display = 'none';
            document.getElementById('verifyEmailLabel').textContent = payload.email;
            document.getElementById('verifyPanel').style.display = 'block';
            document.getElementById('btnResend').onclick = async function () {
                this.disabled = true;
                try { const r = await API.resendVerification(payload.email); showInfoMsg(r?.message || 'Gönderildi'); }
                catch (e2) { showError(e2.message || 'Gönderilemedi'); }
                setTimeout(() => { this.disabled = false; }, 5000);
            };
        } else {
            showError('Kayıt tamamlanamadı. Lütfen tekrar deneyin.');
            btn.disabled = false;
        }
    } catch (err) {
        showError(err.message || 'Kayıt başarısız');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check-circle"></i><span>Aboneliği Başlat</span>';
    }
});

loadInitialData();

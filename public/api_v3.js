// ============================================
// API CLIENT - Traktör Sektör Analizi
// ============================================

const API = {
    baseURL: '',
    token: localStorage.getItem('auth_token'),
    cache: new Map(),
    cacheTTL: 5 * 60 * 1000,
    requestTimeoutMs: 15000,
    deployBridgePort: 3010,
    mediaWatchBridgePort: 3011,

    async fetchWithTimeout(url, opts = {}, timeoutMs = this.requestTimeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            return await fetch(url, { ...opts, signal: controller.signal });
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error('İstek zaman aşımına uğradı');
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    },

    async request(method, path, body = null) {
        const cacheKey = `${method}:${path}:${JSON.stringify(body)}`;
        if (method === 'GET' && this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.time < this.cacheTTL) return cached.data;
        }

        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

        const opts = { method, headers };
        if (body) opts.body = JSON.stringify(body);

        const res = await this.fetchWithTimeout(`${this.baseURL}${path}`, opts);
        if (res.status === 401) {
            this.logout();
            return null;
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Bilinmeyen hata' }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (method === 'GET') this.cache.set(cacheKey, { data, time: Date.now() });
        return data;
    },

    get(path) { return this.request('GET', path); },
    post(path, body) { return this.request('POST', path, body); },
    put(path, body) { return this.request('PUT', path, body); },
    delete(path) { return this.request('DELETE', path); },

    buildQuery(params = {}) {
        const searchParams = new URLSearchParams();
        Object.entries(params).forEach(([key, value]) => {
            if (value === undefined || value === null || value === '') return;
            searchParams.set(key, String(value));
        });
        return searchParams.toString();
    },

    getDeployBridgeBaseURL() {
        const protocol = window.location.protocol || 'http:';
        const hostname = window.location.hostname || 'localhost';
        return `${protocol}//${hostname}:${this.deployBridgePort}`;
    },

    getMediaWatchBridgeBaseURL() {
        const protocol = window.location.protocol || 'http:';
        const hostname = window.location.hostname || 'localhost';
        return `${protocol}//${hostname}:${this.mediaWatchBridgePort}`;
    },

    async deployBridgeRequest(method, path, body = null) {
        const headers = {
            'Content-Type': 'application/json',
            'X-Deploy-Intent': 'railway-up'
        };
        const opts = {
            method,
            headers,
            cache: 'no-store'
        };
        if (body) opts.body = JSON.stringify(body);

        const res = await this.fetchWithTimeout(`${this.getDeployBridgeBaseURL()}${path}`, opts);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        return res.json();
    },

    async mediaWatchBridgeRequest(method, path, body = null) {
        const headers = {
            'Content-Type': 'application/json'
        };
        const opts = {
            method,
            headers,
            cache: 'no-store'
        };
        if (body) opts.body = JSON.stringify(body);

        const res = await this.fetchWithTimeout(`${this.getMediaWatchBridgeBaseURL()}${path}`, opts);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        return res.json();
    },

    setToken(token) {
        this.token = token;
        localStorage.setItem('auth_token', token);
    },

    getLoginDestination() {
        const lastBrandSlug = localStorage.getItem('last_brand_slug');
        return lastBrandSlug ? `/giris/${lastBrandSlug}` : '/login.html';
    },

    logout() {
        this.token = null;
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user_data');
        window.location.href = this.getLoginDestination();
    },

    clearCache() { this.cache.clear(); },

    // Auth
    async login(email, password) {
        const data = await this.post('/api/auth/login', { email, password });
        if (data?.token) {
            this.setToken(data.token);
            localStorage.setItem('user_data', JSON.stringify(data.user));
            if (data.user?.brand?.slug) {
                localStorage.setItem('last_brand_slug', data.user.brand.slug);
            }
        }
        return data;
    },

    async me() { return this.get('/api/auth/me'); },
    async getBrandPortalDirectory() { return this.get('/api/brand-portals/directory'); },
    async getPublicBrandPortal(slug) { return this.get(`/api/brand-portals/public/${encodeURIComponent(slug)}`); },
    async getBrandPortal(brandId) {
        const query = this.buildQuery({ brand_id: brandId || '' });
        return this.get(`/api/brand-portal${query ? `?${query}` : ''}`);
    },

    // Data endpoints
    async getDashboard(year) { return this.get(`/api/dashboard?year=${year || ''}`); },
    async getDashboardDeepDive(filters = {}) {
        const query = this.buildQuery({
            year: filters.year || '',
            brand_id: filters.brand_id || '',
            cabin_type: filters.cabin_type || '',
            drive_type: filters.drive_type || '',
            hp_range: filters.hp_range || '',
            gear_config: filters.gear_config || '',
            t: Date.now()
        });
        return this.get(`/api/dashboard/deep-dive?${query}`);
    },
    async getBrands() { return this.get('/api/brands'); },
    async getTuikYears() { return this.get(`/api/tuik/years?t=${Date.now()}`); },
    async getGearConfigs() { return this.get('/api/gear-configs'); },
    async getMapFilterOptions(year, filters) {
        const f = filters || {};
        const query = this.buildQuery({
            year: year || '',
            brand_id: f.brand_id || '',
            cabin_type: f.cabin_type || '',
            drive_type: f.drive_type || '',
            hp_range: f.hp_range || '',
            gear_config: f.gear_config || '',
            t: Date.now()
        });
        return this.get(`/api/map-filter-options?${query}`);
    },
    async getProvinces(region) { return this.get(`/api/provinces${region ? `?region=${region}&` : '?'}t=${Date.now()}`); },
    async getSalesHistorical(brandId) { return this.get(`/api/sales/historical?brand_id=${brandId || ''}`); },
    async getSalesSummary(year) { return this.get(`/api/sales/summary?year=${year || ''}`); },
    async getSalesByProvince(year, brandId, filters) {
        const f = filters || {};
        const query = this.buildQuery({
            year: year || '',
            brand_id: brandId || '',
            cabin_type: f.cabin_type || '',
            drive_type: f.drive_type || '',
            hp_range: f.hp_range || '',
            gear_config: f.gear_config || '',
            t: Date.now()
        });
        return this.get(`/api/sales/by-province?${query}`);
    },
    async getMonthlyTrend(year, brandId) { return this.get(`/api/sales/monthly-trend?year=${year || ''}&brand_id=${brandId || ''}`); },
    async getMarketShare(year, provinceId) { return this.get(`/api/sales/market-share?year=${year || ''}&province_id=${provinceId || ''}`); },
    async getSalesByCategory(year, dimension, brandId) { return this.get(`/api/sales/by-category?year=${year || ''}&dimension=${dimension || 'category'}&brand_id=${brandId || ''}`); },
    async getHpComparison(year, brandId) { return this.get(`/api/sales/hp-comparison?year=${year || ''}&brand_id=${brandId || ''}`); },
    async getCompetitorCompare(year, brandId, competitorIds) { return this.get(`/api/sales/competitor-compare?year=${year || ''}&brand_id=${brandId || ''}&competitor_ids=${competitorIds || ''}`); },
    async getModels(filters) { const q = new URLSearchParams(filters).toString(); return this.get(`/api/models?${q}`); },
    async getModelIntelligence(filters = {}) {
        const query = this.buildQuery({
            brand_id: filters.brand_id || '',
            brand: filters.brand || '',
            model: filters.model || '',
            tuik_model_adi: filters.tuik_model_adi || filters.model_code || '',
            q: filters.q || '',
            source_url: filters.source_url || '',
            t: Date.now()
        });
        return this.get(`/api/model-intelligence?${query}`);
    },
    async syncModelImageGallery(payload = {}) {
        const result = await this.post('/api/model-intelligence/gallery-sync', payload);
        this.cache.clear();
        return result;
    },
    async getModelImageCoverage() {
        return this.get('/api/admin/model-images/coverage');
    },
    async getModelImagePending(filters = {}) {
        const qs = this.buildQuery({
            brand: filters.brand || '',
            limit: filters.limit || 60
        });
        return this.get(`/api/admin/model-images/pending${qs ? `?${qs}` : ''}`);
    },
    async getModelImageMissing(filters = {}) {
        const qs = this.buildQuery({
            brand: filters.brand || '',
            limit: filters.limit || 80
        });
        return this.get(`/api/admin/model-images/missing${qs ? `?${qs}` : ''}`);
    },
    async approveModelImage(id, payload = {}) {
        const result = await this.post(`/api/admin/model-images/${id}/approve`, payload);
        this.cache.clear();
        return result;
    },
    async rejectModelImage(id, reason = '') {
        const result = await this.post(`/api/admin/model-images/${id}/reject`, { reason });
        this.cache.clear();
        return result;
    },
    async syncSingleModelImageBridge(payload = {}) {
        const result = await this.post('/api/admin/model-images/sync', payload);
        this.cache.clear();
        return result;
    },
    async syncMissingModelImages(payload = {}) {
        const result = await this.post('/api/admin/model-images/sync-missing', payload);
        this.cache.clear();
        return result;
    },
    async compareModels(modelIds) { return this.get(`/api/models/compare?model_ids=${modelIds}`); },
    async getWeather(provinceId) { return this.get(`/api/weather/${provinceId}`); },
    async getWeatherForecast(provinceId) { return this.get(`/api/weather/${provinceId}/forecast`); },
    async getClimate(provinceId) { return this.get(`/api/climate/${provinceId}`); },
    async getProvinceIntelligence(provinceId, year, brandId) {
        const query = this.buildQuery({
            year: year || '',
            brand_id: brandId || ''
        });
        return this.get(`/api/province-intelligence/${provinceId}${query ? `?${query}` : ''}`);
    },
    async getSoil(provinceId) { return this.get(`/api/soil/${provinceId}`); },
    async getCrops(provinceId, year) { return this.get(`/api/crops/${provinceId}?year=${year || ''}`); },
    async getInsights(brandId, provinceId, type) { return this.get(`/api/insights?brand_id=${brandId || ''}&province_id=${provinceId || ''}&type=${type || ''}`); },
    async getFutureIntelligenceReadiness() { return this.get('/api/meta/future-intelligence-readiness'); },
    async getFutureIntelligenceCatalog() { return this.get('/api/meta/future-intelligence-catalog'); },
    async seedFutureReferenceData(replaceExisting = false) { return this.post('/api/admin/future-intelligence/seed-reference-data', { replace_existing: replaceExisting }); },
    async runBaselineForecast(horizonMonths = 24, scenarioCode = 'base') {
        return this.post('/api/admin/forecast/run-baseline', {
            horizon_months: horizonMonths,
            scenario_code: scenarioCode
        });
    },
    async getForecastRuns() { return this.get('/api/forecast/runs'); },
    async getLatestForecast(filters = {}) {
        const query = this.buildQuery({
            forecast_run_id: filters.forecast_run_id || '',
            province_id: filters.province_id || '',
            brand_id: filters.brand_id || ''
        });
        return this.get(`/api/forecast/latest${query ? `?${query}` : ''}`);
    },
    async getForecastExecutive(filters = {}) {
        const query = this.buildQuery({
            forecast_run_id: filters.forecast_run_id || '',
            province_id: filters.province_id || '',
            brand_id: filters.brand_id || ''
        });
        return this.get(`/api/forecast/executive${query ? `?${query}` : ''}`);
    },
    async getPlans() { return this.get('/api/plans'); },
    async getSubscription() { return this.get('/api/subscription'); },
    async getMyFeatures() { return this.get('/api/me/features'); },
    async setPreviewPlan(plan_slug) { return this.post('/api/auth/preview-plan', { plan_slug }); },
    async getPaymentProviders() { return this.get('/api/billing/payment-providers'); },
    async getInvoices() { return this.get('/api/billing/invoices'); },
    async signup(payload) {
        const data = await this.post('/api/auth/signup', payload);
        if (data?.token) {
            this.setToken(data.token);
            localStorage.setItem('user_data', JSON.stringify(data.user));
        }
        return data;
    },
    async startCheckout(payload) { return this.post('/api/billing/checkout', payload); },
    async cancelSubscription() { return this.post('/api/billing/cancel', {}); },
    async confirmBankPayment(payload) { return this.post('/api/billing/bank-confirm', payload); },
    async listBankPending() { return this.get('/api/billing/bank-pending'); },
    async getUsage() { return this.get('/api/billing/usage'); },
    async getMediaWatchSources() { return this.get('/api/media-watch/sources'); },
    async getMediaWatchCoverage(brandId) { return this.get(`/api/media-watch/coverage${brandId ? `?brand_id=${brandId}` : ''}`); },
    async runMediaWatchNow(payload) { return this.post('/api/media-watch/run-now', payload || {}); },
    async translateMediaWatchItem(itemId) { return this.post('/api/media-watch/translate', { item_id: itemId }); },
    async getRivalsSelection() { return this.get('/api/billing/rivals'); },
    async setRivalsSelection(rival_brand_ids) { return this.put('/api/billing/rivals', { rival_brand_ids }); },
    async getWhatsAppPhones() { return this.get('/api/billing/whatsapp'); },
    async addWhatsAppPhone(payload) { return this.post('/api/billing/whatsapp', payload); },
    async deleteWhatsAppPhone(id) { return this.delete(`/api/billing/whatsapp/${id}`); },
    async getNotifications() { return this.get('/api/notifications'); },
    async markNotificationRead(id) { return this.put(`/api/notifications/${id}/read`); },
    async getWorkflows() { return this.get('/api/workflows'); },
    async getMediaWatchOverview(brandId) {
        const query = this.buildQuery({ brand_id: brandId || '' });
        return this.get(`/api/media-watch/overview${query ? `?${query}` : ''}`);
    },
    async getMediaWatchItems(filters = {}) {
        const query = this.buildQuery({
            brand_id: filters.brand_id || '',
            channel: filters.channel || '',
            type: filters.type || '',
            sentiment: filters.sentiment || '',
            search: filters.search || '',
            limit: filters.limit || ''
        });
        return this.get(`/api/media-watch/items${query ? `?${query}` : ''}`);
    },
    async getMediaWatchBrief(brandId) {
        const query = this.buildQuery({ brand_id: brandId || '' });
        return this.get(`/api/media-watch/brief${query ? `?${query}` : ''}`);
    },
    async getMediaWatchAlerts(filters = {}) {
        const query = this.buildQuery({
            brand_id: filters.brand_id || '',
            level: filters.level || '',
            type: filters.type || '',
            limit: filters.limit || ''
        });
        return this.get(`/api/media-watch/alerts${query ? `?${query}` : ''}`);
    },
    async generateMediaWatchBrief(brandId, windowDays = 14) {
        return this.post('/api/media-watch/brief/generate', {
            brand_id: brandId,
            window_days: windowDays
        });
    },
    async rebuildMediaWatchAlerts(brandId, windowDays = 30) {
        return this.post('/api/media-watch/alerts/rebuild', {
            brand_id: brandId,
            window_days: windowDays
        });
    },
    async getMediaWatchBridgeHealth() {
        return this.mediaWatchBridgeRequest('GET', '/health');
    },
    async triggerMediaWatchBridgePack(packCode, payload = {}) {
        return this.mediaWatchBridgeRequest('POST', `/api/media-watch/push-${packCode}`, payload);
    },
    async triggerMediaWatchBridgeAll(payload = {}) {
        return this.mediaWatchBridgeRequest('POST', '/api/media-watch/push-all', payload);
    },
    async getTotalMarket(brandId) { return this.get(`/api/sales/total-market?brand_id=${brandId || ''}`); },
    async getBrandEcosystemSummary() { return this.get('/api/sales/brand-ecosystem'); },
    async getBrandSummary() { return this.get('/api/sales/brand-summary'); },
    async getDistributorSummary() { return this.get('/api/sales/distributor-summary'); },
    async getHpCommandCenter(brandId) { return this.get(`/api/sales/hp-command-center?brand_id=${brandId || ''}`); },
    async getHpSummary() { return this.get('/api/sales/hp-summary'); },
    async getHpTopBrands() { return this.get('/api/sales/hp-top-brands'); },
    async getHpTopProvinces() { return this.get('/api/sales/hp-top-provinces'); },
    async getHpTopModels() { return this.get('/api/sales/hp-top-models'); },
    async getHpTopProvincesCat() { return this.get('/api/sales/hp-top-provinces-cat'); },
    async getObtHp() { return this.get('/api/sales/obt-hp'); },
    async getProvinceTopBrands(year, provinceId, brandId) {
        const query = this.buildQuery({
            year: year || '',
            province_id: provinceId || '',
            brand_id: brandId || '',
            t: Date.now()
        });
        return this.get(`/api/sales/province-top-brands?${query}`);
    },
    async getBrandHpDetail(brandId) { return this.get(`/api/sales/brand-hp-detail?brand_id=${brandId || ''}`); },
    async getHpBrandMatrix() { return this.get('/api/sales/hp-brand-matrix'); },
    async getAiAnalysis(type, context) { return this.post('/api/ai/analyze', { type, context }); },
    async getRegionalIndex(year) { return this.get(`/api/sales/regional-index?year=${year || ''}`); },
    async getModelRegion(filters = {}) {
        const query = this.buildQuery({
            brand_id: filters.brand_id || '',
            model_key: filters.model_key || ''
        });
        return this.get(`/api/sales/model-region${query ? `?${query}` : ''}`);
    },
    async getBenchmark(brand1Id, brand2Id) { return this.get(`/api/sales/benchmark?brand1_id=${brand1Id}&brand2_id=${brand2Id}`); },
    async getBrandCompare(brand1Id, brand2Id) { return this.get(`/api/sales/benchmark?brand1_id=${brand1Id}&brand2_id=${brand2Id}`); },
    async getTarmakBir(year) { return this.get(`/api/sales/tarmakbir?year=${year || ''}`); },
    async getTarmakBirTotal(year) { return this.get(`/api/sales/tarmakbir-total?year=${year || ''}`); },
    async seedModels() { return this.post('/api/admin/seed-models'); },
    async getRailwayDeployStatus() { return this.deployBridgeRequest('GET', '/api/deploy/status'); },
    async triggerRailwayDeploy() { return this.deployBridgeRequest('POST', '/api/deploy/railway', {}); }
};

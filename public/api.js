// ============================================
// API CLIENT - Traktör Sektör Analizi
// ============================================

const API = {
    baseURL: '',
    token: localStorage.getItem('auth_token'),
    cache: new Map(),
    cacheTTL: 5 * 60 * 1000,

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

        const res = await fetch(`${this.baseURL}${path}`, opts);
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

    setToken(token) {
        this.token = token;
        localStorage.setItem('auth_token', token);
    },

    logout() {
        this.token = null;
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user_data');
        window.location.href = '/login.html';
    },

    clearCache() { this.cache.clear(); },

    // Auth
    async login(email, password) {
        const data = await this.post('/api/auth/login', { email, password });
        if (data?.token) {
            this.setToken(data.token);
            localStorage.setItem('user_data', JSON.stringify(data.user));
        }
        return data;
    },

    async me() { return this.get('/api/auth/me'); },

    // Data endpoints
    async getDashboard(year) { return this.get(`/api/dashboard?year=${year || ''}`); },
    async getBrands() { return this.get('/api/brands'); },
    async getProvinces(region) { return this.get(`/api/provinces${region ? `?region=${region}` : ''}`); },
    async getSalesHistorical(brandId) { return this.get(`/api/sales/historical?brand_id=${brandId || ''}`); },
    async getSalesSummary(year) { return this.get(`/api/sales/summary?year=${year || ''}`); },
    async getSalesByProvince(year, brandId, filters) { const f = filters || {}; return this.get(`/api/sales/by-province?year=${year || ''}&brand_id=${brandId || ''}&cabin_type=${f.cabin_type || ''}&drive_type=${f.drive_type || ''}&hp_range=${f.hp_range || ''}&gear_config=${f.gear_config || ''}`); },
    async getMonthlyTrend(year, brandId) { return this.get(`/api/sales/monthly-trend?year=${year || ''}&brand_id=${brandId || ''}`); },
    async getMarketShare(year, provinceId) { return this.get(`/api/sales/market-share?year=${year || ''}&province_id=${provinceId || ''}`); },
    async getSalesByCategory(year, dimension, brandId) { return this.get(`/api/sales/by-category?year=${year || ''}&dimension=${dimension || 'category'}&brand_id=${brandId || ''}`); },
    async getHpComparison(year, brandId) { return this.get(`/api/sales/hp-comparison?year=${year || ''}&brand_id=${brandId || ''}`); },
    async getCompetitorCompare(year, brandId, competitorIds) { return this.get(`/api/sales/competitor-compare?year=${year || ''}&brand_id=${brandId || ''}&competitor_ids=${competitorIds || ''}`); },
    async getModels(filters) { const q = new URLSearchParams(filters).toString(); return this.get(`/api/models?${q}`); },
    async compareModels(modelIds) { return this.get(`/api/models/compare?model_ids=${modelIds}`); },
    async getWeather(provinceId) { return this.get(`/api/weather/${provinceId}`); },
    async getWeatherForecast(provinceId) { return this.get(`/api/weather/${provinceId}/forecast`); },
    async getClimate(provinceId) { return this.get(`/api/climate/${provinceId}`); },
    async getSoil(provinceId) { return this.get(`/api/soil/${provinceId}`); },
    async getCrops(provinceId, year) { return this.get(`/api/crops/${provinceId}?year=${year || ''}`); },
    async getInsights(brandId, provinceId, type) { return this.get(`/api/insights?brand_id=${brandId || ''}&province_id=${provinceId || ''}&type=${type || ''}`); },
    async getPlans() { return this.get('/api/plans'); },
    async getSubscription() { return this.get('/api/subscription'); },
    async getNotifications() { return this.get('/api/notifications'); },
    async markNotificationRead(id) { return this.put(`/api/notifications/${id}/read`); },
    async getWorkflows() { return this.get('/api/workflows'); },
    async getTotalMarket(brandId) { return this.get(`/api/sales/total-market?brand_id=${brandId || ''}`); },
    async getBrandSummary() { return this.get('/api/sales/brand-summary'); },
    async getDistributorSummary() { return this.get('/api/sales/distributor-summary'); },
    async getHpSummary() { return this.get('/api/sales/hp-summary'); },
    async getHpTopBrands() { return this.get('/api/sales/hp-top-brands'); },
    async getHpTopProvinces() { return this.get('/api/sales/hp-top-provinces'); },
    async getHpTopModels() { return this.get('/api/sales/hp-top-models'); },
    async getHpTopProvincesCat() { return this.get('/api/sales/hp-top-provinces-cat'); },
    async getProvinceTopBrands(year) { return this.get(`/api/sales/province-top-brands?year=${year || ''}`); }
};

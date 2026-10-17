'use strict';
// Yönetim denetim kaydı (admin_audit_log). Yazma hatası işlemi bozmaz; yalnızca uyarı yazılır.

async function logAdminAudit(db, req, action, targetType, targetId, details = {}) {
    try {
        const actor = req && req.user && req.user.id != null ? Number(req.user.id) : null;
        const ip = req && req.ip ? String(req.ip).slice(0, 45) : null;
        await db.query(
            `INSERT INTO admin_audit_log (actor_user_id, action, target_type, target_id, details, ip_address)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                actor,
                String(action).slice(0, 80),
                targetType == null ? null : String(targetType).slice(0, 40),
                targetId == null ? null : String(targetId).slice(0, 80),
                JSON.stringify(details == null ? {} : details),
                ip
            ]
        );
    } catch (err) {
        console.warn('logAdminAudit: denetim kaydı yazılamadı:', err && err.message);
    }
}

module.exports = { logAdminAudit };

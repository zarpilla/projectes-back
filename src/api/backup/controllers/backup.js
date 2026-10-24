'use strict';

/**
 * GET /api/backup/latest           → { available, createdAt, bytes, filename }
 * GET /api/backup/latest/download  → the .sql.gz file
 *
 * The host dumps every tenant's database each night, one after the other
 * (deploy/docker/tenant-dumps.sh), into a folder mounted at BACKUP_DIR. Each
 * container only mounts its own folder, so it can't reach another tenant's.
 */
const fs = require('fs');
const path = require('path');

const FILE = 'latest.sql.gz';

const backupDir = () => process.env.TENANT_BACKUP_DIR || '/opt/app/backups';
const backupPath = () => path.join(backupDir(), FILE);

/** The name the browser saves it as: <database>-<YYYYMMDD>.sql.gz */
function downloadName(createdAt) {
  const db = (process.env.DATABASE_NAME || 'esstrapis').replace(/[^\w.-]/g, '_');
  const day = createdAt.toISOString().slice(0, 10).replace(/-/g, '');
  return `${db}-${day}.sql.gz`;
}

async function latestInfo() {
  try {
    const stat = await fs.promises.stat(backupPath());
    if (!stat.isFile()) return { available: false };
    return {
      available: true,
      createdAt: stat.mtime.toISOString(),
      bytes: stat.size,
      filename: downloadName(stat.mtime),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') global.strapi.log.warn(`[backup] can't read ${backupPath()}: ${error.message}`);
    return { available: false };
  }
}

module.exports = () => ({
  async latest() {
    return latestInfo();
  },

  async download(ctx) {
    const info = await latestInfo();
    if (!info.available) return ctx.notFound('No hi ha cap còpia disponible');
    const user = ctx.state.user || {};
    global.strapi.log.info(`[backup] ${info.filename} (${info.bytes} bytes) downloaded by user ${user.id} ${user.email || ''}`);
    ctx.set('Content-Type', 'application/gzip');
    ctx.set('Content-Length', String(info.bytes));
    ctx.set('Content-Disposition', `attachment; filename="${info.filename}"`);
    ctx.set('Cache-Control', 'no-store');
    ctx.body = fs.createReadStream(backupPath());
  },
});

module.exports.latestInfo = latestInfo;
module.exports.downloadName = downloadName;

/**
 * pm2 process file for the VPS (docs/vi/DEPLOY_VPS.md).
 *
 *   pm2 startOrReload backend/deploy/ecosystem.config.cjs && pm2 save
 *
 * - ONE instance in fork mode: the rate limiter and the Python job queue (p-queue) live in process
 *   memory, so cluster mode / several instances would split them.
 * - Environment comes from LUNARNAV_ENV_FILE (default /etc/lunarnav/api.env, chmod 640) through
 *   Node's own --env-file: secrets never sit in this file or in `pm2 env` dumps of the ecosystem.
 * - kill_timeout > the 10 s graceful-shutdown timer in src/server.ts.
 */
'use strict';

const path = require('node:path');

const backendDir = path.resolve(__dirname, '..');
const envFile = process.env.LUNARNAV_ENV_FILE || '/etc/lunarnav/api.env';
const logDir = process.env.LUNARNAV_LOG_DIR || '/var/log/lunarnav';

module.exports = {
  apps: [
    {
      name: 'lunarnav-api',
      cwd: backendDir,
      script: 'dist/src/server.js',
      node_args: [`--env-file=${envFile}`],
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      max_memory_restart: process.env.LUNARNAV_MAX_MEMORY || '1G',
      kill_timeout: 12000,
      listen_timeout: 15000,
      time: true,
      merge_logs: true,
      out_file: path.join(logDir, 'api.out.log'),
      error_file: path.join(logDir, 'api.err.log'),
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

// ecosystem.config.js
// Phase 7 — Hardening & Deployment. pm2 process configuration. See
// .kiro/specs/hardening-deployment/design.md "Integration with
// src/index.js (ecosystem.config.js)" for design context.
//
// Usage: `pm2 start ecosystem.config.js` from this directory (or from
// anywhere, since `cwd` is set explicitly below).
//
// - autorestart: true    -> Requirement 4.2 (auto-restart on crash)
// - watch: false          -> Requirement 4.3 (the bot's own ./auth and
//   ./data directories change during normal operation — QR/session state,
//   pending-approval store, audit/alert logs — and must NOT trigger a
//   restart loop if pm2 were watching the filesystem)
// - max_restarts / restart_delay: a sane bound + a short delay between
//   supervisor-level restarts, distinct from and unrelated to this
//   phase's WhatsApp-level reconnect backoff (reconnectBackoff.js), which
//   governs reconnecting the WhatsApp socket WITHIN a single running
//   process, not pm2 restarting the process itself.
module.exports = {
  apps: [
    {
      name: 'wedding-expense-bot',
      script: 'src/index.js',
      cwd: __dirname,
      autorestart: true,
      watch: false,
      max_restarts: 50,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

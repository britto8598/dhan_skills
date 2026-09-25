// PM2 process file (alternative to Docker).
//   npm ci && npm run build
//   pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup
// Keep a single instance: the mock market simulator lives in process memory, so
// cluster mode would give each worker a different market. `pm2 reload` restarts
// it in ~2 s; browsers reconnect automatically.
module.exports = {
  apps: [
    {
      name: "orderflow-terminal",
      cwd: __dirname + "/..",
      script: "dist-server/server/index.js",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        HOST: "127.0.0.1",
        SIM_SPEED: 1,
      },
      max_memory_restart: "700M",
      kill_timeout: 5000,
      listen_timeout: 15000,
      autorestart: true,
      time: true,
    },
  ],
};

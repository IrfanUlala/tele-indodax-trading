module.exports = {
  apps: [{
    name: 'coint-trading',
    script: 'src/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    time: true,
    env: { NODE_ENV: 'production' }
  }]
};

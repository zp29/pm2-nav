module.exports = {
  apps: [
    {
      name: process.env.PM2_NAV_NAME || 'pm2-nav',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        NAV_HOST: '0.0.0.0',
        NAV_PORT: '80',
        PM2_NAV_HIDE_SELF: '1',
        PM2_NAV_DETECT_LISTEN: '1',
      },
    },
  ],
};

# Repository Guidelines

## Project Structure & Module Organization

This is a dependency-free Node.js service. `server.js` provides the HTTP API, authentication, PM2 discovery, configuration persistence, and static-page routing. `https-proxy.js` owns certificate generation and HTTP/WebSocket proxying. Browser UI is kept as self-contained HTML, CSS, and JavaScript in `public/index.html` and `public/login.html`. Tests live in `test/`; name new files `*.test.js`. Docker and PM2 entry points are defined by `Dockerfile`, `docker-compose.yml`, and `ecosystem.config.cjs`. Documentation assets and the optional GitHub Actions example belong in `docs/`.

Runtime state is written under `data/` and is gitignored. Use `config.example.json` to document configuration changes; never commit real credentials, generated certificates, or `data/https/lan-ca-key.pem`.

## Build, Test, and Development Commands

- `npm start` — run the navigation server directly. Use `NAV_PORT=8080 npm start` when port 80 is unavailable.
- `npm run check` — syntax-check the server and HTTPS proxy modules.
- `npm test` — run all tests with Node's built-in test runner. OpenSSL must be available for certificate/proxy tests.
- `npm run pm2:start` — launch the production-style process from the PM2 ecosystem file.
- `npm run pm2:reload` — reload the existing `pm2-nav` PM2 process.
- `docker compose up --build` — build and start the Linux host-integrated container.

Use Node.js 22 to match the Docker image. There is no separate compilation step or runtime dependency installation.

## Coding Style & Naming Conventions

Follow the existing CommonJS style: `require`, `module.exports`, semicolons, single quotes, and two-space indentation. Use `camelCase` for functions and variables, `PascalCase` for classes, and `UPPER_SNAKE_CASE` for module-level constants and environment variables. Keep request handlers small, return immediately after sending a response, and prefer Node's `node:` import prefix. No formatter or linter is configured, so preserve nearby formatting and run `npm run check` before submitting.

## Testing Guidelines

Use `node:test` with `node:assert/strict`. Tests should describe observable behavior, bind ephemeral ports, and clean up servers and temporary directories with `t.after()`. Add regression coverage for API, proxy, TLS, or WebSocket changes. No numeric coverage threshold is enforced; exercise both success and relevant failure paths.

## Commit & Pull Request Guidelines

History favors short, imperative subjects and has begun using Conventional Commit prefixes (for example, `feat: https`). Prefer `feat:`, `fix:`, `test:`, or `docs:` with a focused subject. Pull requests should explain behavior and configuration changes, list verification commands, link related issues, and include screenshots for changes under `public/`. Keep generated state and unrelated edits out of the diff.

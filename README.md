# PM2 服务导航

一个零依赖的 PM2 导航页，默认监听 `0.0.0.0:80`。

## 启动

```bash
cd /Users/zp29/Downloads/Code/pm2-nav
npm run pm2:start
```

如果 80 端口被占用或没有权限，可以先释放 80 端口、用反向代理转发到本服务，或临时指定高位端口测试：

```bash
NAV_PORT=8080 npm start
```

## 端口识别

服务会优先读取 PM2 环境变量里的 `PORT`、`APP_PORT`、`SERVER_PORT` 等字段，也会兼容 `--port 3000`、`-p 3000` 这类参数。未读到时，会尝试用 `lsof` 从进程监听端口中补充识别。

页面链接会根据当前浏览器访问的主机生成，例如：

- `http://localhost` 打开时跳到 `http://localhost:3000`
- `http://192.168.1.10` 打开时跳到 `http://192.168.1.10:3000`

## Docker

镜像适合 Linux 宿主机使用。由于容器默认看不到宿主机 PM2 进程，需要挂载 PM2_HOME，并共享宿主网络和 PID 命名空间：

```bash
docker run -d \
  --name pm2-nav \
  --restart unless-stopped \
  --network host \
  --pid host \
  -e NAV_PORT=80 \
  -e PM2_HOME=/root/.pm2 \
  -v "$HOME/.pm2:/root/.pm2" \
  zp29/pm2-nav:latest
```

也可以用 Compose：

```bash
PM2_NAV_IMAGE=zp29/pm2-nav:latest docker compose up -d
```

macOS 的 Docker Desktop 无法直接读取 macOS 宿主进程，建议在 macOS 上继续用 PM2 原生方式运行。

如果要开启 GitHub Actions 自动构建，可以把 `docs/github-actions-docker.yml` 复制到 `.github/workflows/docker.yml`，并在 GitHub 仓库 Secrets 中配置 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN`。

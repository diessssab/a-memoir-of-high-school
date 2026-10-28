#!/usr/bin/env bash
# =====================================================================
# 廊坊一中回忆录 —— 腾讯云轻量应用服务器一键部署脚本
#
# 适用：Ubuntu 20.04/22.04/24.04、Debian 11/12、OpenCloudOS / CentOS Stream
# 用法：先把整个项目上传到服务器，进入项目目录执行
#
#     sudo DOMAIN=memoir.example.com bash deploy/lighthouse-install.sh
#
#   DOMAIN 可以先不填（不填就用 IP 访问）。脚本做的事：
#     1. 装 Node.js 20（走 npmmirror，国内很快）
#     2. 建一个专跑网站的普通用户 memoir
#     3. npm install --omit=dev
#     4. 生成 .env（自动写随机 SESSION_SECRET 和后台密码）
#     5. 装 systemd 服务，开机自启、挂了自动拉起
#     6. 装 nginx 反代 80 → 127.0.0.1:3000，并放开 2.5GB 上传
#     7. 自检 /healthz
#
# 可以重复执行（改完配置再跑一次，会覆盖 nginx 与 systemd 配置，不动 data/ 和 uploads/）
# =====================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${APP_USER:-memoir}"
APP_PORT="${APP_PORT:-3000}"
DOMAIN="${DOMAIN:-}"
NODE_VERSION="${NODE_VERSION:-20.18.0}"
NODE_MIRROR="${NODE_MIRROR:-https://cdn.npmmirror.com/binaries/node}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
SERVICE_NAME="langfang-memoir"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[错误] %s\033[0m\n' "$*" >&2; exit 1; }

case "${1:-}" in
  -h|--help)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0 ;;
esac

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash deploy/lighthouse-install.sh"
[ -f "$APP_DIR/server/index.js" ] || die "没找到 server/index.js，请在项目根目录里执行这个脚本"

# ---------------------------------------------------------------- 包管理器
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
else die "认不出这个发行版。建议在控制台把系统重装成 Ubuntu 22.04，再跑这个脚本"
fi

pkg_install() {
  case "$PM" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" ;;
    dnf) dnf install -y "$@" ;;
    yum) yum install -y "$@" ;;
  esac
}

# ---------------------------------------------------------------- 1. 基础软件
say "安装基础软件（curl / tar / xz / openssl / nginx）"
if [ "$PM" = apt ]; then
  apt-get update -qq || warn "apt update 有报错，继续尝试"
fi
pkg_install curl ca-certificates tar xz-utils openssl nginx >/dev/null
ok "nginx $(nginx -v 2>&1 | sed 's/^nginx version: nginx\///')"

# ---------------------------------------------------------------- 2. Node.js
say "检查 Node.js（需要 >= 18，这里装 v${NODE_VERSION}）"
need_node=1
if command -v node >/dev/null 2>&1; then
  cur="$(node -v | sed 's/^v//')"
  if [ "${cur%%.*}" -ge 18 ] 2>/dev/null; then
    need_node=0
    ok "已有 node v${cur}，跳过安装"
  fi
fi
if [ "$need_node" = 1 ]; then
  case "$(uname -m)" in
    aarch64|arm64) arch=arm64 ;;
    *)             arch=x64   ;;
  esac
  tarball="node-v${NODE_VERSION}-linux-${arch}.tar.xz"
  tmp="$(mktemp -d)"
  got=0
  for base in "$NODE_MIRROR" "https://nodejs.org/dist"; do
    url="${base}/v${NODE_VERSION}/${tarball}"
    printf '    下载 %s\n' "$url"
    if curl -fL --retry 2 --connect-timeout 15 --max-time 600 -o "$tmp/$tarball" "$url"; then
      got=1; break
    fi
  done
  [ "$got" = 1 ] || die "Node 下载失败。可以先手动装好 Node 20（apt install nodejs 也行，只要 >= 18），再重跑本脚本"
  tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 \
      --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
  rm -rf "$tmp"
  hash -r
  ok "node $(node -v) / npm $(npm -v)"
fi

# ---------------------------------------------------------------- 3. 跑站点的用户
say "创建专用系统用户 ${APP_USER}（不用 root 跑网站）"
if id -u "$APP_USER" >/dev/null 2>&1; then
  ok "用户已存在"
else
  useradd --system --create-home --home-dir "/var/lib/${APP_USER}" --shell /usr/sbin/nologin "$APP_USER"
  ok "已创建"
fi

# ---------------------------------------------------------------- 4. 依赖
say "安装项目依赖（npm install --omit=dev）"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY"
ok "依赖就绪"

# ---------------------------------------------------------------- 5. .env
say "生成 .env"
if [ -z "$DOMAIN" ]; then SITE_URL="http://$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo 127.0.0.1)"
else SITE_URL="http://${DOMAIN}"; fi

ADMIN_PWD_NEW=""
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  SECRET="$(openssl rand -hex 32)"
  ADMIN_PWD_NEW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-14)"
  sed -i "s|^PORT=.*|PORT=${APP_PORT}|" .env
  sed -i "s|^SITE_URL=.*|SITE_URL=${SITE_URL}|" .env
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PWD_NEW}|" .env
  sed -i "s|^TRUST_PROXY=.*|TRUST_PROXY=1|" .env
  ok "新建 .env（后台密码已随机生成）"
else
  # 已存在：只补上没填的几项，别覆盖人家改过的
  grep -q '^SESSION_SECRET=..*' .env || sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env
  sed -i "s|^TRUST_PROXY=.*|TRUST_PROXY=1|" .env
  ok "沿用已有 .env（TRUST_PROXY 已设为 1）"
fi
chmod 600 .env

mkdir -p data uploads backups
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------------------------------------------------------------- 6. systemd
say "装 systemd 服务 ${SERVICE_NAME}"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Langfang No.1 High School Memoir Site
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}

Environment=NODE_ENV=production
Environment=PORT=${APP_PORT}
Environment=TRUST_PROXY=1
EnvironmentFile=${APP_DIR}/.env

ExecStart=$(command -v node) server/index.js

Restart=always
RestartSec=3
StartLimitBurst=5
StartLimitIntervalSec=300

StandardOutput=journal
StandardError=journal
SyslogIdentifier=memoir

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${APP_DIR}/data ${APP_DIR}/uploads ${APP_DIR}/backups
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "$SERVICE_NAME"
ok "已启动"

# ---------------------------------------------------------------- 7. nginx
say "配置 nginx 反向代理"
SERVER_NAME="${DOMAIN:-_}"
mkdir -p /etc/nginx/conf.d
cat > /etc/nginx/conf.d/memoir.conf <<'NGINXEOF'
# 廊坊一中回忆录 —— 由 deploy/lighthouse-install.sh 生成
limit_req_zone $binary_remote_addr zone=memoir_req:10m rate=20r/s;

upstream memoir_app {
    server 127.0.0.1:__APP_PORT__;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name __SERVER_NAME__;

    # 站长后台导入最大 2.5GB，这里必须 >= 应用上限
    client_max_body_size 2600m;
    client_body_timeout 600s;
    client_body_buffer_size 1m;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    # 静态资源 nginx 直出
    location /assets/ {
        root __APP_DIR__/public;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
        try_files $uri @app;
    }

    # 上传的照片（可能几百 MB，交给 nginx 送更快）
    location /uploads/ {
        root __APP_DIR__;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000";
        try_files $uri @app;
    }

    location @app {
        proxy_pass http://memoir_app;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        limit_req zone=memoir_req burst=40 nodelay;

        proxy_pass http://memoir_app;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "";
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
NGINXEOF

sed -i "s|__APP_PORT__|${APP_PORT}|g; s|__SERVER_NAME__|${SERVER_NAME}|g; s|__APP_DIR__|${APP_DIR}|g" \
  /etc/nginx/conf.d/memoir.conf

# Debian/Ubuntu 自带的 default 站点会抢 80 端口，先停掉
if [ -e /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
  ok "已移除 nginx 自带 default 站点"
fi

if ! nginx -t; then
  die "nginx 配置检查没过，看上面报错；改完再跑一次本脚本"
fi
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx 2>/dev/null || systemctl restart nginx
ok "nginx 已生效"

# SELinux 开着的话，nginx 默认不允许往外反代
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
  setsebool -P httpd_can_network_connect 1 >/dev/null 2>&1 || true
  ok "SELinux 已放行 nginx 反代"
fi

# 系统自带防火墙（云控制台的「防火墙」还要单独放行，见最后提示）
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  ok "firewalld 已放行 80/443"
fi

# ---------------------------------------------------------------- 8. 自检
say "自检"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${APP_PORT}/healthz" >/dev/null 2>&1; then
    healthy=1; break
  fi
  sleep 1
done

if [ "$healthy" = 1 ]; then
  ok "应用在 127.0.0.1:${APP_PORT} 正常响应"
else
  warn "应用没起来，执行下面这行看日志："
  printf '      journalctl -u %s -n 80 --no-pager\n' "$SERVICE_NAME"
fi

if curl -fsS --max-time 3 "http://127.0.0.1/" >/dev/null 2>&1; then
  ok "nginx 80 端口已转发成功"
else
  warn "nginx 80 端口没通（可能是云控制台防火墙还没放行 80）"
fi

# 后台密码：优先 .env 里的，没有就看自动生成的
ADMIN_SHOW=""
if [ -n "$ADMIN_PWD_NEW" ]; then
  ADMIN_SHOW="$ADMIN_PWD_NEW"
elif [ -f "$APP_DIR/data/.admin-password" ]; then
  ADMIN_SHOW="$(tr -d '\r\n' < "$APP_DIR/data/.admin-password")"
elif grep -q '^ADMIN_PASSWORD=..*' "$APP_DIR/.env"; then
  ADMIN_SHOW="$(grep '^ADMIN_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2-)"
fi

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '你的服务器公网IP')"

cat <<SUMMARY

============================================================
 部署完成
============================================================
 应用目录   ${APP_DIR}
 运行用户   ${APP_USER}（端口 ${APP_PORT}，只监听本机，外面走 nginx）
 对外地址   ${DOMAIN:+http://${DOMAIN}}${DOMAIN:-http://${PUBLIC_IP}（未配域名时用 IP:${APP_PORT} 先看）}
 后台入口   ${DOMAIN:+http://${DOMAIN}/admin}${DOMAIN:-http://${PUBLIC_IP}/admin}
 后台密码   ${ADMIN_SHOW:-见 ${APP_DIR}/data/.admin-password}

 服务命令
   systemctl status ${SERVICE_NAME}
   systemctl restart ${SERVICE_NAME}
   journalctl -u ${SERVICE_NAME} -f

 ⚠ 还差两步（在腾讯云控制台点几下）
   1) 轻量应用服务器 → 防火墙 → 放行 TCP 80、443（备案没下来前再加一个 3000 方便测试）
   2) 有域名的话：域名解析 A 记录指向 ${PUBLIC_IP}，并且在腾讯云做 ICP 备案

 备份（建议加进 crontab，每天凌晨 3 点）
   0 3 * * * cd ${APP_DIR} && /usr/bin/node scripts/backup.js --keep=14

 HTTPS（域名解析生效、且备案通过后）
   apt install -y certbot python3-certbot-nginx
   certbot --nginx -d ${DOMAIN:-你的域名}
   然后把 .env 里 SITE_URL 改成 https://${DOMAIN:-你的域名} 再 systemctl restart ${SERVICE_NAME}
============================================================
SUMMARY
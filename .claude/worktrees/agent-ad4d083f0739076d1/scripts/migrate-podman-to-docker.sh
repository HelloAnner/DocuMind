#!/usr/bin/env bash
# 一次性迁移：把 Documind 中间件从 podman 迁到真 Docker CE + docker compose。
#
# 背景：Alibaba Cloud Linux 3 默认装 podman-docker，/usr/bin/docker 只是转调 podman 的
# 脚本，且没有任何 compose provider，`docker compose` 直接失败(exit 125)。四套系统要统一
# 用 docker compose 管中间件，这台必须先换成真 Docker。
#
# 重要：本机上 docker-ce 与 podman 互斥（docker-ce -> containerd.io 与发行版 runc 冲突，
# 而 podman 依赖 runc）。所以迁移会连带移除 podman，服务器的容器构建管线也随之切到 Docker。
# 这是刻意的，不是副作用。
#
# 数据安全：五个容器的数据全部是宿主 bind mount(/opt/documind/shared/*)，切运行时不动数据；
# 迁移前另做 pg_dump 逻辑备份。回滚 = 重装 podman（见 --rollback）。
#
# 用法(在服务器上，root)：
#   bash migrate-podman-to-docker.sh            # 执行迁移
#   bash migrate-podman-to-docker.sh --rollback # 回滚：重装 podman 并启回旧容器

set -euo pipefail

BASE=/opt/documind
SHARED="$BASE/shared"
COMPOSE_ENV="$SHARED/compose.env"
BACKUP_DIR="$SHARED/backups/podman-to-docker-$(date -u +%Y%m%dT%H%M%SZ)"
CONTAINERS=(documind-postgres documind-redis documind-rabbitmq documind-elasticsearch documind-minio)
COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/compose.yaml"

# 必须与 deploy/compose.yaml 里的镜像默认值逐字一致。
# 这些镜像要从本地 podman 存储搬到 Docker 存储，不能依赖镜像仓库 —— MinIO 已从
# Docker Hub 下架，quay 拒绝匿名拉取，各国内镜像站也返回 denied（2026-10 实测）。
IMAGES=(
  "m.daocloud.io/docker.io/library/postgres:16-alpine"
  "m.daocloud.io/docker.io/library/redis:7-alpine"
  "m.daocloud.io/docker.io/library/rabbitmq:3-management-alpine"
  "m.daocloud.io/docker.elastic.co/elasticsearch/elasticsearch:8.14.3"
  "m.daocloud.io/docker.io/minio/minio:RELEASE.2024-07-16T23-46-41Z"
  "m.daocloud.io/docker.io/minio/mc:latest"
)

log() { printf '[migrate] %s\n' "$*"; }
die() { printf '[migrate] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "必须用 root 运行"

# ---------------------------------------------------------------- 回滚
if [[ "${1:-}" == "--rollback" ]]; then
  log "回滚：停 Docker 栈，重装 podman，恢复旧容器"
  if [[ -f "$COMPOSE_ENV" && -f "$COMPOSE_FILE" ]]; then
    docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" stop || true
  fi
  # 重装 podman 会把 docker-ce 顶掉（二者互斥），这是预期行为
  dnf install -y --allowerasing podman podman-docker
  for c in "${CONTAINERS[@]}"; do
    if podman container exists "$c" 2>/dev/null; then
      podman start "$c" >/dev/null && log "已启动 $c"
    fi
  done
  log "回滚完成。旧容器定义在 /var/lib/containers 里未被删除。"
  exit 0
fi

# ---------------------------------------------------------------- 预检
log "预检"
[[ -f "$COMPOSE_FILE" ]] || die "找不到 compose.yaml: $COMPOSE_FILE"
[[ -f "$SHARED/.env" ]] || die "找不到 $SHARED/.env"

selinux="$(getenforce 2>/dev/null || echo Disabled)"
[[ "$selinux" == "Disabled" ]] || die "SELinux 是 $selinux，bind mount 需要额外打标签，先人工处理"

for c in "${CONTAINERS[@]}"; do
  podman container exists "$c" 2>/dev/null || die "podman 容器不存在: $c"
done
log "五个 podman 容器都在"

avail_kb="$(df -Pk / | awk 'NR==2{print $4}')"
(( avail_kb > 8 * 1024 * 1024 )) || die "根分区可用空间不足 8G（当前 $(( avail_kb / 1024 ))M）"
log "磁盘可用 $(( avail_kb / 1024 / 1024 ))G"

# ---------------------------------------------------------------- 备份（必须在 podman 还在时做完）
log "备份到 $BACKUP_DIR"
install -d -m 700 "$BACKUP_DIR"
cp -a "$SHARED/.env" "$BACKUP_DIR/documind.env"
for c in "${CONTAINERS[@]}"; do
  podman inspect "$c" > "$BACKUP_DIR/$c.inspect.json" 2>/dev/null || true
done

log "pg_dump"
podman exec documind-postgres pg_dump -U documind -d documind_dev --format=custom \
  > "$BACKUP_DIR/documind_dev.dump" 2>/dev/null \
  || die "pg_dump 失败，停止迁移"
[[ -s "$BACKUP_DIR/documind_dev.dump" ]] || die "pg_dump 产物为空，停止迁移"
log "pg_dump 完成 $(du -h "$BACKUP_DIR/documind_dev.dump" | cut -f1)"

# 从正在运行的容器里取真实凭据，保证与 DATABASE_URL / OBJECT_STORAGE_* 完全一致。
log "生成 $COMPOSE_ENV"
if [[ -f "$COMPOSE_ENV" ]]; then
  log "compose.env 已存在，保留不覆盖"
else
  pg_env="$(podman inspect documind-postgres --format '{{range .Config.Env}}{{println .}}{{end}}')"
  minio_env="$(podman inspect documind-minio --format '{{range .Config.Env}}{{println .}}{{end}}')"
  es_env="$(podman inspect documind-elasticsearch --format '{{range .Config.Env}}{{println .}}{{end}}')"

  pg_user="$(printf '%s\n' "$pg_env" | sed -n 's/^POSTGRES_USER=//p' | tail -1)"
  pg_pass="$(printf '%s\n' "$pg_env" | sed -n 's/^POSTGRES_PASSWORD=//p' | tail -1)"
  pg_db="$(printf '%s\n' "$pg_env" | sed -n 's/^POSTGRES_DB=//p' | tail -1)"
  minio_user="$(printf '%s\n' "$minio_env" | sed -n 's/^MINIO_ROOT_USER=//p' | tail -1)"
  minio_pass="$(printf '%s\n' "$minio_env" | sed -n 's/^MINIO_ROOT_PASSWORD=//p' | tail -1)"
  es_opts="$(printf '%s\n' "$es_env" | sed -n 's/^ES_JAVA_OPTS=//p' | tail -1)"
  bucket="$(sed -n 's/^OBJECT_STORAGE_BUCKET=//p' "$SHARED/.env" | tail -1)"

  for pair in "POSTGRES_USER:$pg_user" "POSTGRES_PASSWORD:$pg_pass" "POSTGRES_DB:$pg_db" \
              "MINIO_ROOT_USER:$minio_user" "MINIO_ROOT_PASSWORD:$minio_pass"; do
    [[ -n "${pair#*:}" ]] || die "从容器里取不到 ${pair%%:*}，停止迁移"
  done

  install -m 600 /dev/null "$COMPOSE_ENV"
  cat > "$COMPOSE_ENV" <<EOF
# 由 scripts/migrate-podman-to-docker.sh 从运行中的容器提取，勿提交到 git。
POSTGRES_USER=$pg_user
POSTGRES_PASSWORD=$pg_pass
POSTGRES_DB=$pg_db
MINIO_ROOT_USER=$minio_user
MINIO_ROOT_PASSWORD=$minio_pass
OBJECT_STORAGE_BUCKET=${bucket:-documind}
ES_JAVA_OPTS=${es_opts:--Xms512m -Xmx512m}
EOF
  log "compose.env 生成完毕（0600）"
fi

# ---------------------------------------------------------------- 导出镜像
# 必须在 podman 还在时做：MinIO 镜像已无法从任何仓库拉取，只能从本地存储搬。
log "导出镜像到 $BACKUP_DIR/images"
install -d -m 700 "$BACKUP_DIR/images"
for img in "${IMAGES[@]}"; do
  tar_name="$BACKUP_DIR/images/$(printf '%s' "$img" | tr '/:' '__').tar"
  if podman image exists "$img" 2>/dev/null; then
    podman save -o "$tar_name" "$img" || die "podman save 失败: $img"
    log "  已导出 $img ($(du -h "$tar_name" | cut -f1))"
  else
    # 本地没有的镜像只能靠仓库，记下来，装完 Docker 后尝试拉取
    log "  本地没有 $img，装完 Docker 后走仓库拉取"
  fi
done

# ---------------------------------------------------------------- 停旧容器
# 从这里开始服务不可用，任何失败都要自动回滚，不能把服务挂在半路等人工处理。
auto_rollback() {
  log "步骤失败，自动回滚到 podman（服务恢复中）"
  dnf install -y --allowerasing podman podman-docker >/dev/null 2>&1 || true
  for c in "${CONTAINERS[@]}"; do
    podman start "$c" >/dev/null 2>&1 || true
  done
  log "已回滚。容器状态："
  podman ps --format '  {{.Names}}\t{{.Status}}' 2>/dev/null || true
  log "请检查上面的报错后重试。备份在 $BACKUP_DIR"
}
trap 'auto_rollback' ERR

log "优雅停止 podman 容器"
for c in "${CONTAINERS[@]}"; do
  podman stop -t 30 "$c" >/dev/null 2>&1 || true
  log "  已停止 $c"
done

# ---------------------------------------------------------------- 装 Docker CE
# --allowerasing：docker-ce -> containerd.io 与发行版 runc 冲突，而 podman 依赖 runc，
# dnf 会连带移除 podman 及其依赖。这是本机唯一可行的组合，属预期行为。
log "安装 Docker CE（会连带移除 podman）"
dnf install -y dnf-plugins-core >/dev/null
dnf config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo >/dev/null
sed -i 's/\$releasever/8/g' /etc/yum.repos.d/docker-ce.repo
dnf install -y --allowerasing \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker >/dev/null
docker info >/dev/null 2>&1 || die "docker 守护进程没起来。回滚：bash $0 --rollback"

docker_version="$(docker --version 2>&1)"
[[ "$docker_version" != *podman* ]] || die "docker 仍然指向 podman 壳：$docker_version"
docker compose version >/dev/null 2>&1 || die "docker compose 不可用"
log "$docker_version / compose $(docker compose version --short)"

# ---------------------------------------------------------------- 导入镜像
# 把 podman 存储里导出的镜像装回 Docker，避免 compose 去仓库拉（minio 拉不到）。
log "导入镜像到 Docker"
for img in "${IMAGES[@]}"; do
  tar_name="$BACKUP_DIR/images/$(printf '%s' "$img" | tr '/:' '__').tar"
  if [[ -f "$tar_name" ]]; then
    docker load -i "$tar_name" >/dev/null || die "docker load 失败: $img"
    docker image inspect "$img" >/dev/null 2>&1 || die "导入后仍找不到镜像: $img"
    log "  已导入 $img"
  else
    log "  本地无 tar，尝试从仓库拉取 $img"
    docker pull "$img" || die "镜像既不在本地也拉不到: $img"
  fi
done

# ---------------------------------------------------------------- 启动
log "启动 Docker compose 栈"
docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" up -d

log "等待健康检查"
deadline=$(( SECONDS + 300 ))
for c in "${CONTAINERS[@]}"; do
  while (( SECONDS < deadline )); do
    state="$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo missing)"
    [[ "$state" == "healthy" || "$state" == "none" ]] && break
    sleep 3
  done
  printf '[migrate]   %-24s %s\n' "$c" \
    "$(docker inspect "$c" --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo missing)"
done

log "确保 bucket 存在"
docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" --profile init up minio-init

# ---------------------------------------------------------------- 验收
log "验收"
fail=0
docker exec documind-postgres pg_isready -U documind -d documind_dev >/dev/null || { log "postgres 不通"; fail=1; }
docker exec documind-redis redis-cli ping >/dev/null || { log "redis 不通"; fail=1; }
docker exec documind-rabbitmq rabbitmq-diagnostics -q ping >/dev/null || { log "rabbitmq 不通"; fail=1; }
curl -fsS http://127.0.0.1:8104/_cluster/health >/dev/null || { log "elasticsearch 不通"; fail=1; }
curl -fsS http://127.0.0.1:9010/minio/health/live >/dev/null || { log "minio 不通"; fail=1; }

tables="$(docker exec documind-postgres psql -XqAt -U documind -d documind_dev -c \
  "select count(*) from information_schema.tables where table_schema='documind'" 2>/dev/null || echo 0)"
log "documind schema 表数量: $tables"
(( tables > 0 )) || { log "数据库里没有 documind schema 的表"; fail=1; }

# ES 索引与 MinIO bucket 也核对一下，确认数据真的挂上了
indices="$(curl -fsS http://127.0.0.1:8104/_cat/indices?h=index 2>/dev/null | wc -l)"
log "elasticsearch 索引数量: $indices"
(( indices > 0 )) || { log "elasticsearch 里没有索引"; fail=1; }

buckets="$(docker exec documind-minio sh -c 'ls /data' 2>/dev/null | tr '\n' ' ')"
log "minio 数据目录: $buckets"
[[ "$buckets" == *documind* ]] || { log "minio 里找不到 documind bucket"; fail=1; }

if (( fail != 0 )); then
  log "验收失败，触发自动回滚"
  auto_rollback
  exit 1
fi

# 验收通过，解除自动回滚
trap - ERR

log "迁移完成。备份在 $BACKUP_DIR"
log "接下来：确认 Documind 应用侧健康（8089），再跑一次服务器构建验证 Docker 构建链路。"

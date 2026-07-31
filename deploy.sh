#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly ENV_FILE="${PROJECT_ROOT}/.env"
readonly COMPOSE_FILE="${PROJECT_ROOT}/compose.yaml"

log() {
	printf '[YeMu Docker] %s\n' "$*"
}

warn() {
	printf '[YeMu Docker] 警告：%s\n' "$*" >&2
}

die() {
	printf '[YeMu Docker] 错误：%s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
用法：./deploy.sh <命令>

命令：
  start       初始化配置、构建镜像并启动全部服务（默认）
  restart     重新构建并重建服务
  stop        停止服务，但保留容器和数据卷
  down        删除容器和网络，但保留数据卷
  status      查看容器与健康状态
  logs        持续查看 Web 和 Worker 日志
  build       只构建应用镜像
  check       检查 Docker、环境变量与 Compose 配置
  help        显示帮助

首次启动示例：
  YEMU_PUBLIC_URL=https://novel.example.com ./deploy.sh start

默认只把 8787 端口绑定到服务器的 127.0.0.1，供 Caddy/Nginx 反向代理。
如需直接暴露端口，可在 .env 设置 YEMU_BIND_ADDRESS=0.0.0.0。
EOF
}

ensure_docker() {
	command -v docker >/dev/null 2>&1 || die "没有找到 Docker。请先安装 Docker Engine 与 Compose 插件。"
	docker compose version >/dev/null 2>&1 || die "没有找到 docker compose 插件。"
	docker info >/dev/null 2>&1 || die "无法连接 Docker daemon，请检查服务状态和当前用户权限。"
}

file_config_value() {
	local key="$1"
	[[ -f "${ENV_FILE}" ]] || return 0
	awk -v wanted="${key}" '
		$0 ~ "^[[:space:]]*" wanted "=" {
			line = $0
			sub("^[[:space:]]*" wanted "=", "", line)
			sub(/\r$/, "", line)
			print line
			exit
		}
	' "${ENV_FILE}"
}

trim_quotes() {
	local value="$1"
	if [[ ${#value} -ge 2 ]]; then
		if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
			printf '%s' "${value:1:${#value}-2}"
			return
		fi
		if [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
			printf '%s' "${value:1:${#value}-2}"
			return
		fi
	fi
	printf '%s' "${value}"
}

config_value() {
	local key="$1"
	local value
	if [[ -v "${key}" ]]; then
		value="${!key}"
	else
		value="$(file_config_value "${key}")"
	fi
	trim_quotes "${value}"
}

set_file_config() {
	local key="$1"
	local value="$2"
	local temporary
	temporary="$(mktemp "${PROJECT_ROOT}/.env.XXXXXX")"
	awk -v wanted="${key}" -v replacement="${key}=${value}" '
		BEGIN { replaced = 0 }
		$0 ~ "^[[:space:]]*" wanted "=" {
			if (!replaced) print replacement
			replaced = 1
			next
		}
		{ print }
		END {
			if (!replaced) print replacement
		}
	' "${ENV_FILE}" >"${temporary}"
	mv -- "${temporary}" "${ENV_FILE}"
	chmod 600 -- "${ENV_FILE}"
}

random_secret() {
	od -An -N48 -tx1 /dev/urandom | tr -d ' \n'
}

ensure_environment_file() {
	local created="false"
	if [[ ! -f "${ENV_FILE}" ]]; then
		cp -- "${PROJECT_ROOT}/.env.example" "${ENV_FILE}"
		chmod 600 -- "${ENV_FILE}"
		created="true"
		log "已从 .env.example 创建 .env"
	fi

	if [[ -n "${YEMU_PUBLIC_URL:-}" ]]; then
		if [[ ! "${YEMU_PUBLIC_URL}" =~ ^https?://[^[:space:]]+$ ]]; then
			die "YEMU_PUBLIC_URL 必须是完整的 http:// 或 https:// 地址。"
		fi
		set_file_config "YEMU_PUBLIC_URL" "${YEMU_PUBLIC_URL%/}"
	fi

	local auth_secret postgres_password
	auth_secret="$(config_value "AUTH_SECRET")"
	postgres_password="$(config_value "POSTGRES_PASSWORD")"
	if [[ ${#auth_secret} -lt 32 || "${auth_secret}" == replace-* ]]; then
		set_file_config "AUTH_SECRET" "$(random_secret)"
		log "已生成 AUTH_SECRET"
	fi
	if [[ ${#postgres_password} -lt 24 || "${postgres_password}" == replace-* ]]; then
		set_file_config "POSTGRES_PASSWORD" "$(random_secret)"
		log "已生成 PostgreSQL 密码"
	fi

	if [[ "${created}" == "true" ]]; then
		set_file_config "DOCKER_REGISTRATION_MODE" "closed"
		warn "首次启动默认关闭注册。配置 Resend 后可改为 owner-only 或 open。"
	fi
}

validate_environment() {
	local public_url registration_mode email_provider resend_key email_from
	public_url="$(config_value "YEMU_PUBLIC_URL")"
	registration_mode="$(config_value "DOCKER_REGISTRATION_MODE")"
	registration_mode="${registration_mode:-closed}"
	email_provider="$(config_value "EMAIL_PROVIDER")"
	email_provider="${email_provider:-disabled}"
	resend_key="$(config_value "RESEND_API_KEY")"
	email_from="$(config_value "EMAIL_FROM")"

	if [[ ! "${public_url}" =~ ^https?://[^[:space:]]+$ ]]; then
		die "请在 .env 中设置完整的 YEMU_PUBLIC_URL，例如 https://novel.example.com。"
	fi

	case "${registration_mode}" in
		open | owner-only | closed) ;;
		*) die "DOCKER_REGISTRATION_MODE 只能是 open、owner-only 或 closed。" ;;
	esac

	if [[ "${registration_mode}" != "closed" ]]; then
		if [[ "${email_provider}" != "resend" || -z "${resend_key}" || -z "${email_from}" ]]; then
			die "Docker 生产环境允许注册时必须配置 EMAIL_PROVIDER=resend、RESEND_API_KEY 和 EMAIL_FROM。"
		fi
	fi

	if [[ "${public_url}" == http://127.0.0.1:* || "${public_url}" == http://localhost:* ]]; then
		warn "当前是本机地址；公网部署请把 YEMU_PUBLIC_URL 改成 HTTPS 域名。"
	fi
}

compose() {
	docker compose --project-directory "${PROJECT_ROOT}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

check_configuration() {
	ensure_docker
	ensure_environment_file
	validate_environment
	compose config --quiet
	log "Docker 与 Compose 配置检查通过。"
}

start_services() {
	check_configuration
	log "构建并启动 Web、PostgreSQL、Redis 和 Worker…"
	compose up --detach --build --wait
	compose ps
	local bind_address published_port
	bind_address="$(config_value "YEMU_BIND_ADDRESS")"
	published_port="$(config_value "YEMU_PORT")"
	log "服务已启动：$(config_value "YEMU_PUBLIC_URL")"
	log "宿主机监听：${bind_address:-127.0.0.1}:${published_port:-8787}"
}

restart_services() {
	check_configuration
	log "重新构建并重建服务…"
	compose up --detach --build --force-recreate --wait
	compose ps
}

main() {
	cd -- "${PROJECT_ROOT}"
	case "${1:-start}" in
		start)
			start_services
			;;
		restart)
			restart_services
			;;
		stop)
			ensure_docker
			compose stop
			;;
		down)
			ensure_docker
			compose down
			;;
		status)
			ensure_docker
			compose ps
			;;
		logs)
			ensure_docker
			compose logs --follow --tail=150 web worker
			;;
		build)
			check_configuration
			compose build
			;;
		check)
			check_configuration
			;;
		help | --help | -h)
			usage
			;;
		*)
			usage >&2
			die "未知命令：${1}"
			;;
	esac
}

main "$@"

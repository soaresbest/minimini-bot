#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AUTO_YES=0
NO_START=0
TEMP_DIR=""

usage() {
  cat <<'USAGE'
Minimini Bot — instalação para Linux/macOS
Uso: bash install.sh [--yes] [--no-start]
  --yes       Aceita as etapas automaticamente (a configuração do bot continua interativa).
  --no-start  Prepara o ambiente sem iniciar o bot.
Baixe e extraia primeiro o ZIP completo do projeto. Não é necessário instalar Git.
USAGE
}

for argument in "$@"; do
  case "$argument" in
    --yes|-y) AUTO_YES=1 ;;
    --no-start) NO_START=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Opção desconhecida: %s\n' "$argument" >&2; usage; exit 2 ;;
  esac
done

fail() { printf '\nErro: %s\n' "$*" >&2; exit 1; }
confirm() {
  local answer
  printf '\n%s\n' "$1"
  if [[ "$AUTO_YES" == 1 ]]; then
    printf 'Confirmado automaticamente por --yes.\n'
    return 0
  fi
  printf 'Continuar? [S/n] '
  if ! IFS= read -r answer; then
    fail 'Não foi possível ler sua resposta. Use um terminal interativo ou --yes --no-start.'
  fi
  case "$answer" in
    ''|s|S|sim|Sim|SIM|y|Y|yes) return 0 ;;
    *) printf 'Etapa recusada. Você pode executar o instalador novamente depois.\n'; return 1 ;;
  esac
}
cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then rm -rf -- "$TEMP_DIR"; fi
}
trap cleanup EXIT
trap 'printf "\nInstalação interrompida.\n" >&2; exit 130' INT TERM
trap 'printf "\nA instalação falhou. Consulte a mensagem acima, corrija o problema e execute novamente.\n" >&2' ERR

[[ -f "$PROJECT_DIR/package.json" && -f "$PROJECT_DIR/package-lock.json" && -f "$PROJECT_DIR/scripts/runtime.sh" ]] ||
  fail 'Extraia o ZIP completo do projeto antes de executar install.sh (package.json e package-lock.json são obrigatórios).'
# shellcheck source=scripts/runtime.sh
source "$PROJECT_DIR/scripts/runtime.sh"

confirm "Etapa 1/4 — verificar o sistema e as ferramentas. Projeto: $PROJECT_DIR" || exit 0
OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"
case "$OS_NAME" in
  Darwin)
    PLATFORM=darwin
    MAC_VERSION="$(sw_vers -productVersion)"
    MAC_MAJOR="${MAC_VERSION%%.*}"
    MAC_REMAINDER="${MAC_VERSION#*.}"
    MAC_MINOR="${MAC_REMAINDER%%.*}"
    if (( MAC_MAJOR < 13 || (MAC_MAJOR == 13 && MAC_MINOR < 5) )); then
      fail "O Node.js 24 oficial exige macOS 13.5 ou superior (encontrado $MAC_VERSION)."
    fi
    ;;
  Linux)
    PLATFORM=linux
    if ! command -v getconf >/dev/null 2>&1 || ! GLIBC_INFO="$(getconf GNU_LIBC_VERSION 2>/dev/null)"; then
      fail 'Este instalador exige Linux com glibc >= 2.28. Alpine/musl não possui binário oficial compatível do Node.js 24.'
    fi
    GLIBC_VERSION="${GLIBC_INFO##* }"
    GLIBC_MAJOR="${GLIBC_VERSION%%.*}"
    GLIBC_MINOR="${GLIBC_VERSION#*.}"
    GLIBC_MINOR="${GLIBC_MINOR%%.*}"
    if (( GLIBC_MAJOR < 2 || (GLIBC_MAJOR == 2 && GLIBC_MINOR < 28) )); then
      fail "A glibc $GLIBC_VERSION é antiga. Use uma distribuição com glibc >= 2.28."
    fi
    ;;
  *) fail "Sistema $OS_NAME não suportado por install.sh. No Windows, use install.cmd." ;;
esac
case "$ARCH_NAME" in
  x86_64|amd64) NODE_ARCH=x64 ;;
  arm64|aarch64) NODE_ARCH=arm64 ;;
  *) fail "Arquitetura $ARCH_NAME não suportada por este instalador; use x64 ou arm64." ;;
esac
printf 'Sistema detectado: %s / %s.\n' "$PLATFORM" "$NODE_ARCH"

# Linux mínimo pode não trazer as ferramentas de download e extração.
MISSING_TOOLS=0
for tool in tar gzip mktemp awk; do
  command -v "$tool" >/dev/null 2>&1 || MISSING_TOOLS=1
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then MISSING_TOOLS=1; fi
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then MISSING_TOOLS=1; fi
install_system_dependencies() {
  [[ "$PLATFORM" == linux ]] || fail 'As ferramentas padrão do macOS (curl, tar, gzip, shasum, mktemp e awk) não estão disponíveis. Restaure-as antes de continuar.'
  UPDATE_REQUIRED=0
  UPDATE_DESCRIPTION=''
  if command -v apt-get >/dev/null 2>&1; then
    UPDATE_REQUIRED=1
    UPDATE_DESCRIPTION='apt-get update e '
    INSTALL_COMMAND=(apt-get install -y ca-certificates curl tar gzip coreutils gawk libstdc++6)
  elif command -v dnf >/dev/null 2>&1; then
    INSTALL_COMMAND=(dnf install -y ca-certificates curl tar gzip coreutils gawk libstdc++)
  elif command -v yum >/dev/null 2>&1; then
    INSTALL_COMMAND=(yum install -y ca-certificates curl tar gzip coreutils gawk libstdc++)
  elif command -v zypper >/dev/null 2>&1; then
    INSTALL_COMMAND=(zypper --non-interactive install ca-certificates curl tar gzip coreutils gawk libstdc++6)
  elif command -v pacman >/dev/null 2>&1; then
    INSTALL_COMMAND=(pacman -S --needed --noconfirm ca-certificates curl tar gzip coreutils gawk gcc-libs)
  else
    fail 'Instale ca-certificates, curl (ou wget), tar, gzip, coreutils, awk e libstdc++ pelo gerenciador da sua distribuição e execute novamente.'
  fi
  confirm "São necessárias ferramentas/bibliotecas do sistema. Vou executar: $UPDATE_DESCRIPTION${INSTALL_COMMAND[*]}. Esta etapa pode solicitar a senha de administrador." || exit 0
  if [[ "$(id -u)" != 0 ]]; then
    command -v sudo >/dev/null 2>&1 || fail 'O sistema precisa de dependências, mas sudo não está disponível. Peça ao administrador para instalar os pacotes listados e execute novamente como seu usuário.'
  fi
  run_admin() {
    if [[ "$(id -u)" == 0 ]]; then "$@"; else sudo "$@"; fi
  }
  if [[ "$UPDATE_REQUIRED" == 1 ]]; then run_admin apt-get update; fi
  run_admin "${INSTALL_COMMAND[@]}"
}
if [[ "$MISSING_TOOLS" == 1 ]]; then install_system_dependencies; fi

download() {
  printf 'Baixando %s\n' "$1"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 20 --output "$2" "$1"
  else
    wget --https-only --tries=3 --timeout=30 --output-document="$2" "$1"
  fi
}

NODE_FILE="$(minimini_find_node || true)"
if [[ -n "$NODE_FILE" ]]; then
  confirm "Etapa 2/4 — reutilizar Node.js $("$NODE_FILE" --version) de $NODE_FILE." || exit 0
else
  NODE_DEST="$HOME/.minimini-bot/runtime/node"
  confirm "Etapa 2/4 — baixar Node.js 24 oficial, conferir SHA-256 e instalar em $NODE_DEST. O Node de outros projetos continuará disponível." || exit 0
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/minimini-install.XXXXXXXX")"
  download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' "$TEMP_DIR/SHASUMS256.txt"
  ARCHIVE_NAME="$(awk -v suffix="-$PLATFORM-$NODE_ARCH.tar.gz" '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-/ && substr($2,length($2)-length(suffix)+1)==suffix { print $2; exit }' "$TEMP_DIR/SHASUMS256.txt")"
  [[ "$ARCHIVE_NAME" =~ ^node-v24\.[0-9]+\.[0-9]+-(darwin|linux)-(x64|arm64)\.tar\.gz$ ]] || fail 'Não foi possível localizar um pacote Node.js 24 para este sistema.'
  NODE_VERSION="${ARCHIVE_NAME#node-}"
  NODE_VERSION="${NODE_VERSION%%-$PLATFORM-*}"
  EXPECTED_HASH="$(awk -v name="$ARCHIVE_NAME" '$2 == name { print $1; exit }' "$TEMP_DIR/SHASUMS256.txt")"
  download "https://nodejs.org/dist/$NODE_VERSION/$ARCHIVE_NAME" "$TEMP_DIR/$ARCHIVE_NAME"
  printf 'Conferindo SHA-256 do arquivo baixado...\n'
  minimini_verify_checksum "$TEMP_DIR/$ARCHIVE_NAME" "$EXPECTED_HASH" || fail 'SHA-256 incorreto; o arquivo baixado não será utilizado. Execute novamente.'
  tar -xzf "$TEMP_DIR/$ARCHIVE_NAME" -C "$TEMP_DIR"
  EXTRACTED_DIR="$TEMP_DIR/${ARCHIVE_NAME%.tar.gz}"
  if ! minimini_node24 "$EXTRACTED_DIR/bin/node"; then
    if [[ "$PLATFORM" == linux ]]; then
      printf 'O Node.js baixado ainda não executou. Vou verificar as bibliotecas do sistema.\n'
      install_system_dependencies
    fi
    minimini_node24 "$EXTRACTED_DIR/bin/node" || fail 'O Node.js baixado não executou. No Linux, verifique kernel >= 4.18 e libstdc++ >= 6.0.25; veja docs/installation.md.'
  fi
  [[ -f "$EXTRACTED_DIR/bin/npm" ]] || fail 'O pacote baixado não contém npm.'
  mkdir -p "$(dirname "$NODE_DEST")"
  if [[ -e "$NODE_DEST" ]]; then
    NODE_BACKUP="$NODE_DEST.backup-$(date +%Y%m%d%H%M%S)-$$"
    mv -- "$NODE_DEST" "$NODE_BACKUP"
    printf 'Runtime anterior preservado em %s.\n' "$NODE_BACKUP"
  fi
  mv -- "$EXTRACTED_DIR" "$NODE_DEST"
  NODE_FILE="$NODE_DEST/bin/node"
fi
export PATH="$(dirname "$NODE_FILE"):$PATH"
printf 'Node.js: %s | npm: %s\n' "$("$NODE_FILE" --version)" "$(npm --version)"

confirm 'Etapa 3/4 — instalar as dependências exatas do package-lock.json com npm ci (a pasta node_modules será recriada).' || exit 0
cd -- "$PROJECT_DIR"
npm ci --no-fund --no-audit
printf 'Dependências instaladas.\n'
if [[ "$NO_START" == 1 ]]; then
  printf '\nEtapa 4/4 — inicialização adiada por --no-start.\nInicie quando quiser com: bash "%s/start.sh"\n' "$PROJECT_DIR"
else
  if confirm 'Etapa 4/4 — iniciar o Minimini Bot. Na primeira execução, o terminal solicitará o servidor, nome do bot e demais configurações.'; then
    bash "$PROJECT_DIR/start.sh"
  else
    printf 'Ambiente pronto. Inicie com: bash "%s/start.sh"\n' "$PROJECT_DIR"
  fi
fi

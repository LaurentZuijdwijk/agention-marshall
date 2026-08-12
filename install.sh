#!/bin/sh
#
# Marshall installer — curl -fsSL https://marshall.agention.ai/install.sh | sh
#
# Package / command to install:
MR_PACKAGE="@agentionai/marshall-cli"
MR_CMD="marshall"
MR_REQUIRED_NODE_MAJOR=22
MR_ESC=$(printf '\033')
MR_CR=$(printf '\r')
MR_ETX=$(printf '\003')
readonly MR_PACKAGE MR_CMD MR_REQUIRED_NODE_MAJOR MR_ESC MR_CR MR_ETX

mr_installer_main() {
  set -eu

  check_file="${TMPDIR:-/tmp}/marshall-installer-checks.$$"
  run_preflight_checks >"$check_file" &
  check_pid=$!

  mr_logo_animation

  if wait "$check_pid"; then
    check_status=0
  else
    check_status=$?
  fi

  printf '\033[1m  Marshall Installer\033[0m\n\033[2m  A coding agent that does not pretend to be your keyboard\033[0m\n\n'
  if [ "$check_status" -eq 0 ]; then
    cat "$check_file"
  fi
  rm -f "$check_file"

  if [ "$check_status" -ne 0 ]; then
    if ! install_node_npm_interactive; then
      exit "$check_status"
    fi

    check_file="${TMPDIR:-/tmp}/marshall-installer-checks.$$"
    if run_preflight_checks >"$check_file"; then
      check_status=0
    else
      check_status=$?
    fi
    cat "$check_file"
    rm -f "$check_file"

    if [ "$check_status" -ne 0 ]; then
      exit "$check_status"
    fi
  fi

  MR_EXISTING_PATH=$(command -v "$MR_CMD" 2>/dev/null || true)
  export MR_EXISTING_PATH

  if ! MR_NPM_INSTALL_PREFIX=$(select_npm_install_prefix); then
    exit 1
  fi
  export MR_NPM_INSTALL_PREFIX

  MR_NPM_UNINSTALL_PREFIX=$(select_npm_uninstall_prefix "$MR_EXISTING_PATH")
  export MR_NPM_UNINSTALL_PREFIX

  choose_mr_action "$MR_EXISTING_PATH"
  case "$MR_INSTALL_ACTION" in
    uninstall)
      uninstall_mr_package
      printf '\nMarshall was uninstalled successfully.\n'
      exit 0
      ;;
    none)
      exit 0
      ;;
  esac

  install_mr_package
  if [ "$MR_INSTALL_ACTION" = reinstall ]; then
    printf '\nMarshall was reinstalled successfully.\n'
  else
    printf '\nMarshall was installed successfully.\n'
  fi
  if installed_mr_is_first_on_path; then
    printf '\nRun it with: marshall\n'
    if [ "${MR_NODE_INSTALLED_STANDALONE:-0}" = 1 ]; then
      printf 'If marshall is not found in your shell yet, add this to your shell profile:\n\n'
      printf '  export PATH="%s:$PATH"\n' "$MR_STANDALONE_NODE_BIN"
    fi
  else
    print_mr_not_on_path_message
  fi
}

run_preflight_checks() {
  status=0

  if command -v node >/dev/null 2>&1; then
    node_version=$(node --version)
    if ! node -e 'const maj = Number(process.versions.node.split(".")[0]); process.exit(maj >= 22 ? 0 : 1)' >/dev/null; then
      printf 'error: Marshall requires Node.js 22 or newer. Found %s.\n' "$node_version"
      status=1
    fi
  else
    printf 'error: Node.js 22 or newer is required to install Marshall.\n'
    status=1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    printf 'error: npm is required to install Marshall.\n'
    status=1
  fi

  if [ "$status" -ne 0 ]; then
    printf '\n'
  fi

  return "$status"
}

install_node_npm_interactive() {
  method=$(detect_node_install_method)
  case "$method" in
    homebrew) label="Homebrew" ;;
    apt) label="apt" ;;
    apk) label="apk" ;;
    standalone) label="standalone Node.js" ;;
  esac

  if ! ( : <>/dev/tty ) 2>/dev/null; then
    printf 'No terminal detected; install Node.js 22 or newer and npm, then run this installer again.\n'
    return 1
  fi
  exec 3<>/dev/tty

  printf 'Marshall needs Node.js 22 or newer and npm. Install them now with %s? [Y/n] ' "$label" >&3
  if ! IFS= read -r answer <&3; then
    answer=
  fi
  exec 3>&-
  case "$answer" in
    n|N|no|NO) printf '\nInstall Node.js 22 or newer and npm, then run this installer again.\n'; return 1 ;;
    *) ;;
  esac

  install_node_npm "$method" "$label"
}

detect_node_install_method() {
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        printf 'homebrew'
      else
        printf 'standalone'
      fi
      ;;
    Linux)
      if command -v apt-cache >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1 && apt_node_candidate_is_new_enough; then
        printf 'apt'
      elif command -v apk >/dev/null 2>&1 && apk_node_candidate_is_new_enough; then
        printf 'apk'
      else
        printf 'standalone'
      fi
      ;;
    *)
      printf 'standalone'
      ;;
  esac
}

apt_node_candidate_is_new_enough() {
  version=$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ { print $2; exit }')
  [ -n "$version" ] && [ "$version" != "(none)" ] && node_version_string_is_new_enough "$version"
}

apk_node_candidate_is_new_enough() {
  version=$(apk search -x nodejs 2>/dev/null | awk -F- '/^nodejs-/ { print $2; exit }')
  [ -n "$version" ] && node_version_string_is_new_enough "$version"
}

node_version_string_is_new_enough() {
  version="${1#v}"
  case "$version" in
    [0-9]*) ;;
    *) return 1 ;;
  esac
  version="${version%%[!0-9.]*}"
  version_ifs=${IFS- }
  IFS=.
  set -- $version
  IFS=$version_ifs
  major="${1:-}"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac

  [ "$major" -ge "$MR_REQUIRED_NODE_MAJOR" ]
}

install_node_npm() {
  method="$1"; label="$2"

  if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
    install_node_npm_with_progress "$method" "$label"
  else
    printf '\nInstalling Node.js and npm with %s...\n\n' "$label"
    run_node_install_method "$method"
    printf '\nNode.js and npm are installed.\n'
  fi

  if [ "$method" = standalone ]; then
    load_standalone_node
    MR_NODE_INSTALLED_STANDALONE=1
  fi
  hash -r
  printf '\n'
}

install_node_npm_with_progress() {
  method="$1"; label="$2"
  log_file="${TMPDIR:-/tmp}/marshall-installer-node.$$"
  rm -f "$log_file"
  : >"$log_file"

  run_node_install_method "$method" >"$log_file" 2>&1 &
  install_pid=$!

  printf '\033[?25l'
  animate_node_install "$log_file" "$label" &
  progress_pid=$!
  trap 'kill "$install_pid" 2>/dev/null || true; finish_install_progress "$progress_pid"; exit 130' INT TERM

  if wait "$install_pid"; then
    status=0
  else
    status=$?
  fi

  finish_install_progress "$progress_pid"
  trap - INT TERM

  if [ "$status" -ne 0 ]; then
    printf '\033[31mNode.js installation failed.\033[0m\n\n'
    cat "$log_file"
    rm -f "$log_file"
    return "$status"
  fi

  rm -f "$log_file"
  if terminal_supports_unicode; then
    printf '  \033[32m✓\033[0m Node.js and npm install complete\n'
  else
    printf '  \033[32mok\033[0m Node.js and npm install complete\n'
  fi
}

run_node_install_method() {
  case "$1" in
    homebrew) install_node_with_homebrew ;;
    apt) install_node_with_apt ;;
    apk) install_node_with_apk ;;
    standalone) install_node_standalone ;;
  esac
}

install_node_with_homebrew() {
  if brew list node >/dev/null 2>&1; then
    brew upgrade node
  else
    brew install node
  fi
}

install_node_with_apt() {
  print_sudo_note
  if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    apt-get update
    apt-get install -y nodejs npm
  else
    sudo sh -c 'apt-get update && apt-get install -y nodejs npm'
  fi
}

install_node_with_apk() {
  print_sudo_note
  run_with_sudo apk add --update-cache nodejs npm
}

install_node_standalone() {
  node_platform=$(detect_node_binary_platform) || {
    printf 'Unsupported operating system for automatic Node.js install: %s\n' "$(uname -s)"
    return 1
  }
  node_arch=$(detect_node_binary_arch) || {
    printf 'Unsupported CPU architecture for automatic Node.js install: %s\n' "$(uname -m)"
    return 1
  }
  node_dist_base="https://nodejs.org/dist/latest-v22.x"
  node_base_dir=$(node_standalone_base_dir)
  node_tmp_dir="${TMPDIR:-/tmp}/marshall-node.$$"

  rm -rf "$node_tmp_dir"
  mkdir -p "$node_tmp_dir" "$node_base_dir"

  printf 'Resolving Node.js binary for %s-%s\n' "$node_platform" "$node_arch"
  curl -fsSL "$node_dist_base/SHASUMS256.txt" -o "$node_tmp_dir/SHASUMS256.txt"
  node_file=$(awk -v suffix="-$node_platform-$node_arch.tar.xz" '
    index($2, "node-v") == 1 && length($2) >= length(suffix) && substr($2, length($2) - length(suffix) + 1) == suffix { print $2; exit }
  ' "$node_tmp_dir/SHASUMS256.txt")
  if [ -z "$node_file" ]; then
    printf 'No Node.js binary is available for %s-%s.\n' "$node_platform" "$node_arch"
    rm -rf "$node_tmp_dir"
    return 1
  fi

  printf 'Downloading Node.js %s\n' "${node_file%.tar.xz}"
  curl -fsSL "$node_dist_base/$node_file" -o "$node_tmp_dir/$node_file"
  verify_node_standalone_download "$node_tmp_dir" "$node_file"
  ensure_node_standalone_extract_tools "$node_platform"

  node_dir="$node_base_dir/${node_file%.tar.xz}"
  rm -rf "$node_dir"
  printf 'Extracting Node.js to %s\n' "$node_dir"
  tar -xf "$node_tmp_dir/$node_file" -C "$node_base_dir"
  rm -f "$node_base_dir/current"
  ln -s "$node_dir" "$node_base_dir/current"
  rm -rf "$node_tmp_dir"
  printf 'Node.js installed at %s\n' "$node_dir"
}

verify_node_standalone_download() {
  checksum_dir="$1"
  checksum_file_name="$2"
  awk -v file="$checksum_file_name" '$2 == file { print }' "$checksum_dir/SHASUMS256.txt" > "$checksum_dir/SHASUMS256.selected"

  if command -v sha256sum >/dev/null 2>&1; then
    printf 'Verifying Node.js download\n'
    (cd "$checksum_dir" && sha256sum -c SHASUMS256.selected)
  elif command -v shasum >/dev/null 2>&1; then
    printf 'Verifying Node.js download\n'
    (cd "$checksum_dir" && shasum -a 256 -c SHASUMS256.selected)
  fi
}

ensure_node_standalone_extract_tools() {
  extract_platform="$1"

  if [ "$extract_platform" = linux ] && ! command -v xz >/dev/null 2>&1; then
    printf 'Installing xz-utils for Node.js archive extraction\n'
    print_sudo_note
    if command -v apt-get >/dev/null 2>&1; then
      run_with_sudo apt-get update
      run_with_sudo apt-get install -y xz-utils
    elif command -v apk >/dev/null 2>&1; then
      run_with_sudo apk add --update-cache xz
    else
      printf 'xz is required to extract Node.js. Install xz and run this installer again.\n'
      return 1
    fi
  fi
}

load_standalone_node() {
  MR_STANDALONE_NODE_BIN="$(node_standalone_base_dir)/current/bin"
  PATH="$MR_STANDALONE_NODE_BIN:$PATH"
  export MR_STANDALONE_NODE_BIN PATH
}

node_standalone_base_dir() {
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    printf '%s/marshall-node' "$XDG_DATA_HOME"
  else
    printf '%s/.local/share/marshall-node' "$HOME"
  fi
}

detect_node_binary_platform() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) return 1 ;;
  esac
}

detect_node_binary_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    armv7l) printf 'armv7l' ;;
    ppc64le) printf 'ppc64le' ;;
    s390x) printf 's390x' ;;
    *) return 1 ;;
  esac
}

print_sudo_note() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    printf 'This may ask for your sudo password.\n\n'
  fi
}

run_with_sudo() {
  if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

select_npm_install_prefix() {
  npm_prefix=$(npm_global_prefix)
  if [ -n "$npm_prefix" ] && npm_prefix_supports_global_install "$npm_prefix"; then
    return 0
  fi

  if existing_global_mr_blocks_user_local_install "$npm_prefix"; then
    print_existing_global_mr_not_writable_message "$npm_prefix"
    return 1
  fi

  printf '%s/.local' "$HOME"
}

select_npm_uninstall_prefix() {
  existing_mr_path="$1"
  [ -n "$existing_mr_path" ] || return 0

  npm_prefix=$(npm_global_prefix)
  if [ -n "$npm_prefix" ] && [ "$existing_mr_path" = "$npm_prefix/bin/$MR_CMD" ]; then
    return 0
  fi

  if [ -n "${MR_NPM_INSTALL_PREFIX:-}" ] && [ "$existing_mr_path" = "$MR_NPM_INSTALL_PREFIX/bin/$MR_CMD" ]; then
    printf '%s' "$MR_NPM_INSTALL_PREFIX"
    return 0
  fi

  mr_bin_suffix="/bin/$MR_CMD"
  case "$existing_mr_path" in
    *"$mr_bin_suffix") printf '%s' "${existing_mr_path%$mr_bin_suffix}" ;;
  esac
}

npm_global_prefix() {
  npm prefix -g 2>/dev/null || npm config get prefix 2>/dev/null
}

npm_prefix_supports_global_install() {
  prefix="$1"
  path_is_writable_or_creatable "$prefix/lib/node_modules" && path_is_writable_or_creatable "$prefix/bin"
}

existing_global_mr_blocks_user_local_install() {
  npm_prefix="$1"
  [ -n "$npm_prefix" ] || return 1

  [ -e "$npm_prefix/bin/$MR_CMD" ]
}

print_existing_global_mr_not_writable_message() {
  npm_prefix="$1"
  existing_mr_path="$npm_prefix/bin/$MR_CMD"

  printf "npm's global directory is not writable: %s\n" "$npm_prefix" >&2
  printf 'Marshall is already installed at: %s\n\n' "$existing_mr_path" >&2
  printf 'Installing another copy under %s/.local could leave your shell using the old global marshall, so this installer stopped.\n\n' "$HOME" >&2
  printf 'Update or remove the existing global install first. If it was installed with npm, you can run:\n\n' >&2
  printf '  sudo npm install -g %s\n\n' "$MR_PACKAGE" >&2
  printf 'or uninstall it first with:\n\n' >&2
  printf '  sudo npm uninstall -g %s\n\n' "$MR_PACKAGE" >&2
  printf 'Then run this installer again.\n' >&2
}

path_is_writable_or_creatable() {
  check_path="$1"
  while [ ! -e "$check_path" ]; do
    parent=${check_path%/*}
    if [ -z "$parent" ] || [ "$parent" = "$check_path" ]; then
      return 1
    fi
    check_path="$parent"
  done

  [ -d "$check_path" ] && [ -w "$check_path" ]
}

mr_install_bin_dir() {
  if [ -n "${MR_NPM_INSTALL_PREFIX:-}" ]; then
    printf '%s/bin' "$MR_NPM_INSTALL_PREFIX"
  else
    npm_prefix=$(npm_global_prefix)
    if [ -n "$npm_prefix" ]; then
      printf '%s/bin' "$npm_prefix"
    fi
  fi
}

mr_installed_path() {
  mr_bin_dir=$(mr_install_bin_dir)
  if [ -n "$mr_bin_dir" ]; then
    printf '%s/%s' "$mr_bin_dir" "$MR_CMD"
  fi
}

installed_mr_is_first_on_path() {
  installed_mr_path=$(mr_installed_path)
  [ -n "$installed_mr_path" ] || return 1

  active_mr_path=$(command -v "$MR_CMD" 2>/dev/null) || return 1
  [ "$active_mr_path" = "$installed_mr_path" ]
}

shell_config_file() {
  current_shell=$(basename "${SHELL:-sh}")
  case "$current_shell" in
    fish) printf '%s/.config/fish/config.fish' "$HOME" ;;
    zsh) printf '%s/.zshrc' "${ZDOTDIR:-$HOME}" ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        printf '%s/.bashrc' "$HOME"
      else
        printf '%s/.profile' "$HOME"
      fi
      ;;
    *) printf '%s/.profile' "$HOME" ;;
  esac
}

path_update_command() {
  bin_dir="$1"
  current_shell=$(basename "${SHELL:-sh}")
  if [ "$bin_dir" = "$HOME/.local/bin" ]; then
    bin_expr='$HOME/.local/bin'
  else
    bin_expr="$bin_dir"
  fi

  case "$current_shell" in
    fish) printf 'fish_add_path "%s"' "$bin_expr" ;;
    *) printf 'export PATH="%s:$PATH"' "$bin_expr" ;;
  esac
}

config_file_mentions_path() {
  config_file="$1"
  command="$2"

  [ -f "$config_file" ] || return 1
  grep -Fxq "$command" "$config_file"
}

prompt_add_path_to_profile() {
  bin_dir="$1"
  if ! ( : <>/dev/tty ) 2>/dev/null; then
    return 1
  fi

  config_file=$(shell_config_file)
  command=$(path_update_command "$bin_dir")

  if config_file_mentions_path "$config_file" "$command"; then
    printf 'A PATH update for %s already exists in %s.\n' "$bin_dir" "$config_file"
    return 0
  fi

  exec 3<>/dev/tty
  printf 'Add %s to your PATH in %s now? [Y/n] ' "$bin_dir" "$config_file" >&3
  if ! IFS= read -r answer <&3; then
    answer=
  fi
  exec 3>&-
  case "$answer" in
    n|N|no|NO) return 1 ;;
    *) ;;
  esac

  mkdir -p "${config_file%/*}"
  touch "$config_file"
  printf '\n# Marshall\n%s\n' "$command" >> "$config_file"
  printf 'Added %s to %s.\n' "$bin_dir" "$config_file"
}

print_mr_not_on_path_message() {
  mr_bin_dir=$(mr_install_bin_dir)
  active_mr_path=$(command -v "$MR_CMD" 2>/dev/null || true)

  printf 'Marshall was installed, but your shell is not using that install yet.\n'
  if [ -n "$active_mr_path" ]; then
    printf 'Your shell currently resolves marshall to: %s\n' "$active_mr_path"
  fi

  if [ -n "$mr_bin_dir" ]; then
    prompt_add_path_to_profile "$mr_bin_dir" || true
    command=$(path_update_command "$mr_bin_dir")
    printf 'Restart your shell or run:\n\n'
    printf '  %s\n\n' "$command"
    printf 'Then run: marshall\n'
  else
    printf "Check npm's global prefix with:\n\n"
    printf '  npm prefix -g\n\n'
    printf 'Then add its bin directory to your shell PATH.\n'
  fi
}

choose_mr_action() {
  existing_mr_path="$1"

  if ! ( : <>/dev/tty ) 2>/dev/null; then
    print_mr_action_menu "$existing_mr_path"
    printf 'No terminal detected; continuing without confirmation.\n'
    if [ -n "$existing_mr_path" ]; then
      MR_INSTALL_ACTION=reinstall
    else
      MR_INSTALL_ACTION=install
    fi
    print_mr_action_selection "$MR_INSTALL_ACTION"
    return 0
  fi

  exec 3<>/dev/tty
  trap 'exec 3>&-; trap - INT TERM; exit 130' INT TERM
  print_mr_action_menu "$existing_mr_path" >&3

  while :; do
    key=$(read_tty_key)

    case "$key" in
      ""|" "|"$MR_CR")
        if [ -n "$existing_mr_path" ]; then
          MR_INSTALL_ACTION=reinstall
        else
          MR_INSTALL_ACTION=install
        fi
        break
        ;;
      y|Y)
        if [ -n "$existing_mr_path" ]; then
          MR_INSTALL_ACTION=reinstall
        else
          MR_INSTALL_ACTION=install
        fi
        break
        ;;
      u|U)
        if [ -n "$existing_mr_path" ]; then
          MR_INSTALL_ACTION=uninstall
          break
        fi
        ;;
      "$MR_ETX")
        exit 130
        ;;
      n|N|"$MR_ESC")
        MR_INSTALL_ACTION=none
        break
        ;;
    esac

    printf 'Please choose one of the listed keys.\n' >&3
  done

  print_mr_action_selection "$MR_INSTALL_ACTION" >&3
  exec 3>&-
  trap - INT TERM
}

print_mr_action_menu() {
  existing_mr_path="$1"

  reset=
  dim=
  bold=
  cyan=
  green=
  red=
  if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
    reset="${MR_ESC}[0m"
    dim="${MR_ESC}[2m"
    bold="${MR_ESC}[1m"
    cyan="${MR_ESC}[36m"
    green="${MR_ESC}[32m"
    red="${MR_ESC}[31m"
  fi

  if [ -n "$existing_mr_path" ]; then
    printf '%sMarshall is already installed at:%s\n\n' "$bold" "$reset"
    printf '  %s\n\n' "$existing_mr_path"
  fi

  if [ -n "${MR_NPM_INSTALL_PREFIX:-}" ]; then
    printf "npm's global directory is not writable; Marshall will be installed under %s.\n\n" "$MR_NPM_INSTALL_PREFIX"
  fi

  if [ -n "$existing_mr_path" ]; then
    printf '%sReinstall command:%s\n\n  ' "$bold" "$reset"
  else
    printf '%sInstall command:%s\n\n  ' "$bold" "$reset"
  fi
  printf 'npm install -g %s' "$MR_PACKAGE"
  printf '\n\n'

  printf '%sChoose an action:%s\n\n' "$bold" "$reset"
  if [ -n "$existing_mr_path" ]; then
    printf '  %s%-4s%s %sReinstall Marshall%s %s(default)%s\n' "$cyan" 'y' "$reset" "$green" "$reset" "$dim" "$reset"
    printf '  %s%-4s%s %sUninstall Marshall%s\n' "$cyan" 'u' "$reset" "$red" "$reset"
  else
    printf '  %s%-4s%s %sInstall Marshall%s %s(default)%s\n' "$cyan" 'y' "$reset" "$green" "$reset" "$dim" "$reset"
  fi
  printf '  %s%-4s%s %sDo nothing%s\n' "$cyan" 'n' "$reset" "$dim" "$reset"
}

print_mr_action_selection() {
  case "$1" in
    install) message="Will install Marshall." ;;
    reinstall) message="Will reinstall Marshall." ;;
    uninstall) message="Will uninstall Marshall." ;;
    none) message="Chose to do nothing. Exiting." ;;
  esac
  printf '\n%s\n\n' "$message"
}

restore_tty_state() {
  tty_state="$1"
  [ -n "$tty_state" ] || return 0
  stty "$tty_state" < /dev/tty 2>/dev/null || true
}

read_tty_key() {
  old_tty_state=$(stty -g < /dev/tty 2>/dev/null || true)
  trap 'restore_tty_state "$old_tty_state"; trap - INT TERM; exit 130' INT TERM
  stty -icanon -echo min 1 time 0 < /dev/tty 2>/dev/null || true
  if ! key=$(dd bs=1 count=1 2>/dev/null < /dev/tty); then
    key=
  fi
  restore_tty_state "$old_tty_state"
  trap - INT TERM
  printf '%s' "$key"
}

install_mr_package() {
  if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
    install_mr_package_with_progress
  else
    printf 'Installing Marshall...\n\n'
    run_mr_install error
  fi
}

run_mr_install() {
  npm_loglevel="$1"
  run_npm_install_mr "$npm_loglevel"
}

run_npm_install_mr() {
  npm_loglevel="$1"
  if [ -n "${MR_NPM_INSTALL_PREFIX:-}" ]; then
    npm install -g --prefix "$MR_NPM_INSTALL_PREFIX" --no-fund --no-audit "--loglevel=$npm_loglevel" --progress=false "$MR_PACKAGE"
  else
    npm install -g --no-fund --no-audit "--loglevel=$npm_loglevel" --progress=false "$MR_PACKAGE"
  fi
}

uninstall_mr_package() {
  if ! npm_package_is_installed_for_uninstall; then
    printf 'I found marshall at:\n\n  %s\n\n' "$MR_EXISTING_PATH" >&2
    printf 'but npm does not show %s installed there.\n' "$MR_PACKAGE" >&2
    printf 'Nothing was removed.\n' >&2
    return 1
  fi

  printf 'Uninstalling Marshall...\n\n'
  run_npm_uninstall_mr error
  hash -r

  if [ -e "$MR_EXISTING_PATH" ] || [ -L "$MR_EXISTING_PATH" ]; then
    printf '\nnpm uninstall finished, but marshall is still present at:\n\n  %s\n' "$MR_EXISTING_PATH" >&2
    return 1
  fi
}

npm_package_is_installed_for_uninstall() {
  if [ -n "${MR_NPM_UNINSTALL_PREFIX:-}" ]; then
    npm ls -g --prefix "$MR_NPM_UNINSTALL_PREFIX" --depth=0 "$MR_PACKAGE" >/dev/null 2>&1
  else
    npm ls -g --depth=0 "$MR_PACKAGE" >/dev/null 2>&1
  fi
}

run_npm_uninstall_mr() {
  npm_loglevel="$1"
  if [ -n "${MR_NPM_UNINSTALL_PREFIX:-}" ]; then
    npm uninstall -g --prefix "$MR_NPM_UNINSTALL_PREFIX" --no-fund --no-audit "--loglevel=$npm_loglevel" --progress=false "$MR_PACKAGE"
  else
    npm uninstall -g --no-fund --no-audit "--loglevel=$npm_loglevel" --progress=false "$MR_PACKAGE"
  fi
}

install_mr_package_with_progress() {
  log_file="${TMPDIR:-/tmp}/marshall-installer-npm.$$"
  rm -f "$log_file"
  : >"$log_file"

  run_mr_install verbose >"$log_file" 2>&1 &
  npm_pid=$!

  printf '\033[?25l'
  animate_npm_install "$log_file" &
  progress_pid=$!
  trap 'kill "$npm_pid" 2>/dev/null || true; finish_install_progress "$progress_pid"; exit 130' INT TERM

  if wait "$npm_pid"; then
    status=0
  else
    status=$?
  fi

  finish_install_progress "$progress_pid"
  trap - INT TERM

  if [ "$status" -ne 0 ]; then
    printf '\033[31mInstallation failed.\033[0m\n\n'
    cat "$log_file"
    rm -f "$log_file"
    return "$status"
  fi

  rm -f "$log_file"
  if terminal_supports_unicode; then
    printf '  \033[32m✓\033[0m install complete\n'
  else
    printf '  \033[32mok\033[0m install complete\n'
  fi
}

finish_install_progress() {
  progress_pid="$1"

  kill "$progress_pid" 2>/dev/null || true
  wait "$progress_pid" 2>/dev/null || true
  printf '\r\033[K\033[?25h'
}

terminal_supports_unicode() {
  locale="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"

  case "$locale" in
    *UTF-8*|*utf-8*|*UTF8*|*utf8*) return 0 ;;
  esac

  case "${TERM_PROGRAM:-}" in
    Apple_Terminal|iTerm.app|vscode|WezTerm) return 0 ;;
  esac

  return 1
}

spinner_frame() {
  frame_step="$1"
  frame_count="$2"

  if [ "$frame_count" -eq 10 ]; then
    case $((frame_step % 10)) in
      0) printf '⠋' ;;
      1) printf '⠙' ;;
      2) printf '⠹' ;;
      3) printf '⠸' ;;
      4) printf '⠼' ;;
      5) printf '⠴' ;;
      6) printf '⠦' ;;
      7) printf '⠧' ;;
      8) printf '⠇' ;;
      *) printf '⠏' ;;
    esac
  else
    case $((frame_step % 4)) in
      0) printf '-' ;;
      1) printf '\' ;;
      2) printf '|' ;;
      *) printf '/' ;;
    esac
  fi
}

animate_npm_install() {
  log_file="$1"

  if terminal_supports_unicode; then
    full="█"
    empty="░"
    frame_count=10
  else
    full="#"
    empty="-"
    frame_count=4
  fi

  step=0
  label="starting npm install"
  while :; do
    frame=$(spinner_frame "$step" "$frame_count")
    if [ $((step % 5)) -eq 0 ]; then
      label=$(npm_install_progress_label "$log_file" "$label")
    fi
    draw_install_progress "$step" "$frame" "$label" "$full" "$empty"
    step=$((step + 1))
    sleep 0.08
  done
}

animate_node_install() {
  log_file="$1"
  method_label="$2"

  if terminal_supports_unicode; then
    full="█"
    empty="░"
    frame_count=10
  else
    full="#"
    empty="-"
    frame_count=4
  fi

  step=0
  label="starting ${method_label} install"
  while :; do
    frame=$(spinner_frame "$step" "$frame_count")
    if [ $((step % 5)) -eq 0 ]; then
      label=$(node_install_progress_label "$log_file" "$label")
    fi
    draw_install_progress "$step" "$frame" "$label" "$full" "$empty" "Installing Node.js"
    step=$((step + 1))
    sleep 0.08
  done
}

node_install_progress_label() {
  log_file="$1"
  label="$2"

  while IFS= read -r line; do
    line=${line##*"$MR_CR"}
    case "$line" in
      "") ;;
      Resolving\ Node.js*) label="resolving Node.js binary" ;;
      Downloading\ Node.js*) label="$line" ;;
      Verifying\ Node.js*) label="verifying download" ;;
      Installing\ xz-utils*) label="installing xz-utils" ;;
      Extracting\ Node.js*) label="extracting Node.js" ;;
      Node.js\ installed*) label="Node.js installed" ;;
      Hit:*|Get:*|Ign:*) label="updating package lists" ;;
      Reading\ package\ lists*) label="reading package lists" ;;
      Building\ dependency\ tree*) label="resolving dependencies" ;;
      The\ following\ NEW\ packages*) label="installing dependencies" ;;
      Need\ to\ get*|Fetched\ *) label="$line" ;;
      Selecting\ previously\ unselected\ package*) label="selecting packages" ;;
      Preparing\ to\ unpack*) label="preparing packages" ;;
      Unpacking\ *|Setting\ up\ *) label="$line" ;;
      fetch\ *) label="fetching packages" ;;
      *Installing\ nodejs*) label="$line" ;;
      OK:\ *) label="$line" ;;
      ==\>\ Downloading*) label="downloading packages" ;;
      ==\>\ Installing*|==\>\ Upgrading*) label="$line" ;;
      ==\>\ Pouring*) label="installing package" ;;
      *already\ installed*) label="$line" ;;
    esac
  done < "$log_file"

  if [ "${#label}" -gt 64 ]; then
    label=$(printf '%.61s...' "$label")
  fi
  printf '%s' "$label"
}

npm_install_progress_label() {
  log_file="$1"
  label="$2"

  while IFS= read -r line; do
    line=${line%"$MR_CR"}
    case "$line" in
      npm\ verbose\ title\ npm\ install*)
        label="resolving packages"
        ;;
      npm\ http\ fetch\ GET\ *https://registry.npmjs.org/*.tgz*)
        label="fetching tarballs"
        ;;
      npm\ http\ fetch\ GET\ *https://registry.npmjs.org/*)
        label="fetching package metadata"
        ;;
      npm\ info\ run\ *)
        rest=${line#npm info run }
        package=${rest%% *}
        rest=${rest#* }
        script=${rest%% *}
        package=${package%@*}
        case "$line" in
          *\{\ code:*) label="finished ${script} for ${package}" ;;
          *) label="running ${script} for ${package}" ;;
        esac
        ;;
      changed\ *|added\ *|removed\ *|updated\ *|up\ to\ date\ *)
        label="$line"
        ;;
    esac
  done < "$log_file"

  printf '%s' "$label"
}

draw_install_progress() {
  step="$1"; frame="$2"; label="$3"; full="$4"; empty="$5"; title="${6:-Installing Marshall}"

  reset="${MR_ESC}[0m"
  dim="${MR_ESC}[2m"
  cyan="${MR_ESC}[36m"
  red="${MR_ESC}[31m"
  green="${MR_ESC}[32m"
  orange="${MR_ESC}[33m"
  bold="${MR_ESC}[1m"

  width=28
  trail=8
  head=$((step % (width + trail)))
  bar=""

  i=0
  while [ "$i" -lt "$width" ]; do
    age=$((head - i))
    if [ "$age" -ge 0 ] && [ "$age" -lt "$trail" ]; then
      case "$age" in
        0|1) cell="${green}${full}${reset}" ;;
        2|3) cell="${cyan}${full}${reset}" ;;
        4|5) cell="${red}${full}${reset}" ;;
        *) cell="${orange}${full}${reset}" ;;
      esac
    else
      cell="${dim}${empty}${reset}"
    fi
    bar="${bar}${cell}"
    i=$((i + 1))
  done

  printf '\r\033[K  %s%s%s %s %s%s%s %s' "$orange" "$frame" "$reset" "$bar" "$bold" "$title" "$reset" "$label"
}

mr_logo_animation() {
  if [ ! -t 1 ] || [ "${TERM:-}" = "dumb" ]; then
    print_static_logo
    return
  fi

  esc="${MR_ESC}["
  reset="${MR_ESC}[0m"
  hide="${esc}?25l"
  show="${esc}?25h"
  clear="${esc}H"

  trap 'printf "%s%s\n" "$reset" "$show"; trap - INT TERM; exit 130' INT TERM
  printf '%s%s' "$hide" "${esc}2J${esc}H"

  # Assemble the M top to bottom, then blink the floor.
  row=0
  while [ "$row" -le 8 ]; do
    draw_mr_logo_frame "$clear" "$reset" "$row" 0
    sleep 0.05
    row=$((row + 1))
  done

  draw_mr_logo_frame "$clear" "$reset" 9 0; sleep 0.25
  blink=0
  while [ "$blink" -lt 3 ]; do
    draw_mr_logo_frame "$clear" "$reset" 9 1; sleep 0.12
    draw_mr_logo_frame "$clear" "$reset" 9 0; sleep 0.12
    blink=$((blink + 1))
  done
  sleep 0.25

  printf '%s%s\n' "$reset" "$show"
  trap - INT TERM
}

draw_mr_logo_frame() {
  clear="$1"; reset="$2"; reveal="$3"; flash="$4"

  left=0
  top=0

  panel_cell="${reset}  "
  cyan_cell="${MR_ESC}[36m██"
  orange_cell="${MR_ESC}[33m██"

  pad=$(repeat_space "$left")
  frame="$clear"
  i=0
  while [ "$i" -lt "$top" ]; do frame="${frame}\n"; i=$((i + 1)); done

  y=0
  while [ "$y" -le 8 ]; do
    frame="${frame}${pad}"
    x=1
    while [ "$x" -le 8 ]; do
      if [ "$flash" = 1 ] && is_floor_cell "$y" "$x"; then
        cell="$orange_cell"
      elif [ "$reveal" -ge "$y" ] && is_m_cell "$y" "$x"; then
        cell="$cyan_cell"
      else
        cell="$panel_cell"
      fi
      frame="${frame}${cell}"
      x=$((x + 1))
    done
    frame="${frame}${reset}\n"
    y=$((y + 1))
  done
  printf '%b' "$frame" 2>/dev/null || true
}

is_m_cell() {
  y="$1"; x="$2"
  case "$y,$x" in
    0,1|0,2|0,7|0,8|1,1|1,2|1,3|1,6|1,7|1,8|2,1|2,2|2,4|2,5|2,7|2,8|3,1|3,2|3,4|3,5|3,7|3,8|4,1|4,4|4,5|4,8|5,1|5,4|5,5|5,8|6,1|6,4|6,5|6,8|7,1|7,4|7,5|7,8|8,1|8,4|8,5|8,8)
      return 0 ;;
  esac
  return 1
}

is_floor_cell() {
  y="$1"; x="$2"
  case "$y,$x" in
    8,2|8,3|8,6|8,7) return 0 ;;
  esac
  return 1
}

repeat_space() {
  count="$1"; out=""
  while [ "$count" -gt 0 ]; do out=" $out"; count=$((count - 1)); done
  printf '%s' "$out"
}

print_static_logo() {
  cat <<'EOF'

   ██    ██
   ██ ██ ██
   ██  ██ ██
   ██    ██

EOF
}

mr_installer_main "$@"

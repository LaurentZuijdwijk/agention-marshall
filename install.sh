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

# The block-letter MARSHALL wordmark, painted in the brand gradient (violet→cyan).
# Wide below 65 columns; compact (two rows) otherwise. Static banner only.
MR_LOGO_WIDE='███╗   ███╗ █████╗ ██████╗ ███████╗██╗  ██╗ █████╗ ██╗     ██╗
████╗ ████║██╔══██╗██╔══██╗██╔════╝██║  ██║██╔══██╗██║     ██║
██╔████╔██║███████║██████╔╝███████╗███████║███████║██║     ██║
██║╚██╔╝██║██╔══██║██╔══██╗╚════██║██╔══██║██╔══██║██║     ██║
██║ ╚═╝ ██║██║  ██║██║  ██║███████║██║  ██║██║  ██║███████╗███████╗
╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝'
MR_LOGO_COMPACT='█▀▄▀█ ▄▀█ █▀█ █▀ █ █ ▄▀█ █   █
█ ▀ █ █▀█ █▀▄ ▄█ █▀█ █▀█ █▄▄ █▄▄'

mr_logo() {
  if [ ! -t 1 ] || [ "${TERM:-}" = "dumb" ]; then
    printf '\n%s\n\n' "$MR_LOGO_COMPACT"
    return
  fi

  cols=$(tput cols 2>/dev/null || printf 80)
  if [ "$cols" -ge 65 ]; then
    rows="$MR_LOGO_WIDE"
    width=63
  else
    rows="$MR_LOGO_COMPACT"
    width=29
  fi

  # Brand gradient violet→cyan as 256-colour bands when the terminal supports it.
  gradient=0
  if [ -n "${COLORTERM:-}" ]; then
    case "$COLORTERM" in truecolor|24bit) gradient=1 ;; esac
  elif case "$TERM" in *256color*) true ;; *) false ;; esac; then
    gradient=1
  fi

  b0="${MR_ESC}[38;5;99m"
  b1="${MR_ESC}[38;5;105m"
  b2="${MR_ESC}[38;5;111m"
  b3="${MR_ESC}[38;5;117m"
  b4="${MR_ESC}[38;5;123m"
  b5="${MR_ESC}[38;5;51m"
  reset="${MR_ESC}[0m"

  printf '\n'
  # Do not parse the UTF-8 logo one character at a time. macOS /bin/sh treats
  # the block glyphs differently from Linux shells, which can make a pattern
  # such as ??? match nothing and leave the loop spinning forever.
  if [ "$gradient" = 1 ]; then
    logo_color="$b2"
  else
    logo_color="${MR_ESC}[36m"
  fi
  printf '%s%s%s\n' "$logo_color" "$rows" "$reset"
  printf '\n'
}

mr_installer_main() {
  set -eu

  mr_logo
  printf '\033[1m Marshall Installer\033[0m\n'
  printf '\033[2m A coding agent that does not pretend to be your keyboard\033[0m\n\n'

  if ! run_preflight_checks; then
    if ! install_node_npm_interactive; then
      exit 1
    fi
    if ! run_preflight_checks; then
      exit 1
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
    homebrew)   label="Homebrew" ;;
    apt)        label="apt" ;;
    apk)        label="apk" ;;
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
    n|N|no|NO)
      printf '\nInstall Node.js 22 or newer and npm, then run this installer again.\n'
      return 1
      ;;
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
  version_ifs=${IFS-}
  IFS=.
  set -- $version
  IFS=$version_ifs
  major="${1:-}"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge "$MR_REQUIRED_NODE_MAJOR" ]
}

install_node_npm() {
  method="$1"
  label="$2"

  printf '\nInstalling Node.js and npm with %s...\n\n' "$label"
  run_node_install_method "$method"
  printf '\nNode.js and npm are installed.\n'

  if [ "$method" = standalone ]; then
    load_standalone_node
    MR_NODE_INSTALLED_STANDALONE=1
  fi

  # Make sure the new binaries are visible in this shell
  if [ "$method" = homebrew ] && command -v brew >/dev/null 2>&1; then
    eval "$(brew shellenv 2>/dev/null)" || true
  fi
  hash -r
  printf '\n'
}

run_node_install_method() {
  case "$1" in
    homebrew)   install_node_with_homebrew ;;
    apt)        install_node_with_apt ;;
    apk)        install_node_with_apk ;;
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

  node_file=$(awk -v suffix="-$node_platform-$node_arch.tar.gz" '
    index($2, "node-v") == 1 && length($2) >= length(suffix) && substr($2, length($2) - length(suffix) + 1) == suffix { print $2; exit }
  ' "$node_tmp_dir/SHASUMS256.txt")

  if [ -z "$node_file" ]; then
    printf 'No Node.js binary is available for %s-%s.\n' "$node_platform" "$node_arch"
    rm -rf "$node_tmp_dir"
    return 1
  fi

  printf 'Downloading Node.js %s\n' "${node_file%.tar.gz}"
  curl -fsSL "$node_dist_base/$node_file" -o "$node_tmp_dir/$node_file"

  verify_node_standalone_download "$node_tmp_dir" "$node_file"

  node_dir="$node_base_dir/${node_file%.tar.gz}"
  rm -rf "$node_dir"
  printf 'Extracting Node.js to %s\n' "$node_dir"
  tar -xzf "$node_tmp_dir/$node_file" -C "$node_base_dir"
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
  # Kept for compatibility with callers that may need to extract an xz archive.
  if ! command -v xz >/dev/null 2>&1; then
    printf 'xz is required to extract the Node.js archive.\n'
    case "$extract_platform" in
      linux)
        print_sudo_note
        if command -v apt-get >/dev/null 2>&1; then
          run_with_sudo apt-get update
          run_with_sudo apt-get install -y xz-utils
        elif command -v apk >/dev/null 2>&1; then
          run_with_sudo apk add --update-cache xz
        else
          printf 'Install xz and run this installer again.\n'
          return 1
        fi
        ;;
      darwin)
        if command -v brew >/dev/null 2>&1; then
          brew install xz
        else
          printf 'Install xz (e.g. via Homebrew: brew install xz) and run this installer again.\n'
          return 1
        fi
        ;;
      *)
        printf 'Install xz and run this installer again.\n'
        return 1
        ;;
    esac
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
    Linux)  printf 'linux' ;;
    *) return 1 ;;
  esac
}

detect_node_binary_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    armv7l)        printf 'armv7l' ;;
    ppc64le)       printf 'ppc64le' ;;
    s390x)         printf 's390x' ;;
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
    zsh)  printf '%s/.zshrc' "${ZDOTDIR:-$HOME}" ;;
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
    *)    printf 'export PATH="%s:$PATH"' "$bin_expr" ;;
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
  print_mr_action_menu "$existing_mr_path" >&3

  while :; do
    printf 'Choose [y/u/n]: ' >&3
    if ! IFS= read -r key <&3; then
      key=
    fi
    # take only the first character
    key=$(printf '%s' "$key" | cut -c1)

    case "$key" in
      ""|" "|"$MR_CR"|y|Y)
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
      n|N|"$MR_ESC")
        MR_INSTALL_ACTION=none
        break
        ;;
      *)
        printf 'Please choose one of the listed keys.\n' >&3
        ;;
    esac
  done

  print_mr_action_selection "$MR_INSTALL_ACTION" >&3
  exec 3>&-
}

print_mr_action_menu() {
  existing_mr_path="$1"

  if [ -n "$existing_mr_path" ]; then
    printf 'Marshall is already installed at:\n\n'
    printf '  %s\n\n' "$existing_mr_path"
  fi

  if [ -n "${MR_NPM_INSTALL_PREFIX:-}" ]; then
    printf "npm's global directory is not writable; Marshall will be installed under %s.\n\n" "$MR_NPM_INSTALL_PREFIX"
  fi

  if [ -n "$existing_mr_path" ]; then
    printf 'Reinstall command:\n\n  npm install -g %s\n\n' "$MR_PACKAGE"
  else
    printf 'Install command:\n\n  npm install -g %s\n\n' "$MR_PACKAGE"
  fi

  printf 'Choose an action:\n\n'
  if [ -n "$existing_mr_path" ]; then
    printf '  y    Reinstall Marshall (default)\n'
    printf '  u    Uninstall Marshall\n'
  else
    printf '  y    Install Marshall (default)\n'
  fi
  printf '  n    Do nothing\n\n'
}

print_mr_action_selection() {
  case "$1" in
    install)   message="Will install Marshall." ;;
    reinstall) message="Will reinstall Marshall." ;;
    uninstall) message="Will uninstall Marshall." ;;
    none)      message="Chose to do nothing. Exiting." ;;
  esac
  printf '\n%s\n\n' "$message"
}

install_mr_package() {
  printf 'Installing Marshall...\n\n'
  run_npm_install_mr error
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

mr_installer_main "$@"

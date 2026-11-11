#!/usr/bin/env bash
# opendeck installer — macOS, Linux and WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/ptthien97/opencode-opendeck/master/install.sh | bash
#
# Installs into ~/.local/share/opencode-opendeck, then registers that directory
# as a plugin in <config>/opencode/cli.json so OpenCode loads it from source.
set -eu

REPO_URL="https://github.com/ptthien97/opencode-opendeck.git"

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
opendeck installer for macOS, Linux and WSL.

Usage: install.sh [options]

Options:
  --dir <path>    install location (default: $HOME/.local/share/opencode-opendeck)
  --ref <ref>     git branch, tag or commit to install (default: master)
  --dev           clone, then `bun install` and `bun run bundle` instead of
                  using the committed dist/ (requires bun: https://bun.sh)
  --uninstall     remove the plugin entry (and optionally the install dir)
  --yes, -y       skip the confirmation prompt on --uninstall
  --repo <url>    advanced: clone from another URL or local path
  -h, --help      show this help

The plugin is added to <config>/cli.json as an absolute path, then OpenCode
loads <dir>/tui.js. Restart OpenCode, then type /opendeck.
USAGE
}

install_dir=""
ref="master"
repo="$REPO_URL"
dev=0
uninstall=0
assume_yes=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ $# -ge 2 ] || die "--dir requires a path"
      install_dir="$2"
      shift 2
      ;;
    --dir=*)
      install_dir="${1#--dir=}"
      shift
      ;;
    --ref)
      [ $# -ge 2 ] || die "--ref requires a value"
      ref="$2"
      shift 2
      ;;
    --ref=*)
      ref="${1#--ref=}"
      shift
      ;;
    --repo)
      [ $# -ge 2 ] || die "--repo requires a URL"
      repo="$2"
      shift 2
      ;;
    --repo=*)
      repo="${1#--repo=}"
      shift
      ;;
    --dev)
      dev=1
      shift
      ;;
    --uninstall)
      uninstall=1
      shift
      ;;
    --yes|-y)
      assume_yes=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (try --help)"
      ;;
  esac
done

if [ -z "$install_dir" ]; then
  install_dir="$HOME/.local/share/opencode-opendeck"
fi

# `opencode debug paths` prints "config <path>" among other lines; prefer it so
# portable/XDG setups resolve exactly like the host does.
find_config_dir() {
  fc_cfg=""
  if command -v opencode >/dev/null 2>&1; then
    fc_cfg=$(opencode debug paths 2>/dev/null | awk '$1 == "config" { print $2; exit }') || fc_cfg=""
  fi
  if [ -z "$fc_cfg" ]; then
    if [ -n "${XDG_CONFIG_HOME:-}" ]; then
      fc_cfg="$XDG_CONFIG_HOME/opencode"
    else
      fc_cfg="$HOME/.config/opencode"
    fi
  fi
  printf '%s\n' "$fc_cfg"
}

# JSON editing is delegated to the first runtime we can find. Both programs read
# OD_SRC and write the result to OD_OUT so the shell can back up and rename.
JSON_JS=$(cat <<'JS'
const fs = require("fs")
const mode = process.env.OD_MODE
const target = process.env.OD_DIR
let data = null
if (fs.existsSync(process.env.OD_SRC)) {
  const raw = fs.readFileSync(process.env.OD_SRC, "utf8")
  if (raw.trim() !== "") {
    try {
      data = JSON.parse(raw)
    } catch (err) {
      console.error("invalid JSON: " + err.message)
      process.exit(3)
    }
  }
}
if (data === null) {
  data = { "$schema": "https://opencode.ai/v2/cli.json", plugins: [] }
}
if (typeof data !== "object" || data === null || Array.isArray(data)) {
  console.error("cli.json is not a JSON object")
  process.exit(3)
}
let plugins = Array.isArray(data.plugins) ? data.plugins.slice() : []
const same = (p) =>
  (typeof p === "string" && p === target) ||
  (p !== null && typeof p === "object" && p.package === target)
if (mode === "add") {
  if (!plugins.some(same)) plugins.push(target)
} else {
  plugins = plugins.filter((p) => !same(p))
}
data.plugins = plugins
fs.writeFileSync(process.env.OD_OUT, JSON.stringify(data, null, 2) + "\n")
JS
)

JSON_PY=$(cat <<'PY'
import json
import os
import sys

mode = os.environ["OD_MODE"]
target = os.environ["OD_DIR"]
data = None
if os.path.exists(os.environ["OD_SRC"]):
    with open(os.environ["OD_SRC"], "r", encoding="utf-8") as handle:
        raw = handle.read()
    if raw.strip():
        try:
            data = json.loads(raw)
        except ValueError as err:
            sys.stderr.write("invalid JSON: %s\n" % err)
            sys.exit(3)
if data is None:
    data = {"$schema": "https://opencode.ai/v2/cli.json", "plugins": []}
if not isinstance(data, dict):
    sys.stderr.write("cli.json is not a JSON object\n")
    sys.exit(3)
plugins = data.get("plugins")
if not isinstance(plugins, list):
    plugins = []


def same(entry):
    if isinstance(entry, str):
        return entry == target
    if isinstance(entry, dict):
        return entry.get("package") == target
    return False


if mode == "add":
    if not any(same(entry) for entry in plugins):
        plugins.append(target)
else:
    plugins = [entry for entry in plugins if not same(entry)]
data["plugins"] = plugins
with open(os.environ["OD_OUT"], "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
PY
)

# Writes the edited document to "$2"; returns 0 on success, 3 on a parse error
# and 4 when no bun/node/python3 is available.
update_cli_json() {
  uc_mode="$1"
  uc_out="$2"
  rm -f "$uc_out"
  OD_MODE="$uc_mode" OD_DIR="$plugin_path" OD_SRC="$cli_json" OD_OUT="$uc_out"
  export OD_MODE OD_DIR OD_SRC OD_OUT
  if command -v bun >/dev/null 2>&1; then
    bun -e "$JSON_JS" || return $?
  elif command -v node >/dev/null 2>&1; then
    node -e "$JSON_JS" || return $?
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "$JSON_PY" || return $?
  else
    return 4
  fi
  return 0
}

backup_and_replace() {
  br_tmp="$1"
  br_stamp=$(date +%Y%m%d%H%M%S)
  if [ -f "$cli_json" ]; then
    cp "$cli_json" "$cli_json.bak-$br_stamp"
    echo "backup: $cli_json.bak-$br_stamp"
  fi
  mv "$br_tmp" "$cli_json"
}

manual_instructions() {
  echo "error: could not update $cli_json automatically" >&2
  echo "install bun, node or python3, or add this entry to the \"plugins\" array by hand:" >&2
  echo "" >&2
  echo "  \"$plugin_path\"" >&2
  echo "" >&2
  echo "file: $cli_json" >&2
}

config_dir=$(find_config_dir)
[ -n "$config_dir" ] || die "could not determine the OpenCode config directory"
cli_json="$config_dir/cli.json"

if [ "$uninstall" -eq 1 ]; then
  if [ ! -f "$cli_json" ]; then
    echo "no $cli_json — nothing to remove"
  else
    plugin_path="$install_dir"
    if [ -d "$install_dir" ]; then
      plugin_path=$(cd "$install_dir" && pwd -P)
    fi
    tmp="$cli_json.tmp.$$"
    rc=0
    update_cli_json remove "$tmp" || rc=$?
    case "$rc" in
      0)
        backup_and_replace "$tmp"
        echo "removed $plugin_path from $cli_json"
        ;;
      3)
        rm -f "$tmp"
        echo "error: $cli_json is not valid JSON — fix it by hand, then retry" >&2
        exit 1
        ;;
      4)
        manual_instructions
        exit 1
        ;;
      *)
        rm -f "$tmp"
        echo "error: could not update $cli_json" >&2
        exit 1
        ;;
    esac
  fi

  if [ -d "$install_dir" ]; then
    do_delete=1
    if [ "$assume_yes" -ne 1 ]; then
      printf 'Delete %s? [y/N] ' "$install_dir"
      ans=""
      read -r ans || ans=""
      case "$ans" in
        y|Y|yes|YES) ;;
        *) do_delete=0 ;;
      esac
    fi
    if [ "$do_delete" -eq 1 ]; then
      rm -rf "$install_dir"
      echo "deleted $install_dir"
    else
      echo "kept $install_dir"
    fi
  fi

  echo "Restart OpenCode."
  exit 0
fi

command -v git >/dev/null 2>&1 || die "git is required — install git and re-run"
if [ "$dev" -eq 1 ]; then
  command -v bun >/dev/null 2>&1 || die "bun is required with --dev — install it from https://bun.sh then re-run"
fi

if [ -d "$install_dir/.git" ]; then
  echo "updating $install_dir"
  git -C "$install_dir" fetch --tags --prune origin
  git -C "$install_dir" checkout "$ref"
  if git -C "$install_dir" symbolic-ref -q HEAD >/dev/null 2>&1; then
    git -C "$install_dir" pull --ff-only
  fi
elif [ -e "$install_dir" ]; then
  die "$install_dir exists but is not a git checkout"
else
  echo "cloning $repo into $install_dir"
  mkdir -p "$(dirname "$install_dir")"
  git clone "$repo" "$install_dir"
  git -C "$install_dir" checkout "$ref"
fi

if [ "$dev" -eq 1 ]; then
  ( cd "$install_dir" && bun install && bun run bundle )
fi

[ -f "$install_dir/dist/index.js" ] || die "$install_dir/dist/index.js is missing — re-run with --dev to build it"

plugin_path=$(cd "$install_dir" && pwd -P)
mkdir -p "$config_dir"

tmp="$cli_json.tmp.$$"
rc=0
update_cli_json add "$tmp" || rc=$?
case "$rc" in
  0)
    backup_and_replace "$tmp"
    echo "added $plugin_path to $cli_json"
    ;;
  3)
    rm -f "$tmp"
    echo "error: $cli_json is not valid JSON — fix it by hand, then retry" >&2
    exit 1
    ;;
  4)
    rm -f "$tmp"
    manual_instructions
    exit 1
    ;;
  *)
    rm -f "$tmp"
    echo "error: could not update $cli_json" >&2
    exit 1
    ;;
esac

echo "Restart OpenCode, then type /opendeck"

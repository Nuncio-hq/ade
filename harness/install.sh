#!/usr/bin/env bash
# Promote graduated harness extensions into the shared pi global agent dir
# (~/.pi/agent/extensions) as SYMLINKS, so the repo stays the single source of
# truth. Dev/testing happens project-local (.pi/extensions); only promote an
# extension once it works in ADE (and degrades sanely in plain pi TUI).
#
# Usage:
#   ./install.sh list                 # show promoted vs available extensions
#   ./install.sh add <name>...        # symlink extension(s) into the global dir
#   ./install.sh remove <name>...     # remove the global symlink(s)
set -Eeuo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
EXTENSIONS_DIR="${HARNESS_DIR}/extensions"
GLOBAL_DIR="${PI_AGENT_DIR:-${HOME}/.pi/agent}/extensions"

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

available() { find "${EXTENSIONS_DIR}" -mindepth 1 -maxdepth 1 \( -type d -o -name '*.ts' \) -exec basename {} \; | sort; }

cmd="${1:-list}"
shift || true

case "${cmd}" in
  list)
    echo "Global dir: ${GLOBAL_DIR}"
    for name in $(available); do
      target="${GLOBAL_DIR}/${name}"
      if [[ -L "${target}" && "$(readlink "${target}")" == "${EXTENSIONS_DIR}/${name}" ]]; then
        echo "  [promoted] ${name}"
      elif [[ -e "${target}" ]]; then
        echo "  [CONFLICT] ${name} (exists in global dir but is not our symlink)"
      else
        echo "  [local]    ${name}"
      fi
    done
    ;;
  add)
    [[ $# -ge 1 ]] || { usage; exit 1; }
    mkdir -p "${GLOBAL_DIR}"
    for name in "$@"; do
      src="${EXTENSIONS_DIR}/${name}"
      target="${GLOBAL_DIR}/${name}"
      [[ -e "${src}" ]] || { echo "No such extension: ${name}" >&2; exit 1; }
      if [[ -e "${target}" && ! -L "${target}" ]]; then
        echo "Refusing to replace non-symlink: ${target}" >&2
        exit 1
      fi
      ln -sfn "${src}" "${target}"
      echo "Promoted ${name} -> ${target}"
    done
    echo "Note: running pi sessions need /reload (or a new session) to pick this up."
    ;;
  remove)
    [[ $# -ge 1 ]] || { usage; exit 1; }
    for name in "$@"; do
      target="${GLOBAL_DIR}/${name}"
      if [[ -L "${target}" ]]; then
        rm "${target}"
        echo "Removed ${name}"
      else
        echo "Skip ${name}: not a promoted symlink" >&2
      fi
    done
    ;;
  *)
    usage
    exit 1
    ;;
esac

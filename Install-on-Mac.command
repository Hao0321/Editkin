#!/bin/bash
# Finder entry point. Dependency installation is described in docs/MACOS.md.
editkin_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
/bin/bash "$editkin_directory/scripts/install-macos-community.sh" "$@"
editkin_status=$?
if [ -t 0 ]; then
  printf '\nPress Return to close this window.\n'
  read -r editkin_reply
fi
exit "$editkin_status"

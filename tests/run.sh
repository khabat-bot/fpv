#!/usr/bin/env bash
# Run the whole test suite (or one half).
#   ./tests/run.sh        everything
#   ./tests/run.sh js     browser modules only (node --test)
#   ./tests/run.sh py     server only (python -m unittest)
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-all}" in
  js)
    shift || true
    exec node --test tests/js "$@"
    ;;
  py)
    shift || true
    exec python3 -m unittest discover -s tests/python -p 'test_*.py' -v "$@"
    ;;
  all|"")
    python3 -m unittest discover -s tests/python -p 'test_*.py'
    node --test tests/js
    ;;
  *)
    echo "usage: $0 [all|js|py]" >&2
    exit 2
    ;;
esac

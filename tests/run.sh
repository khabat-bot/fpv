#!/usr/bin/env bash
# Run the whole test suite (or one half).
#   ./tests/run.sh        everything
#   ./tests/run.sh js     browser modules only (node --test)
#   ./tests/run.sh py     server only (python -m unittest)
set -euo pipefail
cd "$(dirname "$0")/.."

# `node --test tests/js` only resolves a directory on Node >= 22; passing the
# test files explicitly works on 18, 20 and 22+ alike.
js_tests() {
  shopt -s nullglob
  local files=(tests/js/*.test.js)
  if [ ${#files[@]} -eq 0 ]; then
    echo "no JS tests found in tests/js" >&2
    return 1
  fi
  node --test "${files[@]}" "$@"
}

case "${1:-all}" in
  js)
    shift || true
    js_tests "$@"
    ;;
  py)
    shift || true
    exec python3 -m unittest discover -s tests/python -p 'test_*.py' -v "$@"
    ;;
  all|"")
    python3 -m unittest discover -s tests/python -p 'test_*.py'
    js_tests
    ;;
  *)
    echo "usage: $0 [all|js|py]" >&2
    exit 2
    ;;
esac

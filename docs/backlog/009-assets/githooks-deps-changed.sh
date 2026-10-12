#!/bin/sh
# Shared by post-merge and post-checkout: npm install when the dependency manifests changed.
# $1 $2 = old and new commit.
old="$1"; new="$2"
[ "$old" = "$new" ] && exit 0
case "$old" in 0000000000000000000000000000000000000000) exit 0;; esac  # fresh clone: dev runs npm ci
if git diff --quiet "$old" "$new" -- package.json package-lock.json 'packages/*/package.json'; then exit 0; fi
echo "[git hook] dependency manifests changed ($old..$new): npm install" >&2
start=$(date +%s)
npm install --no-audit --no-fund || { echo "[git hook] npm install FAILED - run it by hand" >&2; exit 0; }
echo "[git hook] npm install done in $(( $(date +%s) - start ))s" >&2

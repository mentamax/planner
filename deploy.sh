#!/bin/sh
# Planner をインターネット上（GitHub Pages）に公開する。
#
#   sh deploy.sh
#
# main ブランチにコード全体を送り、web フォルダの中身だけを gh-pages ブランチに置く。
# GitHub Pages は gh-pages ブランチを配信する。先に変更をコミットしておくこと。
set -e
cd "$(dirname "$0")"

if [ -n "$(git status --porcelain)" ]; then
  echo "コミットしていない変更があります。先に git commit してください。" >&2
  exit 1
fi

git push origin main
# web フォルダの内容だけを 1 つのコミットにして、gh-pages ブランチを置き換える
site=$(git commit-tree "HEAD:web" -m "Deploy $(git rev-parse --short HEAD)")
git push --force origin "$site:refs/heads/gh-pages"
echo "公開しました（反映まで 1〜2 分かかることがあります）"

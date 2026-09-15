#!/bin/zsh
set -e
cd -- "${0:A:h}"
if command -v node >/dev/null 2>&1; then
  exec node scripts/open-console.mjs
fi
for dustoff_node in "$HOME"/.nvm/versions/node/*/bin/node(NOn) /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$dustoff_node" ]]; then
    export PATH="${dustoff_node:h}:$PATH"
    exec "$dustoff_node" scripts/open-console.mjs
  fi
done
print '未找到 Node.js，请先安装 Node.js 22 或更新版本。'
read '?按回车关闭。'

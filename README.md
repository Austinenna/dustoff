# dustoff

给吃灰的收藏夹掸掸灰：读取抖音新收藏，保存视频和图集，或通过语音转写整理为知识笔记。

## 环境定位

- **Linux 服务器：生产环境。** 正式账本、媒体、笔记、账号连接与自动整理在服务器运行，通过 HTTPS 密码认证的网页访问。
- **本机：开发环境。** 修改代码、运行隔离测试、维护文档和提交。提交或推送不自动部署生产。
- 本机历史资料目录中的 `server.json` 是生产网页入口和防重复运行标记。原 `打开控制台.command` 是生产网页快捷入口，不是开发服务启动器。

## 核心流程

扫描收藏 → SQLite 基线与待办 → 判断用途 → 保存视频/图集，或转写并生成 Markdown 笔记。

网页可以阅读笔记与格式化转写、播放视频、浏览图集、确认用途、查看运行记录、管理定时，并远程完成抖音扫码和后续验证。Linux 使用 systemd 用户服务和 timer；macOS 开发兼容 launchd，开发默认关闭自动安排。

## 依赖

- Node.js 24 系列：内置 SQLite、Fetch、WebSocket；无 npm 运行依赖。
- Chrome：抖音登录和收藏采集。
- FFmpeg / ffprobe、`file`：媒体验证、音频处理及播放预览。
- Python 3：迁移工具和迁移测试。
- Linux 远程有界面登录另需 Xvfb 与中文字体；公网由 HTTPS 反向代理保护，Node 只监听回环。

## 本机开发

使用独立开发目录，所有输出都放在其中；不要复制生产凭据或真实数据库作为默认测试环境：

```sh
DUST_HOME="$HOME/.dustoff-dev" \
DUST_MEDIA="$HOME/.dustoff-dev/media" \
DUST_SAVED_MEDIA="$HOME/.dustoff-dev/saved-media" \
DUST_TEXT="$HOME/.dustoff-dev/text" \
DUST_NOTES="$HOME/.dustoff-dev/notes" \
DUST_PROFILE="$HOME/.dustoff-dev/chrome-profile" \
DUST_PUBLIC_URL= DUST_SERVER_MODE=0 DUST_REMOTE_LOGIN=0 \
DUST_AUTO_SCHEDULE=0 DUST_NOTIFY=0 \
node console.mjs --port 47832
```

访问 `http://127.0.0.1:47832/`。需要开发配置时使用独立目录中的 `dustoff.conf`，不要修改停用的历史生产资料。接入真实账号和模型属于独立联调工作，先明确范围。

## 验证

```sh
DUST_HOME="$HOME/.dustoff-dev" DUST_NOTIFY=0 node --test tests/*.test.mjs
python3 tests/migrate-data.test.py
git diff --check
```

测试使用临时目录和 `tests/fixtures/` 中的虚构固定文本，不依赖私有文档或生产数据。系统集成用例按平台或显式开关执行。

## 文档与发布

`docs/` 是本地私有文档目录，不纳入 Git；编辑器 `*.code-workspace` 也只留本机，程序不读取它。

本机文档入口：

- `docs/环境定位与开发指南.md`
- `docs/Linux部署与完整迁移-2026-10-28.md`
- `docs/生产服务器迁移与扩容操作指南.md`

这些资料不随源码克隆。生产地址、凭据和真实数据只保留在私有运维记录中。生产部署或服务器迁移需要明确安排；当前没有推送后自动部署的工作流。

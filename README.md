# dsh-island

给 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面端用的**桌面级「灵动岛」**：一块常驻在操作系统桌面上、永远置顶的小胶囊，实时告诉你当前会话在干什么——即使 DSH 被别的窗口盖住了，它仍然浮在最上层。

![深色](docs/preview-dark.png)

![浅色](docs/preview-light.png)

```
 ◉ 正在工作 · 执行命令  讨论插件实现细节 │ 第 53 步 · 161.8k   6:55
```

一整行：状态灯、相位、当前工具、会话标题、步数 · token、耗时。窗口高 52 逻辑像素，宽度随文字自动伸缩（220–760），不会出现半截省略号。

## 目录

```
dsh-island/              插件包（装进 DSH profile 的那一半）
  index.js               宿主半身：订阅事件、折叠状态、起本地 HTTP、拉起窗口进程
  package.json
  cordis.patch.yml
dsh-island-desktop/      桌面窗口（被影子 Electron 树当作 resources/app 加载）
  main.js                BrowserWindow、置顶、吸附、位置持久化、IPC
  index.html             单行 UI + 轮询 + 宽度测量
  preload.js             contextBridge 暴露的窄接口
tools/                   影子树构建脚本 + 开发期用的小工具
docs/                    截图
```

## 为什么是两半

DSH 桌面端把插件跑在一个普通 Node 子进程里（`@deepseek-ai/dsh-desktop-host`），那个进程里**没有 `electron` 模块**，插件不能自己 `new BrowserWindow`。

所以拆成两半：

| 半身 | 位置 | 职责 |
| --- | --- | --- |
| 宿主半身 | `dsh-island/index.js` | 订阅会话事件、折叠成一份小状态、用 `127.0.0.1` 上的 HTTP 吐出去、把窗口进程抱起来 |
| 浮窗 | `dsh-island-desktop/` | 真正的 Electron 窗口：无边框、透明、置顶、可拖拽、每 400ms 拉一次状态 |

浮窗用的 Electron **不是下载的**：`tools/make-island-host.ps1` 把 DSH 自带的二进制硬链接成一套「影子可执行树」，再把它的 `resources\app` 指向本仓库，所以改 `index.html` 下次启动就生效，不需要打包。

## 安装

前置：DSH 桌面端已安装（需要它自带的 `DeepSeek Harness.exe`），Windows 10/11，Node 侧无需额外依赖。

```powershell
# 1) 建影子树（自动找 DSH 安装目录；找不到就显式传 -Src）
powershell -ExecutionPolicy Bypass -File tools\make-island-host.ps1 -Src "C:\Path\To\DshInstall"

# 2) 把影子树的 resources\app 指到本仓库的窗口目录
$dst = Join-Path $env:LOCALAPPDATA 'dsh-island-win'
cmd /c rmdir "$dst\resources\app"
cmd /c mklink /J "$dst\resources\app" "<repo>\dsh-island-desktop"

# 3) 在 DSH 里安装插件包
#    plugin_manager  install_bundle  target = <repo>\dsh-island
```

装完重启一次 DSH。宿主半身会用 `%LOCALAPPDATA%\dsh-island-win\dsh-island.exe` 启动窗口；想换位置就设环境变量 `DSH_ISLAND_EXE`。

## 状态从哪来

| 事件 | 用来更新 |
| --- | --- |
| `user/message` | 新回合开始，抢占焦点，清零计数 |
| `turn/start`、`step/start` | 相位 → working，开始计时 |
| `tool/call`、`tool/result` | 当前工具名、步数 |
| `assistant/message` | token 用量 |
| `agent/assistant-stream` | 推理 / 正文 / 调工具 → 思考中 · 输出中 · 准备工具 |
| `turn/end`、`turn/stopped` | 相位 → done（保持 20 秒后回 idle） |
| `api-session/status`、`agent/status` | running 标记 |
| `approval/request`、`user-questions/request`、`agent/error` | 等你批准 / 等你回答 / 出错了 |

多会话各自记账，同一时刻只有一条占着胶囊：**等待交互 > 正在跑的当前会话 > 最近的根会话 > 最近活跃**。

## 交互

- **单击 / 双击**：把 DSH 主窗口拽到前台（`AppActivate` + `ShowWindow(9)` + `SetForegroundWindow`）
- **拖动**：页面里自己实现（`pointerdown/move/up` + IPC），因为 `-webkit-app-region: drag` 会把鼠标事件整块吞掉
- **边缘吸附**：松手时离任一边 ≤ 20 DIP 就贴齐；拖到屏幕外会被夹回来
- **右键菜单**：跟随系统 / 浅色 / 深色、位置复位、回到 DSH、重新加载
- 位置与主题记在 `%APPDATA%\DSH Island\`

## 本地端点

宿主半身在 `127.0.0.1:<随机端口>` 上只开三个只读路由：

- `GET /state` — 胶囊渲染用的那份 JSON
- `GET /health` — `{"ok":true,...}`
- `GET /debug` — 会话记账、焦点选择、agent 列表（它撒谎时用来自证）

## 已知缺陷与限制

写在这，是因为它确实有这些毛病，不打算粉饰：

1. **只支持 Windows。** 硬链接、`mklink`、`AppActivate`、`ShowWindow` 全是 Windows 专有；macOS / Linux 完全跑不起来。
2. **强依赖 DSH 自带的 Electron。** DSH 升级或重装后，影子树里的硬链接指向会被替换/删除，必须重跑 `make-island-host.ps1`；而且影子树和 DSH 安装目录**必须在同一个盘符**（硬链接不能跨卷）。
3. **`ELECTRON_RUN_AS_NODE` 是个脆点。** 宿主子进程的环境里带着这个变量，spawn 窗口前必须删掉，否则 Electron 退化成 Node，直接 `bad option: --feed` 秒退。上游哪天换个启动方式，这里就会断。
4. **轮询，不是推送。** 窗口每 400ms 拉一次状态，加上宿主侧缓存，肉眼可见约 0.3–0.5 秒的滞后；状态变化快的时候（连续工具调用）会跳过中间态。
5. **状态是启发式折叠。** 多会话靠「等待优先 + 最近活跃」选焦点，可能选到你不在看的那个；`done` 保持 20 秒是拍脑袋常数；`STALE_RUNNING_MS` 10 分钟也是。
6. **工具名映射不全。** 常见工具做了中文名，其余回落成原始工具名（去掉 `ops_` / `dsh_` 前缀），会出现英文。
7. **token 数会滞后。** 来自 `assistant/message` 的 usage，流式过程中只增不减地跳，不走精确计费。
8. **宽度自适应有跳动。** 每次渲染把整行克隆到屏幕外的量尺里测一次，宽度变化带 90ms 防抖；内容长度剧烈变化时能看到一次跳变。
9. **卡片外那圈 6px 透明边也吃鼠标。** 窗口矩形内的点击都被窗口接收，不是真正的 click-through。
10. **单实例锁。** 如果上一次的窗口进程残留，新进程会立刻退出——表现为「岛没了」，需要手动结束 `dsh-island.exe`。
11. **本地 HTTP 没有鉴权。** 只监听 `127.0.0.1` 且端口随机、只读，但同机任何进程都能读到你的会话标题和目录。
12. **没有安装器。** 影子树、junction、插件安装三步全手动；换机器要重来一遍。
13. **文案硬编码。** 中英文写死在宿主里，没接 DSH 的多语言服务。
14. **只在一种环境下验证过。** Windows 11、125% 缩放、单屏 2560×1440；多显示器混插不同 DPI、远程桌面、HDR、以及关闭硬件加速的各种组合都没测。
15. **明细面板已经砍掉。** 早期版本单击会展开 cwd / 轮次 / 子会话，现在只有一行——想看的话得改回来。

## 安全说明

- 窗口只加载本地文件，CSP 把 `connect-src` 限死在 `http://127.0.0.1:*`，不联网、不埋点。
- 宿主半身不写任何文件到仓库外，只读 `%APPDATA%\DSH Island\` 里的位置与主题。
- HTTP 端点只读、只本机、随机端口。

## License

MIT

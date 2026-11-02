# dsh-island（插件包 · 宿主半身）

这个目录就是装进 DSH 的那半边：一个 Cordis 插件，负责**收集状态**、**吐出一份 JSON**、**维持窗口进程**。

完整的说明（架构、安装、端点、已知缺陷）在仓库根目录的 `README.md`，这里只记这个包自己的事。

## 它做什么

1. 订阅宿主事件（`user/message`、`turn/start`、`tool/call`、`agent/assistant-stream`、`approval/request`……），按 sessionId 记一本账；
2. 选出一个「焦点会话」，折叠成一份只有十几个字段的快照；
3. 在 `127.0.0.1` 的随机端口上开 HTTP，`GET /state` 给窗口轮询，`GET /health` 探活，`GET /debug` 自证；
4. `spawn` 影子树里的 `dsh-island.exe --feed=<url>`，插件停用时把子进程杀掉。

## 安装

```text
plugin_manager  install_bundle  target = <repo>\dsh-island
```

装之前先把窗口那半边准备好（影子 Electron 树 + `resources\app` junction），见仓库根目录 README 的「安装」一节。

## 可配的环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_ISLAND_EXE` | 窗口可执行文件的路径；默认 `%LOCALAPPDATA%\dsh-island-win\dsh-island.exe` |

## 注意

- 宿主进程里**没有 `electron` 模块**，所以这个包不会创建任何窗口，只拉起外部进程。
- 读宿主服务一律走 `ctx.get(name)`；直接 `ctx.sessionTitle` 这类写法会抛 `cannot get property ... without inject`。
- 本包没有 config schema，`Config.listConfigs` 里显示 `status: "absent"` 是正常现象。

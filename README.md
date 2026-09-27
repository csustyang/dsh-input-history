# dsh-input-history

DSH web 会话输入框的 Claude Code 式输入历史：**按 ↑ / ↓ 找回你发过的消息**。

## 功能

- **↑**：输入框为空时召回最近一条已发送消息；继续按 ↑ 逐条回溯更早的消息
- **↓**：逐条回到较新的消息；翻过最新一条恢复你按 ↑ 之前的草稿
- **Esc**：退出浏览，恢复草稿
- 发送成功后浏览状态自动复位
- **按会话隔离**：每个会话召回自己的消息，互不串扰（v0.4.0，以 DSH 会话 ID 为键——会话根节点 `data-conversation-session`，改名/重名不影响；无会话打开时不记录不召回；存于浏览器 localStorage，上限每会话 100 条，连续重复去重；v0.3.0 标题键数据不迁移，激活时自动清除），重启浏览器不丢失
- 纯客户端行为插件：无 host 路由、无 UI 插槽、模型全程不可见

## 不劫持的按键（安全边界）

- 输入框**非空**时 ↑↓ 保持原生光标移动（多行编辑不受影响）
- 斜杠命令菜单 / 弹窗打开时 ↑↓ 归菜单导航
- 中文输入法组合期间（isComposing / keyCode 229 / compositionend 后 10ms）全部放行
- Alt/Ctrl/Meta 组合键不放行

## 工作原理（DSH 0.1.5-rc.1；已在 0.1.7-rc.2 复验：composer DOM 属性与 keymap 放行行为未变）

- 输入框 = ui-conversation 的 Lexical composer（`[data-composer-input]`），按键集中在 `editor/keymap.ts`
- 发送捕获：Enter（capture 阶段——Lexical 提交会同步清空 composer，bubble 层读不到文本）+ 发送按钮 pointerdown 兜底；MutationObserver + 600ms 定时器确认「composer 清空 = 发送成功」后入史
- 回填：合成 paste 事件走 DSH keymap 的 PASTE 处理（官方清洗通道），清空走合成 Backspace；均延后一拍等 Lexical selection 同步
- 导航钩子：Lexical keymap 在菜单关闭时对 ArrowUp/Down「放行」（不 preventDefault），插件在 document bubble 接住该放行事件

## 安装

```bash
# Windows
dsh plugin --profile web add -w link:C:\workspace\github\dsh-input-history
# macOS（源码 clone 到任意长久目录，替换为实际绝对路径）
dsh plugin --profile web add -w link:/Users/you/Documents/study/dsh-input-history
```

> `-w` 是转发给 pnpm 的：web profile 目录本身就是 pnpm workspace root，`pnpm add` 默认拒绝往 root 写依赖（报 `ERR_PNPM_ADDING_TO_ROOT`）。不想每次带 `-w`，在 profile 目录（`~/.dsh/profiles/web/`）的 `.npmrc` 里加一行 `ignore-workspace-root-check=true` 即可——`dsh plugin add` 本来就只指向 profile root，这个守卫在该目录没有保护意义。

安装完成后**必须重启 DSH 宿主**（组合树在启动时构建，首次安装不重启不生效），再硬刷新浏览器页面（Windows Ctrl+F5 / macOS Cmd+Shift+R）。

## 更新（改 src/client.js 后）

```bash
cd <插件源码目录>   # 例：~/Documents/study/dsh-input-history
node build.mjs
```

刷新浏览器页面即可（host 会热更新 bundle rev）；改 host 侧文件才需要重启 DSH。

## 卸载

```bash
dsh plugin --profile web remove dsh-input-history
```

## 已知边界（v0.3.0）

- 切换会话（含未分组会话）时自动退出浏览态，↑ 从最新一条重新开始（v0.4.0 起以会话 ID 变化为切换信号，不再依赖 document.title，自动改题/手动改名都不再打断）
- 按钮发送的捕获依赖「composer 随后清空」的判定，600ms 内手动改写内容可能误判
- 全新会话的首条消息依赖发送后 600ms 内会话根节点挂出 `data-conversation-session`，未挂出则该条不入史（后续消息正常）
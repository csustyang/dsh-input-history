# dsh-input-history

DSH web 会话输入框的 Claude Code 式输入历史：**按 ↑ / ↓ 找回你发过的消息**。

## 功能

- **↑**：输入框为空时召回最近一条已发送消息；继续按 ↑ 逐条回溯更早的消息
- **↓**：逐条回到较新的消息；翻过最新一条恢复你按 ↑ 之前的草稿
- **Esc**：退出浏览，恢复草稿
- 发送成功后浏览状态自动复位
- **按会话隔离**：每个会话召回自己的消息，互不串扰（v0.3.0，以会话标题为键，存于浏览器 localStorage，上限每会话 100 条，连续重复去重），重启浏览器不丢失
- 纯客户端行为插件：无 host 路由、无 UI 插槽、模型全程不可见

## 不劫持的按键（安全边界）

- 输入框**非空**时 ↑↓ 保持原生光标移动（多行编辑不受影响）
- 斜杠命令菜单 / 弹窗打开时 ↑↓ 归菜单导航
- 中文输入法组合期间（isComposing / keyCode 229 / compositionend 后 10ms）全部放行
- Alt/Ctrl/Meta 组合键不放行

## 工作原理（DSH 0.1.5-rc.1）

- 输入框 = ui-conversation 的 Lexical composer（`[data-composer-input]`），按键集中在 `editor/keymap.ts`
- 发送捕获：Enter（capture 阶段——Lexical 提交会同步清空 composer，bubble 层读不到文本）+ 发送按钮 pointerdown 兜底；MutationObserver + 600ms 定时器确认「composer 清空 = 发送成功」后入史
- 回填：合成 paste 事件走 DSH keymap 的 PASTE 处理（官方清洗通道），清空走合成 Backspace；均延后一拍等 Lexical selection 同步
- 导航钩子：Lexical keymap 在菜单关闭时对 ArrowUp/Down「放行」（不 preventDefault），插件在 document bubble 接住该放行事件

## 安装

```bash
dsh plugin --profile web add link:C:\workspace\github\dsh-input-history
```

然后重启 DSH 并刷新浏览器页面（Ctrl+F5）。

## 更新（改 src/client.js 后）

```bash
cd C:\workspace\github\dsh-input-history
node build.mjs
```

刷新浏览器页面即可（host 会热更新 bundle rev）；改 host 侧文件才需要重启 DSH。

## 卸载

```bash
dsh plugin --profile web remove dsh-input-history
```

## 已知边界（v0.2.0）

- 会话改名后，改名前的历史不会跟随（键基于会话标题）
- 切换会话（含未分组会话）时自动退出浏览态，↑ 从最新一条重新开始（v0.2.1）
- 按钮发送的捕获依赖「composer 随后清空」的判定，600ms 内手动改写内容可能误判
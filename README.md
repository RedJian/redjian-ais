# 红笺-群问AI（Electron）

一次提问，**多个 AI 同时作答**。默认是 DeepSeek / 豆包 / 千问，左侧设置里还能加入 **Kimi、元宝、智谱、文心**，或填任意网页版 AI 的地址。

所有内容都在**一个窗口**里：左边是可折叠面板栏，中间是 AI 面板网格（**每行最多 3 个，超出自动翻页**，最多 9 个），右边是作者博客栏，底部统一输入框支持**文字 + 直接粘贴截图**，回车即把同一份内容分别填进各栏并发送。整体是「液态玻璃」视觉：半透明面板 + 背景柔光 + 模糊与高光描边。

## 运行

```bash
npm install
npm start
```

> 国内网络下载 Electron 二进制较慢或失败时，可先设置镜像再安装：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`
>
> 如果 `npm start` 报 `Cannot read properties of undefined (reading 'on')`（ipcMain 未定义），说明当前终端里存在 `ELECTRON_RUN_AS_NODE=1`，Electron 被当成 Node 执行了。先 `unset ELECTRON_RUN_AS_NODE`（PowerShell：`Remove-Item Env:ELECTRON_RUN_AS_NODE`）再启动即可。

窗口默认占工作区的 96%×94%（上限 1780×1040，最小 1120×660），居中打开。每栏使用独立的 `persist:<key>` 分区（内置模型固定为 `ai-slot-1…7`），可以分别登录不同账号，Cookie 互不干扰，重启后登录态保留，**删掉某栏再加回来也不用重新登录**。

界面上的面板增删、顺序、侧栏折叠状态都会写进 `%APPDATA%\ai-compare-ask\settings.json`，重启后原样恢复。

## 打包成便携版（单文件 exe）

```bash
npm install      # 已有 node_modules 可跳过
npm run dist     # 先产出 dist/win-unpacked，再用 NSIS 压成单文件
```

产物：`dist/AI-Compare-Portable-<版本>.exe`（当前约 103 MB）。

- **免安装**：不需要管理员权限，不写注册表、不建快捷方式，双击即用。
- **可携带**：拷到另一台 Windows 10/11（x64）就能跑，目标机不需要装 Node 或 Electron。
- **启动**：首次会把运行时解压到 `%TEMP%\AI-Compare-runtime-<版本>`（约 300 MB，几秒），之后复用缓存所以更快；升级版本会自动清掉旧缓存。
- **数据目录**：exe 同级的 `AI-Compare-Data`，登录态、Cookie、面板配置都在里面。想把登录态一起带走，就把 exe 和这个文件夹一起拷；只想在别的机器上跑、不带数据，只拷 exe 即可。
- 如果 exe 放在不可写的位置（只读盘、`Program Files`），会自动回退到 `%APPDATA%\ai-compare-ask`，功能不受影响，只是不再「便携」。
- **卸载**：删掉 exe 和 `AI-Compare-Data`；想彻底清干净再删 `%TEMP%\AI-Compare-runtime-*`。

### 体积精简方案

Electron 完整运行时约 350 MB，本项目做了三层压缩/裁剪，最终单文件约 103 MB（压缩率约 34%）：

1. **运行时裁剪**（`scripts/trim-dist.js`，挂 `afterPack`）：55 个语言包只留 `zh-CN` / `en-US`（省约 48 MB）、删 `LICENSES.chromium.html`（5.7 MB）。**刻意保留所有 DLL**（`dxcompiler` / `vulkan` / `vk_swiftshader` / `d3dcompiler`）——它们是无独显、远程桌面等场景的软件渲染兜底，删掉会导致「渲染进程崩溃」，所以体积让位于兼容性。
2. **asar 最高压缩**：`build.compression` 设为 `maximum`。
3. **NSIS 固体 LZMA 压缩**：`portable.nsi` 的 `SetCompressor /SOLID lzma`，把 250 MB 的 `electron.exe` 压到约 90 MB。

> 注意：`electron.exe` 本身约 250 MB，是体积的绝对大头，无法靠删文件减小，只能靠 NSIS LZMA 压缩。因此单文件 exe 的「地板」大约在 90~100 MB 量级，再往下就要换成 Electron 之外的技术栈。

打包相关文件：

| 路径 | 作用 |
| --- | --- |
| `build/icon.ico`、`build/icon.png` | 图标，`npm run icon` 可重新生成 |
| `scripts/portable.nsi` | 启动器脚本：解压运行时、设置 `PORTABLE_EXECUTABLE_DIR`、拉起应用 |
| `scripts/build-portable.js` | 调 `makensis` 编译：自动找工具链、补 UTF-8 BOM、打印产物大小 |
| `scripts/trim-dist.js` | `afterPack` 钩子：裁剪 locales / 许可文本，极致精简运行时 |
| `scripts/make-icon.py` | 纯 Python 画图标（渐变圆角方块 + 三根竖条，对应多栏对比） |

几点说明：

- exe **没有代码签名**，首次运行 Windows SmartScreen 可能提示「已保护你的电脑」——点「更多信息 → 仍要运行」即可；个别杀软可能对自解压包误报。
- 打包**不改任何业务逻辑**：`main.js` 里只多了一段「检测到便携启动器就把 userData 放到 exe 旁边」的路径判断，其余代码与开发运行完全一致。
- 构建机需要 NSIS 3.x：优先用 electron-builder 缓存里的那份；没有缓存时装一个 NSIS，或用 `NSIS_HOME` 指定目录。
- 改版本号只需要改 `package.json` 的 `version`，产物文件名和 `%TEMP%` 里的运行时目录都会跟着变。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `main.js` | 主进程：创建无边框主窗口、自绘窗口按钮的 IPC（最小化/最大化/关闭）、固定 userData 目录、维护模型库与面板配置（`settings.json` 读写）、转发 `broadcast-prompt` → `receive-prompt`、打开博客外链、给每个分区设 Chrome UA、放行站内登录弹窗 |
| `preload.js` | 通过 `contextBridge` 暴露 `broadcastPrompt()` / `onPrompt()` / `getConfig()` / `saveConfig()` / `openExternal()` / `windowControls` |
| `index.html` | 界面骨架：自绘标题栏（红绿灯）+ 左侧面板栏（含博客入口）+ 面板网格 + 设置抽屉 + 教程浮层 + 单栏模板 + 底部输入框，液态玻璃样式内联 |
| `renderer.js` | 渲染进程：面板增删排序、侧栏与设置抽屉、输入框与图片处理、**注入脚本 `injectedMain()`** |
| `assets/` | 静态资源：`sidebar-bg.png`（左侧栏背景图），打包时由 `package.json` 的 `build.files` 一起带上 |
| `package.json` | `start` / `pack` / `dist` 脚本与 electron-builder 配置 |
| `scripts/` | 便携版打包脚本与图标生成脚本 |
| `dist/` | 打包产物（`win-unpacked` 文件夹版 + 单文件便携 exe） |

## 工作流程

```
底部统一输入框（文字 / 图片）
        │ broadcast-prompt
        ▼
      主进程 ── BrowserWindow.getAllWindows() 转发 ──▶ 本窗口
        │
        ▼  receive-prompt
   renderer.runPrompt()
        │
        ├─ 阶段一 prepare：三栏并行，只把文字/图片填进各自的输入框，
        │                  并等发送按钮变成可用状态（不点发送）
        │
        └─ 阶段二 send：全部就绪后，同一刻一起点发送
        │
        ▼
   三栏几乎同时发出，底部状态行显示：DeepSeek 已发送 · 豆包 已发送 · 千问 已发送
```

这样即使某栏图片上传慢一点，另外两栏也会等它，最终**三个问题的发出时间点是齐的**，不会出现「豆包已经答了一半，千问才刚开始」。只有一栏没就绪（比如停在登录页）时，另外两栏照常一起发。

整个流程由一条全局队列串起来：上一次「准备 + 发送」跑完才会处理下一次提问，连续快速回车不会把两次内容串车。三栏内部还各有一条串行队列，避免同一栏被并发注入。

## 侧栏与模型设置

左侧菜单栏可以收起（点标题右侧的 `«`），收起后只剩 64px 宽的图标条，每个模型显示成首字彩色头像，鼠标悬停看全名；再点 `»` 展开。折叠状态会自动记住。

「**AI 模型**」下面是当前启用的模型列表：每行是 首字徽标 + 名称 + 注入状态圆点 + **行尾的小垃圾桶**。

- 点行本身 → 翻到该模型所在的那一页并高亮；
- 点行尾垃圾桶 → **直接删掉这个模型**，不用进设置；删完底部会弹出「已移除 xxx」+「撤销」，5 秒内点撤销可原地恢复（登录态在分区里，加回来不用重新登录）；
- 只剩一个模型时垃圾桶不显示（至少保留一个）；
- 侧栏收起成图标条时不显示垃圾桶，展开后再删。

左侧栏底部是作者博客入口（**CSDN / GitHub / Gitee**，各带一个彩色首字徽标和 `↗` 外链标记，点击用系统浏览器打开），再往下是「使用教程」「免责声明」「退出所有账号」和「设置」。侧栏收起时，这些入口会变成一列图标徽标（C / GH / G / ? / 盾牌 / 退出 / ⚙），鼠标悬停看全名。

菜单栏里列出当前所有面板，点一项会在对应栏上闪一下高亮；底部是「设置」。设置抽屉分成三块：

- **已启用**：显示顺序即界面顺序，`↑` `↓` 调整位置，`✕` 从面板移除（和侧栏垃圾桶等效，登录态仍保留在分区里，同样可撤销）。至少保留一个。
- **模型库**：内置 DeepSeek / 豆包 / 千问 / Kimi / 元宝 / 智谱 / 文心，点一下加入；已加入的显示为「已加」。
- **自定义模型**：填名称 + 首页地址（如 `https://www.tongyi.com`）即可加入，地址会自动补 `https://`。

面板排列规则：**一页只放一行（最多 3 个），行高固定 = 面板区高度**。

| 面板数 | 结果 |
| --- | --- |
| 1 | 1 栏铺满，不出现翻页器 |
| 2 | 一行两栏 |
| 3 | 一行三栏 |
| 4~6 | 两页：第 1 页 3 个，第 2 页剩下的 |
| 7~9 | 三页：每页 3 个 |

关键是**面板变多不会压扁每栏**：行高始终等于面板区可视高度（`--row-h` 由 JS 写入），多出来的行排到下方，整块竖向滚动，每栏和只有 3 个时一样高。

翻页有三种方式：

1. **右侧滚动条**：多于一页时出现，拖动即翻页（一格正好一页）；
2. **滚轮**：把指针放在栏顶部的地址栏区域 / 栏与栏之间滚，整块会按页吸附滚动；
3. **底部状态行中间的 `‹ 1 / 2 ›`**：点箭头翻页，只有一页时自动隐藏。

> 滚轮在**网页内容区域内**会被网页自己吃掉（`<webview>` 是独立进程，滚轮先给网页），这时用滚动条或底部箭头最稳。

> 面板的**位置和宽度全部由 JS 计算后写成 `left / top / width / height`（绝对定位）**，增删、改顺序都只改样式，从不移动 DOM 节点——移动 `<webview>` 会让页面重新加载，聊天记录和滚动位置会全丢。滚动高度由面板区里的占位行撑出来，所以翻页、滚动条、滚轮吸附都和以前一样。在设置里加完模型后会自动翻到新栏所在页。

## 免责声明与首次使用教程

**首次启动的门槛顺序是固定的**：先弹出「免责声明」，勾选「我已阅读并同意上述全部条款」并点「同意并继续」之后，才会接着弹「使用教程」。

- 免责声明**强制阅读**：没有关闭按钮，`Esc` 和点遮罩都不会关掉，只有勾选后点「同意并继续」才能进入主界面；
- 同意状态记在 `settings.json` 的 `disclaimerAccepted` 字段，之后启动不再弹出；
- 想再看：点左侧栏底部的「免责声明」（盾牌图标），此时是**查看模式**——只显示「关闭」按钮，`Esc` 或点遮罩即可退出；
- 教程同样记在 `settings.json` 的 `onboarded` 字段，点「开始使用」关闭后不再自动弹，想再看点左侧栏底部的「使用教程」；
- 教程**不会点遮罩就消失**（避免误触），只能点「开始使用」或按 `Esc` 关闭；
- 两个浮层都用和主界面一致的玻璃卡片（毛玻璃 + 浅蓝/紫渐变 + 圆角），免责声明 `z-index` 高于教程，避免叠加。

免责声明正文在 `index.html` 的 `#disclaimer` 里（5 条），改文案直接改那里即可；开关逻辑在 `renderer.js` 的 `openDisclaimer / closeDisclaimer / acceptDisclaimer`。

## 左侧栏背景图

左侧栏底部铺了一张背景图（`assets/sidebar-bg.png`，就是「学习是一种信仰」那张），做法：

- `aside.sidebar` 里放一个纯装饰的 `<div class="sb-bg">`，`position: absolute; inset: 0`，不参与布局也不吃鼠标事件；
- 图片用 `background-size: 96% auto` 贴底、`inset: 0 0 calc(var(--sb-bottom-h) - var(--sb-bg-drop, 0px)) 0` 定位——`--sb-bottom-h` 由 `renderer.js` 的 `calibrateSidebarBackground()` 启动时测量 `.sb-blogs` + `.sb-foot` 实际高度写回（ResizeObserver 盯着更新），`--sb-bg-drop` 控制整体下移量（当前 40px，让书本停在博客上方一点）；窗口多高、模型多少个都不漂；`mix-blend-mode: multiply` 让白底自然融进玻璃、只留墨色；
- 整体 `opacity: 0.36`，顶部用 `mask-image` 淡入（0→22%），避免顶部「切一刀」；
- 侧栏收起成图标条时 `.sb-bg { opacity: 0 }`，图标区保持干净；
- 换成自己的图：直接替换 `assets/sidebar-bg.png`（竖图效果最好，白底或深色墨迹均可），需要更明显就调 `.sb-bg` 的 `opacity`。

## 一键退出所有账号

左侧栏「免责声明」下方新增「退出所有账号」（退出箭头图标）。它**不操作任何网页**，直接在主进程删除每个已启用面板分区（`persist:<key>`）的登录痕迹：

- 用 `session.clearData()` 清除 cookies / localStorage / indexedDB / serviceWorkers / webSQL / cache / fileSystems（比 `clearStorageData` 更彻底，cookies 一并清掉）；
- 每个分区的 storage 互相独立，删一个不影响其它分区和主窗口；
- 点入口先弹确认框（列出所有栏的名字），确认后清理，并把每一栏 `reload()` 回到未登录态；
- 主进程 IPC 是 `session:clear-all`（`preload.clearAllSessions()` → 主进程 `clearAllSessions()`）。

## 窗口与标题栏（无边框 + macOS 风格）

窗口不再使用 Windows 原生边框（`main.js` 里 `frame: false`），顶栏是页面里自绘的：

- **左上角三个圆点**（macOS 红绿灯）：红=关闭、黄=最小化、绿=最大化/还原。鼠标移到这一组上会浮出 `×` `–` `+` 符号；窗口失焦时三个点一起变灰。
- **整条顶栏都能拖动**窗口（`-webkit-app-region: drag`），只有三个圆点标了 `no-drag`，避免点按钮被当成拖窗口。
- 双击顶栏空白处 = 最大化 / 还原（Windows 对拖动区的默认行为）；窗口四边仍可拖拽缩放（`thickFrame: true` 保留了 `WS_THICKFRAME`），系统阴影和 Win11 圆角也保留。
- 标题居中显示「红笺-群问AI」，纯展示、不拦拖动；任务栏与 Alt+Tab 里的标题仍由主进程维护。
- 设置抽屉、首次教程的遮罩都从顶栏下方（40px）开始，所以**弹层打开时三个圆点依然可点**、窗口也还能拖。
- Alt+F4 照常可用。唯一少掉的是 Windows 11 悬停在最大化按钮上的「分屏布局」浮层——那是原生标题栏按钮才有的能力，自绘按钮拿不到。

链路：`index.html` 的 `.titlebar` → `renderer.js` 调 `window.aiBridge.windowControls` → `preload.js` → 主进程 `ipcMain.handle('window:*')` 操作真实窗口；窗口最大化 / 还原 / 聚焦变化再由主进程 `window:state` 推回来刷新样式。

## 动态分屏与沉浸模式

### 放大某一栏（沉浸模式）

- 鼠标移到某一栏上（工具栏那一行）时，工具栏最右边会浮出一个**放大**图标（四个角的展开符号）。
- 点一下：这一栏占 **80%** 宽，**同一行的另外两栏收成细条**——只剩彩色首字头像、竖排名字和一个 `↩`。
- 再点同一个按钮（此时是「收起」图标）、或点任意细条、或按 `Esc`，恢复原来的分栏比例。
- 细条里的网页不会被压到几十像素再撑回来：进入沉浸前会记下 webview 的实际宽高并用内联样式**钉住**，站点视角的尺寸没变，所以不会整页重排、聊天记录和滚动位置都保得住。
- 沉浸模式**只影响被放大那栏所在的那一行**，其它页的栏宽完全不动；此时不显示拖动条。

### 拖动缝隙调宽

- 栏与栏之间的 10px 缝隙里有一条隐形拖动条，鼠标移上去会浮出一段竖向高亮，按住拖动即可调宽。
- 拖动只改相邻两栏（一增一减，总宽不变），其它栏不受影响；每栏最少 220px。
- **双击缝隙**恢复三等分。
- 拖动只影响**本次运行**：关掉再打开会回到三等分（不会因为上次拖歪了、下次打开发现某一栏特别窄）。想立刻回到三等分，双击任意缝隙即可；设置里的「恢复默认三栏」同样会重置。
- 被拖窄的栏会自动收起次要按钮（后退/前进、打开地址、品牌文字），优先保住地址栏，工具条不会挤成一团。

> 拖动时会在整个窗口上盖一层透明遮罩，指针不会滑进网页里丢事件；松手后遮罩自动消失。

## 使用方法

- **文字**：底部输入框输入，`Enter` 发送，`Shift+Enter` 换行。
- **图片**：聚焦输入框后直接 `Ctrl+V` 粘贴截图，或点「图片」选择本地文件；缩略图会内嵌在输入框里，鼠标悬停点 `×` 可单独删除。
- **发送**：点「全部发送」或回车。各栏先各自把内容填好，就绪后**同时**点击发送。
- **清空**：清空文字与所有缩略图。
- **每栏地址栏**：回车或点 `↵` 在当前栏导航，`Esc` 还原；`←` `→` `⟳` 分别后退/前进/刷新。
- **每栏右上角的小圆点**（以及侧栏列表里的圆点）是注入结果指示灯：灰=未注入，黄=填入中/等待发送，绿=已发送，红=失败；鼠标悬停可看完整结果。
- 底部状态行会汇总各栏结果，例如 `DeepSeek 需要先登录 · 豆包 已发送 · 千问 已发送`。控制台同时打印完整日志（`[main]`、`[renderer]`、`[网页 豆包] [inject] ...`）。

## 登录态会不会丢？

> 应用改名为「红笺-群问AI」后，Electron 默认会换 userData 目录；`main.js` 里显式把目录钉回原来的 `%APPDATA%\ai-compare-ask`，所以**升级不会掉登录态，也不会丢面板配置**。

正常关闭窗口再打开，各栏的登录态都会保留（存在 `%APPDATA%\ai-compare-ask\Partitions\ai-slot-*`）。分区 key 是按模型固定的，所以调整顺序、删了再加回来都不会丢。为了确保这一点，`main.js` 做了三件事：

1. **单实例锁**：`requestSingleInstanceLock()`。两个进程同时用同一个 userData 目录会互相覆盖 Cookie 库，这是「明明登录过、下次又要登录」最常见的原因。现在重复双击只会把已有窗口叫到前面。
2. **及时写盘**：每次页面加载完成 1.5 秒后、窗口关闭前、`before-quit` 和 `window-all-closed` 时，都会调用 `cookies.flushStore()` + `flushStorageData()`。Chromium 默认是延迟批量写 Cookie 的，登录完立刻关窗口就可能丢。
3. **弹窗复用分区**：站内登录弹窗会把发起栏的 `partition` 显式带过去，避免登录 Cookie 写进默认 session。

如果某栏仍然每次都要登录，通常是站点自己的会话策略（比如 token 只有几小时、或多设备登录互踢），可以在该栏按 `F12` 看 Application → Cookies 的过期时间确认。

## 注入脚本怎么改（站点改版时看这里）

所有站点相关的逻辑都集中在 `renderer.js` 底部的 `injectedMain()` 里，只需改两处：

1. **`SITE_CONFIG`**（函数开头，带 `★` 注释）：每个域名的 `input` / `send` 选择器数组（数组顺序即优先级），以及 `imageSettleMs`（粘贴图片后等上传完成的时间）。
2. **`findInput()` / `findSendButton()`** 里的通用兜底规则：如果某站结构特殊（输入框不在页面底部、发送按钮没有 aria-label 等），在这里加判断。

注入脚本本身是「自包含」的：它被 `toString()` 后丢进网页执行，不能引用 `renderer.js` 里的其它变量。改的时候请保持这个约束。

调试时可以打开 DevTools（`Ctrl+Shift+I`），在对应 webview 的页面上下文里看 `[inject]` 开头的日志。

### 当前校准过的选择器（2026-11 线上 DOM）

| 站点 | 输入框 | 发送按钮 | 校准情况 |
| --- | --- | --- | --- |
| DeepSeek `chat.deepseek.com` | `textarea#chat-input` | 图标按钮无稳定文本，通常靠 `aria-label="发送"`，找不到则回车 | 已实测 |
| 豆包 `www.doubao.com` | `div.tiptap.ProseMirror[contenteditable]` | `[data-testid="chat_input_send_button"]` | 已实测 |
| 千问 `www.qianwen.com` | `[role="textbox"][contenteditable]`（placeholder「向千问提问」） | `button[aria-label="发送消息"]` | 已实测 |
| Kimi `www.kimi.com` | `div.chat-input-editor[contenteditable]` | `div.send-button-container` | 沿用旧版页面结构 |
| 元宝 `yuanbao.tencent.com` | `.ql-editor[contenteditable]` → `[contenteditable]` | `[class*="send"]` / `aria-label="发送"` | 待校准 |
| 智谱 `chatglm.cn` | `textarea` → `[contenteditable]` | `button[aria-label*="发送"]` | 待校准 |
| 文心 `yiyan.baidu.com` | `#chat-textarea` → `textarea` | `#sendBtn` / `aria-label*="发送"` | 待校准 |

> 标「待校准」的三个站点没有实际登录账号，选择器是按常见结构写的，但**通用兜底（contenteditable → textarea + 按钮文本/aria-label 匹配 + 回车）照样生效**。如果日志里出现 `no-input` 或点了没反应，按上面「注入脚本怎么改」那一节补一条选择器即可，不用改别的地方。

豆包页面上另有一个隐藏 `textarea`，代码里按「站点选择器 → contenteditable → textarea」的优先级排序，不会选错；千问的发送按钮在无内容时是 `disabled`，所以做了「等按钮可用 → 找不到就回车」的组合策略。

### 文字为什么要用「粘贴事件」注入

三个站点的编辑器并不是同一个东西：豆包是 tiptap/ProseMirror，千问是 **Slate**（DOM 里有 `data-slate-node` / `data-slate-leaf`）。

对 Slate 来说，直接改 DOM 或 `execCommand('insertText')` 只会让文字显示在输入框里，**组件的内部 state 不会更新**，于是「发送消息」按钮一直是 `disabled`，点不动、回车也没反应——表现就是「千问输入了文字但发不出去」。

所以 `setText()` 的策略是：

1. **paste 事件**（首选）：构造一个 `ClipboardEvent('paste')`，`clipboardData` 里放 `text/plain`。这是站点自己的粘贴逻辑，Slate / ProseMirror 都会同步内部状态，按钮才会亮；
2. **`execCommand('insertText')`**（其次）：普通 contenteditable 上最快；
3. **直接写 DOM + `InputEvent`**（兜底）。

每一步都会用一小段特征串校验文字是否真的进了编辑器，不通过才降级。

> 调试提示：如果某站出现「文字进去了但发不出去」，先看发送按钮是不是 `disabled`——那基本就是编辑器状态没同步，需要换成 paste 注入或补站点专用处理。

## 实测记录

2026-11-02 在 Electron 45.2.1 / Windows 上做的冒烟测试（未登录状态）：

- 单窗口三栏正常加载 DeepSeek / 豆包 / 千问，`contextIsolation` / `webviewTag` / 独立 partition 生效；
- 两阶段发送生效：先输出 `三栏准备完成（…ms，就绪 2/3） no-input, ready:button, ready:enter`，再输出 `三栏同时发送完成（…ms）`，点发送的时间点是齐的；
- 未登录的栏会被快速识别（`need-login`，约 2ms 返回），不会把另外两栏拖住 6 秒；
- 用真实登录态（复制 profile 到临时目录，不动原数据）验证了千问：改 DOM / execCommand 后按钮始终 `disabled`，换成 paste 注入后 `ready:button:www.qianwen.com`，豆包同样是 `ready:button`；
- 模拟粘贴 PNG → 生成缩略图 → 广播 → 三栏分别注入，图片 base64 正常传递；
- 默认 UA 里带 `Electron/45.x` 时，DeepSeek 会弹「使用环境异常」安全警告并劝阻登录；`main.js` 里已统一改成真实 Chrome UA，警告消失、登录页正常。

加入侧栏与多面板后再测（同日）：

- 预置 6 栏启动：`grid-template-columns` 为 3 等分，窗口 1642×968 下 2 行 3 列，各栏等宽、无重叠，底部输入区完整；
- 在设置里点「文心」：面板 6 → 7，侧栏列表 7 项，`settings.json` 立即落盘并带上新面板；7 栏为 3 行；
- 点收起：侧栏宽度 58px、按钮文案 `»`、模型只剩彩色首字头像；再点恢复 220px；
- 设置抽屉打开时：已启用 6 行（含 `↑ ↓ ✕`）、模型库 7 张卡片（已加入的显示「已加」）、自定义表单可输入并回车提交。

改成分页后再测：

- 6 栏：`clientHeight = 797`，每栏高度也是 `797`（不再被压扁），`scrollHeight = 1595`（两页），翻页器显示 `1 / 2`；
- 点 `›`：`scrollTop = 798`、第二行顶边正好落在 0、标题变 `2 / 2`；点 `‹` 回到 `0`、`1 / 2`；
- 3 栏：`scrollHeight == clientHeight`（无滚动条），翻页器隐藏；
- 4 栏：两页，第 1 页 3 个、第 2 页 1 个（仍是 1/3 宽，保持各栏尺寸一致）。

## 已知限制与降级方案

1. **登录态是前提**：DeepSeek 未登录会直接被重定向到 `/sign_in`，豆包 / 千问未登录时发送按钮不可用或只弹登录框，所以每栏都要先登录一次（登录态会持久化）。
2. **`isTrusted` 校验**：注入的 `click` / `paste` / `Enter` 都是合成事件（`isTrusted === false`）。个别站点会校验这一点并直接忽略，表现为「文字填进去了但没发出去」或「图片没上传」。这属于站点侧限制，Electron 无法绕过。
   - 降级方案 A：只注入文字，图片由用户在每个窗口手动 `Ctrl+V`（把 `payload.images` 传空即可）。
   - 降级方案 B：改用 `webContents.debugger` + CDP 的 `Input.insertText` / `Input.dispatchKeyEvent`，这两个是浏览器层面的真实输入，`isTrusted === true`；代价是要按站点坐标点击，稳定性受布局影响。
3. **图片上传依赖站点支持粘贴**：注入走的是构造 `ClipboardEvent('paste')` + `DataTransfer`，失败后兜底 `drop` 事件。若两者都无效，可按下面的思路改成「点上传按钮 + 给 file input 赋值」（目前以注释形式保留，未启用）：

   ```js
   // 备用方案（未启用）：直接给页面的 <input type="file"> 塞 File
   const fileInput = document.querySelector('input[type="file"][accept*="image"]');
   const dt = new DataTransfer();
   dt.items.add(file);
   fileInput.files = dt.files;
   fileInput.dispatchEvent(new Event('change', { bubbles: true }));
   ```

4. **输入框在 iframe / Shadow DOM 里**：`querySelectorAll` 到不了，需要按站点穿透 `shadowRoot` 或进入 iframe 的 document，属于单站适配工作。
5. **图片体积**：单张超过 5MB 会先自动压缩（长边 2000px、JPEG 0.9），压缩后仍超限则跳过并提示；一次广播的 base64 总量限制在 26MB 左右，避免 IPC 和 `executeJavaScript` 参数过大导致卡顿。
6. **窄屏**：三栏并排 + 侧栏至少需要 1120px 宽（窗口最小值），屏幕更窄时窗口会保持最小宽度；把侧栏收起能省出 160px。需要更紧凑可改 `main.js` 的 `computeBounds()`。面板多于一页时用分页滚动，不会压缩每栏高度。
7. **登录**：站内 `window.open` 弹窗已放行并继承同一 session，扫码/手机号登录正常；第三方 OAuth 若被站点判定为「不安全浏览器」，只能在该站网页版内完成登录。

## 防风控 / 防封号（底层伪装）

只强化「加载与发送注入」的底层，不改界面布局、不改两阶段发送等业务逻辑。分两层：

**1. 请求头层（主进程 `main.js` 的 `hardenPartition`）**

- 每个面板分区统一设成干净 Chrome UA（不含 Electron / 项目名），并设 `app.userAgentFallback` 兜底（含站内弹窗）；
- `onBeforeSendHeaders` 拦截所有请求：把 `Sec-CH-UA` / `Sec-CH-UA-Full-Version-List` 重写成 Chrome 品牌串，删除 `Sec-CH-UA-Wow64` / `Sec-CH-UA-Model` 和 `X-Electron-*`、`electron-version` 等特征头；
- 每个分区只挂一次拦截器（`hardenedPartitions` 防重），新增模型时自动补。

**2. 页面指纹层（渲染进程 `renderer.js` 的 `STEALTH_SCRIPT` / `applyStealth`）**

- 在 webview 的 `dom-ready` 和 `did-navigate` 时用 `executeJavaScript` 注入，只对齐 JS 环境，不碰页面 DOM；
- 对齐项：`navigator.webdriver → false`、`navigator.languages → ['zh-CN','zh']`、`navigator.plugins` 补齐 5 个内置 PDF 插件、`window.chrome` 补最简对象、`userAgentData.brands` 补 "Google Chrome"；
- 脚本自身幂等（每段自判重），重复注入不会叠加，也不影响任何业务逻辑。

**3. 发送拟人（注入脚本 `injectedMain` 的 `performSend`）**

- 点发送按钮 / 回退回车前加 150~600ms 随机「犹豫」停顿，节奏别像脚本一样 0ms 命中；不影响按钮就绪判断与两阶段 prepare/send 流程。

> 这些只降低「被识别为 Electron / 自动化」的概率，不代表绝对安全；站点自己的验证码、频率风控依然生效。相关免责声明见「免责声明与首次使用教程」一节。

## 安全说明

- `contextIsolation: true`、`nodeIntegration: false`，渲染进程拿不到 Node 能力。
- preload 只暴露四个 IPC 接口（广播、订阅、读配置、存配置），没有暴露 `ipcRenderer` 本体；配置只能改面板列表，动不了文件系统。
- 主进程对 `broadcast-prompt` 的 payload 做类型与体积校验，只接受 `data:image/` 开头的图片字符串。
- 主进程对 `config:save` 的面板做清洗：只接受 `http/https` 且有域名的地址、限制 24 字名称、去重 key、最多 9 栏，写盘走「临时文件 + rename」，避免写一半留下坏 JSON。
- 窗口自身的 `target=_blank` 一律交给系统浏览器，避免应用内被导航走。

## 开源协议

本项目采用 [MIT License](LICENSE)，可自由使用、修改、分发，商用亦可，但需保留版权声明。

## 免责声明

本工具通过模拟用户操作调用第三方 AI 平台网页版，**可能违反相关平台的服务协议，存在账号被限制、封禁的风险，该风险由使用者自行承担**。请仅用于个人学习、研究，勿用于商业用途或恶意批量请求。详见应用内的「免责声明」。


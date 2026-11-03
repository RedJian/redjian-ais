/**
 * main.js —— Electron 主进程
 * ------------------------------------------------------------------
 * 职责：
 *   1. 创建一个窗口，窗口内左侧是可折叠菜单栏、右侧是 AI 面板网格
 *      （每行最多 3 个，超出自动换行；每栏独立 session partition，登录态互不影响）；
 *   2. 维护「模型库 + 已启用面板」配置，持久化到 userData/settings.json，
 *      通过 IPC 交给渲染进程；设置面板里增删模型都走这里；
 *   3. 收到渲染进程的「统一提问」后，把 payload 转发回窗口，
 *      由渲染进程分别注入各栏的 <webview> 里；
 *   4. 登录态持久化：单实例锁 + 及时把 Cookie / localStorage 刷到磁盘。
 *
 * 窗口内的一切界面逻辑都在 index.html / renderer.js 中。
 */

const { app, BrowserWindow, Menu, ipcMain, screen, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/* ==================================================================
 * 便携版适配（只在 electron-builder 的 portable 包里生效）
 * ------------------------------------------------------------------
 * 便携启动器会自动设置 PORTABLE_EXECUTABLE_DIR，指向 .exe 所在目录。
 * 默认 userData 落在 %APPDATA%，换一台电脑就带不走登录态；这里把它改成
 * exe 同级的 AI-Compare-Data 目录，实现「拷走 exe + 数据目录，登录态一起走」。
 *
 * 必须放在 app ready 之前执行（单实例锁、session、settings.json 都依赖它）。
 * 如果所在目录不可写（只读盘、Program Files、被安全软件拦），
 * 自动回退到默认位置，功能不受影响，只是不再「便携」。
 * ================================================================== */
function setupPortableUserData() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (!portableDir) return; // 开发运行 / 安装版：保持默认 %APPDATA%

  const dataDir = path.join(portableDir, 'AI-Compare-Data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    // 真写一下，光看 mkdir 成功不够（有些目录能建但不能写）
    const probe = path.join(dataDir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });

    app.setPath('userData', dataDir);
    console.log('[main] 便携模式：数据目录为', dataDir);
  } catch (err) {
    console.warn(
      '[main] 便携目录不可写，回退到默认 userData：',
      err && err.message,
      '（目标目录：' + dataDir + '）'
    );
  }
}

/**
 * 改名之后 Electron 会按 productName 换 userData 目录，
 * 那样旧版本的登录态和面板配置就「消失」了。这里固定回原来的目录，
 * 保证升级无感（便携版仍由启动器指到 exe 旁边）。
 */
function pinUserDataDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return; // 便携版交给 setupPortableUserData
  // 显式传了 --user-data-dir（调试 / 多开测试）就尊重用户的选择
  if (app.commandLine.hasSwitch('user-data-dir')) return;
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'ai-compare-ask'));
  } catch (err) {
    console.warn('[main] 固定 userData 目录失败，使用默认位置', err && err.message);
  }
}

pinUserDataDir();
setupPortableUserData();

/**
 * 模型库：设置面板里可以勾选启用。
 * key 是 webview 的 partition 后缀（persist:<key>），必须稳定且唯一——
 * 换名字、换顺序、删了再加回来，只要 key 不变，登录态就还在。
 * 前三个的 key 沿用 ai-slot-1/2/3，保证老用户的登录态不丢。
 */
const MODEL_LIBRARY = [
  { key: 'ai-slot-1', name: 'DeepSeek', url: 'https://chat.deepseek.com', color: '#4d6bfe' },
  { key: 'ai-slot-2', name: '豆包', url: 'https://www.doubao.com', color: '#2f6bff' },
  { key: 'ai-slot-3', name: '千问', url: 'https://www.qianwen.com', color: '#7c5cff' },
  { key: 'ai-slot-4', name: 'Kimi', url: 'https://www.kimi.com', color: '#2b3446' },
  { key: 'ai-slot-5', name: '元宝', url: 'https://yuanbao.tencent.com', color: '#0f8ee0' },
  { key: 'ai-slot-6', name: '智谱', url: 'https://chatglm.cn', color: '#2f6bd8' },
  { key: 'ai-slot-7', name: '文心', url: 'https://yiyan.baidu.com', color: '#2a35d6' },
];

/** 面板数量上限：每行 3 个，最多 3 行。再多窗口会卡，也没法看。 */
const MAX_PANELS = 9;

/** @type {{panels: Array<{key:string,name:string,url:string,color:string}>, collapsed: boolean, onboarded: boolean, disclaimerAccepted: boolean}} */
let settings = {
  panels: MODEL_LIBRARY.slice(0, 3).map((item) => ({ ...item })),
  collapsed: false,
  // 是否已经看过首次启动的使用教程
  onboarded: false,
  // 是否已经阅读并同意免责声明（同意后不再强制弹出，侧栏入口仍可随时查看）
  disclaimerAccepted: false,
};

/** 应用名（窗口标题、日志都用它） */
const APP_NAME = '红笺-群问AI';

/** 主窗口引用（只有这一个） */
let mainWindow = null;

/* ==================================================================
 * 配置读写
 * ================================================================== */

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** 只接受 http/https，且域名里得有点，避免把 file:// 之类的东西塞进 webview */
function normalizeHttpUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const parsed = new URL(withScheme);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

/**
 * 清洗面板数组：坏数据一律丢掉，不往下传。
 * 至少保留一个（全删会让窗口变成空白，没有意义）。
 */
function sanitizePanels(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  const usedKeys = new Set();

  for (const raw of list) {
    if (out.length >= MAX_PANELS) break;
    if (!raw || typeof raw !== 'object') continue;

    const url = normalizeHttpUrl(raw.url);
    const name = String(raw.name || '').trim().slice(0, 24);
    if (!url || !name) continue;

    let key = String(raw.key || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/i.test(key) || usedKeys.has(key)) {
      // key 缺失或重复时兜一个：不影响使用，只是这栏要重新登录一次
      key = `custom-${Date.now().toString(36)}-${out.length}`;
    }
    usedKeys.add(key);

    const color = /^#[0-9a-f]{6}$/i.test(String(raw.color || '')) ? raw.color : '#4d6bfe';
    out.push({ key, name, url, color });
  }

  return out;
}

function loadSettings() {
  const file = settingsPath();
  try {
    if (!fs.existsSync(file)) {
      console.log('[main] 没有历史设置，使用默认三栏');
      return;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const panels = sanitizePanels(data && data.panels);
    if (!panels.length) {
      console.warn('[main] 设置里的面板为空或全部非法，回退默认三栏');
      return;
    }
    settings = {
      panels,
      collapsed: !!(data && data.collapsed),
      onboarded: !!(data && data.onboarded),
      disclaimerAccepted: !!(data && data.disclaimerAccepted),
    };
    console.log(
      `[main] 已载入设置：${settings.panels.length} 栏（${settings.panels
        .map((item) => item.name)
        .join(' / ')}），侧栏${settings.collapsed ? '收起' : '展开'}`
    );
  } catch (err) {
    console.warn('[main] 读取设置失败，使用默认值', err && err.message);
  }
}

function saveSettings() {
  const file = settingsPath();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, file); // 先写临时文件再改名，避免写一半断电留下坏 JSON
  } catch (err) {
    console.error('[main] 保存设置失败', err);
    throw err;
  }
}

/** 交给渲染进程的配置（模型库也一起给，设置面板要用） */
function publicConfig() {
  return {
    panels: settings.panels,
    collapsed: settings.collapsed,
    onboarded: settings.onboarded,
    disclaimerAccepted: settings.disclaimerAccepted,
    library: MODEL_LIBRARY,
    maxPanels: MAX_PANELS,
  };
}

/* ==================================================================
 * 会话 / User-Agent
 * ================================================================== */

/**
 * 构造一个「普通 Chrome」的 User-Agent。
 * 默认 UA 里带 Electron/45.x，DeepSeek 这类站点会直接判定为
 * 「使用环境异常」并弹安全警告、甚至拦登录；换成纯 Chrome UA 后正常。
 */
function buildUserAgent() {
  const chrome = process.versions.chrome || '140.0.0.0';
  const platformPart =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platformPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

const USER_AGENT = buildUserAgent();

/* ==================================================================
 * 环境伪装（防风控 / 防封号）—— 只在「加载与请求」这一层做手脚，
 * 不改任何界面布局，也不动注入 / 发送的业务流程。
 * ------------------------------------------------------------------
 * 目标：让每个 webview 分区在站点看来就像「一台普通 Windows 上的 Chrome」。
 *   1. UA 统一换成干净 Chrome（不含 Electron / 项目名）；
 *   2. 请求头里的 Sec-CH-UA* 重写成 Chrome 的品牌串——Electron 默认会在
 *      这些客户端提示里带上自己的品牌，是最容易被识别的特征；
 *   3. 顺手删掉 X-Electron-* 之类的残留头。
 *
 * 注意：这里只改「请求头」，不伪造登录态、不改页面内容，站点该有的
 * 风控（验证码、频率限制）依然生效，只是不再因为「客户端是 Electron」
 * 被一刀切。每段都用 try/catch 包住，任何一项失败都不影响页面加载。
 * ================================================================== */

// 兜底：所有 session（含默认 session、站内弹窗）都用这个 UA
app.userAgentFallback = USER_AGENT;

const CHROME_VERSION = process.versions.chrome || '140.0.0.0';
const CHROME_MAJOR = String(CHROME_VERSION).split('.')[0];
const CLIENT_HINTS_BRANDS = `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not.A/Brand";v="24"`;
const CLIENT_HINTS_FULL = `"Google Chrome";v="${CHROME_VERSION}", "Chromium";v="${CHROME_VERSION}", "Not.A/Brand";v="24.0.0.0"`;

/** 已经挂过请求头拦截的分区；onBeforeSendHeaders 重复注册会互相覆盖，这里防重 */
const hardenedPartitions = new Set();

/**
 * 给一个分区做环境伪装（可重复调用）。
 * UA 每次都会重设；请求头拦截器只挂一次，避免重复注册叠加。
 * @param {string} partitionKey 例如 'persist:ai-slot-1'
 */
function hardenPartition(partitionKey) {
  const ses = session.fromPartition(partitionKey);

  try {
    // 第二个参数是「语言列表」，q 值由 Chromium 自己补；
    // 这里如果再写 ;q=0.9 就会变成 'zh-CN,zh;q=0.9;q=0.9' 这种畸形头，反而成特征
    ses.setUserAgent(USER_AGENT, 'zh-CN,zh,en');
  } catch (err) {
    console.warn(`[main] ${partitionKey} 设置 UA 失败:`, err && err.message);
  }

  if (hardenedPartitions.has(partitionKey)) return;
  hardenedPartitions.add(partitionKey);

  try {
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
      const headers = { ...details.requestHeaders };

      for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (lower === 'user-agent') {
          headers[name] = USER_AGENT;
        } else if (lower === 'sec-ch-ua') {
          // Electron 会在这里塞自己的品牌，整串换成 Chrome 的
          headers[name] = CLIENT_HINTS_BRANDS;
        } else if (lower === 'sec-ch-ua-full-version-list') {
          headers[name] = CLIENT_HINTS_FULL;
        } else if (lower === 'sec-ch-ua-wow64' || lower === 'sec-ch-ua-model') {
          // 桌面 Chrome 不发这两个（Mobile / Model 提示）
          delete headers[name];
        } else if (lower.startsWith('x-electron') || lower === 'electron-version') {
          delete headers[name];
        }
      }

      callback({ requestHeaders: headers });
    });
  } catch (err) {
    console.error(`[main] ${partitionKey} 请求头拦截注册失败:`, err && err.message);
  }
}

/** 给每个已启用面板的分区做伪装（新增模型时必须补这一步） */
function applyUserAgents(panels) {
  panels.forEach((panel) => {
    try {
      hardenPartition(`persist:${panel.key}`);
    } catch (err) {
      console.warn(`[main] ${panel.key} 环境伪装失败:`, err && err.message);
    }
  });
}

/**
 * 把各分区的 Cookie / localStorage 立刻写到磁盘。
 * Chromium 默认是延迟批量写盘的：如果用户登录完直接关窗口、或者从任务管理器
 * 结束进程，内存里的 Cookie 就丢了，下次打开又得重新登录。
 */
function flushSessions(reason = '') {
  settings.panels.forEach((panel) => {
    try {
      const ses = session.fromPartition(`persist:${panel.key}`);
      ses.cookies.flushStore().catch((err) => {
        console.warn(`[main] ${panel.key} Cookie 写盘失败:`, err && err.message);
      });
      ses.flushStorageData();
    } catch (err) {
      console.warn(`[main] ${panel.key} 会话写盘失败:`, err && err.message);
    }
  });
  if (reason) console.log(`[main] 已刷写登录态（${reason}）`);
}

/**
 * 一键退出所有账号：清空每个已启用面板分区的登录痕迹。
 * 不做任何「操作网页」的事（不导航、不点按钮），直接删数据：
 *   - cookies：登录凭证，核心
 *   - localStorage / sessionStorage / indexedDB / websql / serviceworkers：
 *     站点常把 token / 会话标志存在这里
 *   - 磁盘缓存（cache）
 * 每个分区的 storage 是独立的，删一个不影响其它分区和主窗口。
 * 返回 { cleaned: string[] }，方便渲染进程提示清了哪些。
 */
async function clearAllSessions() {
  const cleaned = [];
  for (const panel of settings.panels) {
    const key = `persist:${panel.key}`;
    try {
      const ses = session.fromPartition(key);
      // clearData 比 clearStorageData 更彻底，且会把 cookie 一起清掉。
      // 列全所有登录痕迹类型；不传 dataTypes 会连 code cache 等也一起删，
      // 但那些不影响登录态，明确列出反而更可控。
      await ses.clearData({
        dataTypes: [
          'cookies',
          'localStorage',
          'indexedDB',
          'serviceWorkers',
          'webSQL',
          'cache',
          'fileSystems',
        ],
      });
      cleaned.push(panel.name);
    } catch (err) {
      console.warn(`[main] ${panel.name} 清除登录痕迹失败:`, err && err.message);
    }
  }
  return { cleaned };
}

/* ==================================================================
 * 窗口
 * ================================================================== */

/**
 * 计算窗口大小：默认占满工作区的 96%×94%，上限 1780×1040。
 * 三栏并排 + 左侧栏约 220px，所以最小宽度定在 1120。
 */
function computeBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(1780, Math.max(1120, Math.round(workArea.width * 0.96)));
  const height = Math.min(1040, Math.max(660, Math.round(workArea.height * 0.94)));
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}

/** 标题栏文案：栏数多的时候只列前三个，避免标题被截断 */
function windowTitle() {
  const names = settings.panels.map((panel) => panel.name);
  const prefix = names.slice(0, 3).join(' / ');
  const suffix = names.length > 3 ? ` 等 ${names.length} 个` : '';
  return `${APP_NAME} · ${prefix}${suffix}`;
}

function createWindow() {
  const bounds = computeBounds();

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1120,
    minHeight: 660,
    title: windowTitle(),
    backgroundColor: '#eef1f6',
    autoHideMenuBar: true,
    show: false, // 等首屏渲染好再显示，避免白屏闪烁

    // ===== 无边框：去掉 Windows 原生标题栏，改用页面里自绘的 macOS 风格顶栏 =====
    // frame: false 之后系统不再画标题栏和按钮，最小化/最大化/关闭都由
    // index.html 里的「红绿灯」按钮走 IPC 回到这里执行（见 window:* 处理函数）。
    frame: false,
    // Windows 上保留 WS_THICKFRAME：窗口边缘仍可用鼠标拖拽缩放，
    // 同时系统会给窗口阴影 / Win11 的圆角，观感更接近原生。
    thickFrame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // ===== 以下三项是需求里明确要求的关键配置 =====
      webviewTag: true,       // 允许使用 <webview> 标签承载 AI 网页
      contextIsolation: true, // 渲染进程与 preload 上下文隔离
      nodeIntegration: false, // 渲染进程不能直接使用 Node API
      spellcheck: false,
    },
  });

  // 首屏直接用主进程的配置渲染，避免「先空白再出栏」的闪烁；
  // 之后设置面板的改动走 IPC，同样以主进程为准。
  mainWindow.loadFile('index.html', {
    query: { panels: JSON.stringify(publicConfig()) },
  });

  mainWindow.once('ready-to-show', () => {
    clearTimeout(showTimer);
    mainWindow.show();
  });
  // 兜底：万一 ready-to-show 没触发（页面挂了），也别让窗口一直躲着
  const showTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
  }, 4000);

  // 页面 <title> 会覆盖窗口标题，这里禁掉，由主进程统一维护
  mainWindow.on('page-title-updated', (event) => event.preventDefault());

  // ===== 把窗口状态推给渲染进程，用来更新「红绿灯」的样式 =====
  //   最大化时绿色按钮变成「还原」；窗口失焦时三个点变灰（模拟 macOS）。
  const pushWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:state', readWindowState(mainWindow));
  };
  ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'].forEach(
    (name) => mainWindow.on(name, pushWindowState)
  );
  // 首屏加载完再推一次，覆盖「启动时就已经最大化」的情况
  mainWindow.webContents.on('did-finish-load', pushWindowState);

  // preload 写错时不会自动报错到控制台，这里显式打出来
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[main] preload 加载失败:', preloadPath, error);
  });

  // 窗口关闭前先写盘，避免登录态丢失
  mainWindow.on('close', () => flushSessions('window-close'));
  mainWindow.on('closed', () => {
    clearTimeout(showTimer);
    mainWindow = null;
  });

  // 窗口本身不应该打开新窗口（页面里的 target=_blank 一律交给系统浏览器）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

/* ==================================================================
 * IPC
 * ================================================================== */

/**
 * 用系统浏览器打开外链（右侧博客入口用）。
 * 只放行 http/https，避免被当成 file:// 之类的东西利用。
 */
ipcMain.handle('shell:open-external', async (_event, rawUrl) => {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    console.warn('[main] 拒绝打开非 http(s) 链接:', url);
    return false;
  }
  try {
    await shell.openExternal(url);
    console.log('[main] 已用系统浏览器打开:', url);
    return true;
  } catch (err) {
    console.error('[main] 打开外链失败:', err);
    return false;
  }
});

/* ==================================================================
 * 自绘窗口按钮（无边框窗口的「红绿灯」）
 * ------------------------------------------------------------------
 * 渲染进程点按钮 → 这里操作真正的 BrowserWindow。
 * 只作用于发消息的那个窗口（fromWebContents），不碰别的窗口。
 * ================================================================== */
function readWindowState(win) {
  return {
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    focused: win.isFocused(),
  };
}

ipcMain.handle('window:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  win.minimize();
  return true;
});

ipcMain.handle('window:toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  if (win.isFullScreen()) win.setFullScreen(false);
  else if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return readWindowState(win);
});

ipcMain.handle('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  win.close(); // 走 close 事件，登录态会先刷盘
  return true;
});

ipcMain.handle('window:state', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? readWindowState(win) : { maximized: false, fullscreen: false, focused: true };
});

ipcMain.handle('config:get', () => publicConfig());

ipcMain.handle('config:save', (_event, payload) => {
  const panels = sanitizePanels(payload && payload.panels);
  if (!panels.length) {
    throw new Error('至少保留一个模型');
  }

  const before = settings.panels.map((item) => item.key).join(',');
  settings = {
    panels,
    collapsed: !!(payload && payload.collapsed),
    // 老版本渲染进程可能不带这个字段，保留原值，避免教程反复弹
    onboarded:
      payload && typeof payload.onboarded === 'boolean'
        ? payload.onboarded
        : settings.onboarded,
    // 同上：没带就保留原值，避免同意过的免责声明又被重置成「未同意」
    disclaimerAccepted:
      payload && typeof payload.disclaimerAccepted === 'boolean'
        ? payload.disclaimerAccepted
        : settings.disclaimerAccepted,
  };
  const after = settings.panels.map((item) => item.key).join(',');

  // 新增的分区要先有 UA，否则 webview 一加载就带着 Electron 标识
  if (before !== after) applyUserAgents(settings.panels);

  saveSettings();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(windowTitle());
  }

  console.log(
    `[main] 设置已保存：${settings.panels.length} 栏（${settings.panels
      .map((item) => item.name)
      .join(' / ')}）`
  );
  return publicConfig();
});

/** 一键退出所有账号：清空所有已启用面板分区的登录痕迹（不操作网页） */
ipcMain.handle('session:clear-all', async () => {
  const result = await clearAllSessions();
  console.log(`[main] 已清除登录痕迹：${result.cleaned.length} 栏（${result.cleaned.join(' / ')}）`);
  return result;
});

/**
 * 广播提示词。
 * 关键点：主进程只负责「转发」，不关心页面 DOM；
 * 渲染进程收到后会把同一份内容分别注入各栏，每家各收到一次，不会重复。
 */
ipcMain.on('broadcast-prompt', (_event, payload) => {
  // ---------- 入参校验，坏数据不往下传 ----------
  if (!payload || typeof payload !== 'object') {
    console.warn('[main] 丢弃非法 payload:', payload);
    return;
  }

  const safePayload = {
    id: typeof payload.id === 'string' ? payload.id : `p-${Date.now()}`,
    text: typeof payload.text === 'string' ? payload.text : '',
    images: Array.isArray(payload.images)
      ? payload.images.filter((item) => typeof item === 'string' && item.startsWith('data:image/'))
      : [],
    from: payload.from ?? null,
    ts: Date.now(),
  };

  const base64Length = safePayload.images.reduce((sum, item) => sum + item.length, 0);
  console.log(
    `[main] 收到广播 #${safePayload.id}｜文字 ${safePayload.text.length} 字` +
      `｜图片 ${safePayload.images.length} 张` +
      `｜base64 约 ${(base64Length / 1024 / 1024).toFixed(2)} MB`
  );

  if (!safePayload.text && safePayload.images.length === 0) {
    console.warn('[main] 空内容，不转发');
    return;
  }

  // 需求指定：用 BrowserWindow.getAllWindows() 转发（目前只有一个窗口，
  // 窗口里的所有栏都会收到同一份 payload）
  const targets = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  for (const win of targets) {
    win.webContents.send('receive-prompt', safePayload);
  }
  console.log(`[main] 已转发到 ${targets.length} 个窗口（共 ${settings.panels.length} 栏）`);
});

/**
 * 登录 / 授权弹窗处理。
 * webview 里的登录按钮经常走 window.open，需要放行，否则账号登不进去。
 * 注意要把 opener 的 partition 显式带过去，否则弹窗可能落到默认 session，
 * 登录完成后主页面看不到 Cookie。
 */
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  // 页面每次加载完成（含登录后的跳转）就把 Cookie 刷盘，防止异常退出丢登录态
  let flushTimer = null;
  contents.on('did-stop-loading', () => {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      try {
        contents.session.cookies.flushStore().catch(() => {});
        contents.session.flushStorageData();
      } catch (_) {
        /* 页面销毁时忽略 */
      }
    }, 1500);
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/i.test(url)) return { action: 'deny' };
    console.log('[main] 站内弹窗放行:', url);
    let partition = '';
    try {
      partition = contents.session.getPartition();
    } catch (_) {
      partition = '';
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 720,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          // 继承发起方的会话，登录态才能回写到对应栏
          ...(partition ? { partition } : {}),
        },
      },
    };
  });
});

function onReady() {
  // 去掉默认菜单栏（Windows/Linux 上 Alt 会冒出来）
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') app.setAppUserModelId('com.redjian.groupask');

  // 打日志方便排查「配置怎么没生效 / 登录态存哪了」
  console.log('[main] userData 目录:', app.getPath('userData'));

  loadSettings();

  // 所有已启用分区统一换成真实 Chrome UA（必须在 webview 创建前设置）
  applyUserAgents(settings.panels);
  console.log('[main] User-Agent:', USER_AGENT);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

/**
 * 单实例锁：两个进程同时用同一个 userData 目录会互相覆盖 Cookie 库，
 * 表现就是「明明登录过，下次打开又要登录」。
 * 第二个实例会直接退出，并把已有窗口叫到前面。
 */
if (!app.requestSingleInstanceLock()) {
  console.log('[main] 已有实例在运行，本次启动直接退出（避免并发写坏登录态）');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(onReady);

  // 退出前最后兜一次：把 Cookie / localStorage 写盘
  app.on('before-quit', () => flushSessions('before-quit'));

  app.on('window-all-closed', () => {
    flushSessions('window-all-closed');
    if (process.platform !== 'darwin') app.quit();
  });
}

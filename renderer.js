/**
 * renderer.js —— 单窗口多栏的界面逻辑
 * ------------------------------------------------------------------
 * 四块内容：
 *   1. 左侧可折叠菜单栏：面板列表 + 设置入口；
 *   2. 面板网格：每行最多 3 栏，超出自动换行；栏的顺序用 CSS order 控制，
 *      绝不移除/重建 <webview>（移动 DOM 会让网页重新加载）；
 *   3. 底部统一输入框：文字 + 粘贴图片 + 缩略图 + 清空 + 发送；
 *   4. 发送时把提示词广播出去，再把同一份内容分别注入各栏的网页。
 *
 * 最核心的是文件末尾的 injectedMain()：它会被 toString() 之后
 * 丢进 AI 网页里执行，所以必须是自包含的（不能引用外部变量）。
 */

/* ==================================================================
 * 0. 启动参数与基础引用
 * ================================================================== */
const params = new URLSearchParams(location.search);

/** 内置模型库兜底（正常应以主进程下发的为准） */
const FALLBACK_LIBRARY = [
  { key: 'ai-slot-1', name: 'DeepSeek', url: 'https://chat.deepseek.com', color: '#4d6bfe' },
  { key: 'ai-slot-2', name: '豆包', url: 'https://www.doubao.com', color: '#2f6bff' },
  { key: 'ai-slot-3', name: '千问', url: 'https://www.qianwen.com', color: '#7c5cff' },
  { key: 'ai-slot-4', name: 'Kimi', url: 'https://www.kimi.com', color: '#2b3446' },
  { key: 'ai-slot-5', name: '元宝', url: 'https://yuanbao.tencent.com', color: '#0f8ee0' },
  { key: 'ai-slot-6', name: '智谱', url: 'https://chatglm.cn', color: '#2f6bd8' },
  { key: 'ai-slot-7', name: '文心', url: 'https://yiyan.baidu.com', color: '#2a35d6' },
];

/** 首屏配置：主进程通过 loadFile 的 query 直接带过来，避免「先空白后出栏」 */
const INITIAL = (() => {
  try {
    const raw = JSON.parse(params.get('panels') || 'null');
    if (raw && Array.isArray(raw.panels) && raw.panels.length) {
      return {
        panels: raw.panels,
        collapsed: !!raw.collapsed,
        onboarded: !!raw.onboarded,
        disclaimerAccepted: !!raw.disclaimerAccepted,
        library: Array.isArray(raw.library) && raw.library.length ? raw.library : FALLBACK_LIBRARY,
        maxPanels: Number(raw.maxPanels) || 9,
      };
    }
  } catch (err) {
    console.error('[renderer] panels 参数解析失败，使用内置默认配置', err);
  }
  return {
    panels: FALLBACK_LIBRARY.slice(0, 3),
    collapsed: false,
    onboarded: false,
    disclaimerAccepted: false,
    library: FALLBACK_LIBRARY,
    maxPanels: 9,
  };
})();

const bridge = window.aiBridge;
const paneTemplate = document.getElementById('pane-template');
const columnsEl = document.getElementById('columns');
const sidebarEl = document.getElementById('sidebar');
const sbListEl = document.getElementById('sb-list');

const el = {
  editor: document.getElementById('editor'),
  btnImage: document.getElementById('btn-image'),
  btnClear: document.getElementById('btn-clear'),
  btnSend: document.getElementById('btn-send'),
  hint: document.getElementById('hint'),
  status: document.getElementById('status'),
  counter: document.getElementById('counter'),
  fileInput: document.getElementById('file-input'),
  toast: document.getElementById('toast'),
  toastText: document.getElementById('toast-text'),
  toastAction: document.getElementById('toast-action'),

  // 侧栏
  btnCollapse: document.getElementById('btn-collapse'),
  btnAddModel: document.getElementById('btn-add-model'),
  btnSettings: document.getElementById('btn-settings'),

  // 设置抽屉
  drawer: document.getElementById('drawer'),
  drawerMask: document.getElementById('drawer-mask'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  enabledList: document.getElementById('enabled-list'),
  enabledCount: document.getElementById('enabled-count'),
  libraryList: document.getElementById('model-library'),
  customName: document.getElementById('custom-name'),
  customUrl: document.getElementById('custom-url'),
  btnAddCustom: document.getElementById('btn-add-custom'),
  btnReset: document.getElementById('btn-reset'),

  // 自绘标题栏（窗口无边框，见 main.js 的 frame: false）
  winClose: document.getElementById('win-close'),
  winMin: document.getElementById('win-min'),
  winMax: document.getElementById('win-max'),

  // 左下角的博客入口 / 教程
  btnTutorial: document.getElementById('btn-tutorial'),
  tutorial: document.getElementById('tutorial'),
  tutorialMask: document.getElementById('tutorial-mask'),
  btnTutorialStart: document.getElementById('btn-tutorial-start'),

  // 免责声明（首次启动强制阅读，之后从左下角入口查看）
  btnDisclaimer: document.getElementById('btn-disclaimer'),
  disclaimer: document.getElementById('disclaimer'),
  disclaimerMask: document.getElementById('disclaimer-mask'),
  disclaimerBody: document.getElementById('disclaimer-body'),
  disclaimerCheck: document.getElementById('disclaimer-check'),
  btnDisclaimerAgree: document.getElementById('btn-disclaimer-agree'),
  btnDisclaimerClose: document.getElementById('btn-disclaimer-close'),

  // 一键退出所有账号
  btnLogout: document.getElementById('btn-logout'),
  logout: document.getElementById('logout'),
  logoutMask: document.getElementById('logout-mask'),
  logoutList: document.getElementById('logout-list'),
  btnLogoutConfirm: document.getElementById('btn-logout-confirm'),
  btnLogoutCancel: document.getElementById('btn-logout-cancel'),

  // 翻页器（面板多于一页时出现）
  // 拖动缝隙时盖住整个窗口，避免指针进到 webview 里丢事件
  dragShield: document.getElementById('drag-shield'),

  pager: document.getElementById('pager'),
  pagePrev: document.getElementById('page-prev'),
  pageNext: document.getElementById('page-next'),
  pageLabel: document.getElementById('page-label'),

  // AI 总结
  btnSummarize: document.getElementById('btn-summarize'),
  btnApiSettings: document.getElementById('btn-api-settings'),
  apiSettings: document.getElementById('api-settings'),
  apiSettingsMask: document.getElementById('api-settings-mask'),
  apiBaseUrl: document.getElementById('api-base-url'),
  apiKey: document.getElementById('api-key'),
  apiModel: document.getElementById('api-model'),
  apiPresets: document.getElementById('api-presets'),
  btnApiSave: document.getElementById('btn-api-save'),
  btnApiCancel: document.getElementById('btn-api-cancel'),
  summaryModal: document.getElementById('summary-modal'),
  summaryMask: document.getElementById('summary-mask'),
  summaryContent: document.getElementById('summary-content'),
  summarySub: document.getElementById('summary-sub'),
  summaryState: document.getElementById('summary-state'),
  btnSummaryClose: document.getElementById('btn-summary-close'),
  btnSummaryCopy: document.getElementById('btn-summary-copy'),

  // 微信公众号二维码浮层
  wechatTrigger: document.getElementById('wechat-trigger'),
  wechatQr: document.getElementById('wechat-qr'),
};

/* ------------------------------ 运行时状态 ------------------------------ */
/** @type {Array<{cfg:any, index:number, node:HTMLElement, wv:any, queue:Promise<any>}>} */
let PANES = [];
let MODEL_LIBRARY = INITIAL.library;
let MAX_PANELS = INITIAL.maxPanels;
let sidebarCollapsed = false;
/** 是否已看过首次启动教程（存到 settings.json，跨重启记住） */
let onboarded = INITIAL.onboarded;
/** 是否已同意免责声明（同上，同意后不再强制弹出） */
let disclaimerAccepted = INITIAL.disclaimerAccepted;

/** 自定义模型的配色池，按顺序取，避免都用同一个蓝色 */
const CUSTOM_COLORS = ['#0f9d76', '#c8871a', '#b5479b', '#2f9bbf', '#d2694a', '#5a6b8c'];

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(77,107,254,${alpha})`;
  const [, r, g, b] = m;
  return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
}

/** 侧栏头像取名字首字：中文取第一个字，英文取首字母大写 */
function avatarText(name) {
  const text = String(name || '?').trim();
  return text ? text.slice(0, 1).toUpperCase() : '?';
}

/* ==================================================================
 * 1. 面板：创建 / 复用 / 移除 / 排序
 * ================================================================== */

/* ------------------------------------------------------------------
 * 页面级「反自动化特征」脚本（防风控）。
 * 在 webview 的 dom-ready 时用 executeJavaScript 注入，只做最小必要的对齐，
 * 让页面 JS 环境和真实 Windows Chrome 一致。全程不碰页面 DOM、不改业务逻辑。
 *
 * 关键点：脚本会因 dom-ready / 页面跳转 / 延迟补一次而被重复执行，所以
 * 每一段都自己判断「是否已处理过」，而不是一进来就 return——这样每次都能
 * 把缺失的部分补上，已就绪的部分自动跳过。
 * ------------------------------------------------------------------ */
const STEALTH_SCRIPT = `(() => {
  try {
    Object.defineProperty(window, '__aiStealth', { value: true, enumerable: false });
    const proto = Navigator.prototype;

    // 1) webdriver：真实 Chrome 是 false；钉死，防止被 --enable-automation 之类影响
    try {
      if (!Object.getOwnPropertyDescriptor(proto, 'webdriver')) {
        Object.defineProperty(proto, 'webdriver', { get: () => false, configurable: true });
      }
    } catch (_) {}

    // 2) 语言：固定 zh-CN
    try {
      Object.defineProperty(proto, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
    } catch (_) {}

    // 3) plugins：Electron 默认空数组，真实 Chrome 有 5 个内置 PDF 插件
    try {
      if (!navigator.plugins || navigator.plugins.length === 0) {
        const defs = [
          ['PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
          ['Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
          ['Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
          ['Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
          ['WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format']
        ];
        const plugins = defs.map((d) => ({ name: d[0], filename: d[1], description: d[2], length: 1 }));
        const fake = Object.create(PluginArray.prototype);
        plugins.forEach((p, i) => { fake[i] = p; });
        Object.defineProperty(fake, 'length', { get: () => plugins.length });
        fake.item = (i) => plugins[i] || null;
        fake.namedItem = (n) => plugins.find((p) => p.name === n) || null;
        fake.refresh = () => {};
        Object.defineProperty(proto, 'plugins', { get: () => fake, configurable: true });
      }
    } catch (_) {}

    // 4) window.chrome：缺失时补一个最简对象
    try {
      if (!window.chrome) window.chrome = { app: { isInstalled: false }, runtime: {} };
    } catch (_) {}

    // 5) userAgentData.brands：Electron 只报 Chromium，真实 Chrome 还带 "Google Chrome"
    try {
      const uad = navigator.userAgentData;
      if (uad && !Object.getOwnPropertyDescriptor(uad, 'brands')) {
        const parts = navigator.userAgent.split('Chrome/');
        const major = parts.length > 1 ? parts[1].split('.')[0] : '140';
        const brands = [
          { brand: 'Google Chrome', version: major },
          { brand: 'Chromium', version: major },
          { brand: 'Not.A/Brand', version: '24' }
        ];
        Object.defineProperty(uad, 'brands', { get: () => brands, configurable: true });
      }
    } catch (_) {}

    return 'ok';
  } catch (err) {
    return 'err:' + (err && err.message);
  }
})()`;

/** 把伪装脚本注入某一栏的网页（脚本自身幂等，重复注入会被内部防重挡住） */
async function applyStealth(pane) {
  if (pane.destroyed) return;
  try {
    await pane.wv.executeJavaScript(STEALTH_SCRIPT, true);
    if (!pane.stealthApplied) {
      pane.stealthApplied = true;
      console.log(`[${pane.cfg.name}] 已对齐浏览器特征`);
    }
  } catch (err) {
    console.warn(`[${pane.cfg.name}] 特征对齐失败:`, err && err.message);
  }
}

/**
 * @param {{key:string, name:string, url:string, color:string}} cfg
 */
function createPane(cfg) {
  const node = paneTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.key = cfg.key;
  node.style.setProperty('--accent', cfg.color);
  node.style.setProperty('--accent-soft', hexToRgba(cfg.color, 0.1));
  node.querySelector('.brand .name').textContent = cfg.name;
  node.querySelector('.brand').title = `${cfg.name} · ${cfg.url}`;

  const address = node.querySelector('.address');
  const loading = node.querySelector('.loading');
  const host = node.querySelector('.webview-host');
  const stateDot = node.querySelector('.pane-state');
  const btnBack = node.querySelector('[data-act="back"]');
  const btnForward = node.querySelector('[data-act="forward"]');
  const btnReload = node.querySelector('[data-act="reload"]');
  const btnOpen = node.querySelector('[data-act="open"]');
  const btnZoom = node.querySelector('[data-act="zoom"]');
  const stripAvatar = node.querySelector('.strip-avatar');
  const stripName = node.querySelector('.strip-name');

  const wv = document.createElement('webview');
  // ★ 关键：partition 必须在设置 src（以及插入 DOM 触发加载）之前赋值，
  //   否则 webview 会落到默认 session，各栏的登录态就互相串了。
  wv.setAttribute('partition', `persist:${cfg.key}`);
  wv.setAttribute('allowpopups', ''); // 允许站内的登录/授权弹窗
  wv.setAttribute('src', cfg.url);
  wv.className = 'webview';
  host.appendChild(wv);

  const pane = {
    cfg,
    index: 0,
    node,
    wv,
    address,
    loading,
    stateDot,
    stateKind: '',
    stateTitle: '尚未注入',
    ready: false,
    destroyed: false,
    stealthApplied: false,
    waiters: [],
    queue: Promise.resolve(), // 注入串行队列：连续提问时按顺序处理
  };

  /** 日志前缀用当前名字，改名后也准确 */
  const label = () => pane.cfg.name;

  /* -------- 加载状态 / 地址栏同步 -------- */
  let loadingTimer = null;

  wv.addEventListener('dom-ready', () => {
    pane.ready = true;
    pane.waiters.splice(0).forEach((resolve) => resolve(true));
    updateNavButtons(pane);
    // 页面 DOM 就绪后立刻对齐浏览器特征（webdriver / plugins / languages / chrome）
    applyStealth(pane);
  });

  wv.addEventListener('did-start-loading', () => {
    clearTimeout(loadingTimer);
    loading.classList.add('show');
  });

  wv.addEventListener('did-stop-loading', () => {
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => loading.classList.remove('show'), 120);
    updateNavButtons(pane);
  });

  wv.addEventListener('did-navigate', (event) => {
    syncAddress(pane, event.url);
    applyStealth(pane); // 整页跳转后重新对齐（脚本内部有防重）
  });
  wv.addEventListener('did-navigate-in-page', (event) => {
    if (event.isMainFrame !== false) syncAddress(pane, event.url);
  });

  wv.addEventListener('did-fail-load', (event) => {
    // errorCode -3 是「主动中断导航」，属于正常现象
    if (event.errorCode === -3 || event.isMainFrame === false) return;
    loading.classList.remove('show');
    console.warn(
      `[${label()}] 页面加载失败`,
      event.errorCode,
      event.errorDescription,
      event.validatedURL
    );
  });

  wv.addEventListener('render-process-gone', (_event, details) => {
    console.error(`[${label()}] 渲染进程异常退出:`, details);
  });

  // 只转发注入脚本自己的日志，网站自身的日志不刷屏
  wv.addEventListener('console-message', (...args) => {
    const evt = args[0] || {};
    const message = evt.message != null ? evt.message : args[2];
    if (typeof message === 'string' && message.includes('[inject]')) {
      console.log(`[网页 ${label()}] ${message}`);
    }
  });

  /* -------- 顶部按钮 -------- */
  btnBack.addEventListener('click', () => {
    try {
      if (wv.canGoBack()) wv.goBack();
    } catch (err) {
      console.warn(`[${label()}] 后退失败`, err);
    }
  });

  btnForward.addEventListener('click', () => {
    try {
      if (wv.canGoForward()) wv.goForward();
    } catch (err) {
      console.warn(`[${label()}] 前进失败`, err);
    }
  });

  btnReload.addEventListener('click', () => wv.reload());
  btnOpen.addEventListener('click', () => paneNavigate(pane, address.value));

  /* -------- 沉浸模式：放大 / 恢复 -------- */
  stripAvatar.textContent = avatarText(cfg.name);
  stripAvatar.style.background = hexToRgba(cfg.color, 0.14);
  stripAvatar.style.color = cfg.color;
  stripName.textContent = cfg.name;

  btnZoom.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePaneFocus(pane);
  });

  // 缩成细条后，点一下整条就恢复三等分
  node.addEventListener('click', () => {
    if (node.classList.contains('is-strip')) exitFocus();
  });

  address.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      paneNavigate(pane, address.value);
      address.blur();
    } else if (event.key === 'Escape') {
      try {
        address.value = wv.getURL() || '';
      } catch (_) {
        address.value = '';
      }
      address.blur();
    }
  });

  address.addEventListener('focus', () => address.select());

  columnsEl.appendChild(node);
  return pane;
}

/** 已有栏的配置变化（改名 / 换色 / 改地址）：只更新外观，不动已加载的页面 */
function updatePane(pane, cfg) {
  const nameChanged = pane.cfg.name !== cfg.name;
  pane.cfg = { ...pane.cfg, ...cfg };
  pane.node.style.setProperty('--accent', pane.cfg.color);
  pane.node.style.setProperty('--accent-soft', hexToRgba(pane.cfg.color, 0.1));
  pane.node.querySelector('.brand').title = `${pane.cfg.name} · ${pane.cfg.url}`;
  if (nameChanged) pane.node.querySelector('.brand .name').textContent = pane.cfg.name;

  // 沉浸模式细条里的头像 / 竖排名字
  const stripAvatar = pane.node.querySelector('.strip-avatar');
  const stripName = pane.node.querySelector('.strip-name');
  if (stripAvatar) {
    stripAvatar.textContent = avatarText(pane.cfg.name);
    stripAvatar.style.background = hexToRgba(pane.cfg.color, 0.14);
    stripAvatar.style.color = pane.cfg.color;
  }
  if (stripName) stripName.textContent = pane.cfg.name;
}

function destroyPane(pane) {
  pane.destroyed = true;
  pane.waiters.splice(0).forEach((resolve) => resolve(false));
  try {
    pane.wv.stop();
  } catch (_) {
    /* 页面可能已经卸载 */
  }
  try {
    pane.wv.remove();
  } catch (_) {
  }
  pane.node.remove();
  console.log(`[renderer] 已移除面板 ${pane.cfg.name}`);
}

/**
 * 把界面同步成 nextPanels。
 * ★ 顺序用 CSS `order` 控制而不是移动 DOM 节点：移动 <webview> 会让页面重新
 *   加载，聊天记录和滚动位置全丢。这里只增删节点 + 改 order。
 */
function syncPanes(nextPanels) {
  const list = Array.isArray(nextPanels) ? nextPanels.slice(0, MAX_PANELS) : [];
  if (!list.length) {
    console.warn('[renderer] 面板列表为空，忽略这次同步');
    return;
  }

  const wanted = new Map(list.map((cfg) => [cfg.key, cfg]));

  // 1) 移除不再需要的栏（登录态在 partition 里，不会因为关栏而丢失）
  PANES.slice().forEach((pane) => {
    if (!wanted.has(pane.cfg.key)) destroyPane(pane);
  });

  // 2) 复用已有栏，缺的才新建
  const byKey = new Map(PANES.map((pane) => [pane.cfg.key, pane]));
  const next = list.map((cfg) => {
    const existing = byKey.get(cfg.key);
    if (existing) {
      updatePane(existing, cfg);
      return existing;
    }
    return createPane(cfg);
  });

  // 3) 记录顺序（位置由 layoutPanes() 用绝对定位摆，不改 DOM 顺序）
  next.forEach((pane, index) => {
    pane.index = index;
    pane.node.dataset.slot = String(index + 1);
  });

  PANES = next;
  applyLayout();
  renderSidebar();
  renderSettings();
}

/* ------------------------------------------------------------------
 * 动态分屏
 *   每一栏都用绝对定位摆放（left / top / width / height 由这里计算后写进
 *   style），好处是：
 *     ① 栏间缝隙可以拖动，给某一栏更多空间；
 *     ② 沉浸模式能把某一栏放大到 80%，同行的其它栏收成细条。
 *   全程只改样式、不动 DOM —— 移动 <webview> 会让网页重新加载。
 *
 *   分页仍是「一行 = 一页」：滚动高度由 .snap-track 里的占位行撑起来，
 *   占位行同时提供滚动吸附点，所以滚轮 / 滚动条 / 翻页按钮的行为不变。
 * ------------------------------------------------------------------ */

/** 拖动缝隙时每栏的最小宽度 */
const MIN_PANE_WIDTH = 220;
/** 沉浸模式里被放大那栏占的宽度比例 */
const FOCUS_SHARE = 0.8;

/** 当前行高（px），由 relayout() 写入 */
let lastRowHeight = 0;
/**
 * 三栏宽度权重。
 * ★ 每次启动都从 [1,1,1]（三等分）开始，拖动只影响本次运行；
 *   这样不会因为上次拖歪了，下次打开发现某一栏特别窄。
 */
let columnRatios = [1, 1, 1];
/** 沉浸模式：被放大的那一栏 key（null = 普通模式） */
let focusKey = null;

const snapTrackEl = document.getElementById('snap-track');
const guttersEl = document.getElementById('gutters');
const dragShield = document.getElementById('drag-shield');

/** 放大 / 恢复的图标（内联 SVG，跟随 currentColor） */
const ICON_EXPAND = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
  stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
  <path d="M16 3h3a2 2 0 0 1 2 2v3" />
  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
</svg>`;

const ICON_COLLAPSE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
  stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
</svg>`;

/** 栏间距（左/上/右/下都用它，B 柱宽度也是它） */
function paneGap() {
  const value = parseFloat(getComputedStyle(columnsEl).getPropertyValue('--pane-gap'));
  return Number.isFinite(value) ? value : 10;
}

/** 每页几栏（也就是列数）：1~3 个按实际数量，多了固定 3 列 */
function columnCount() {
  return Math.min(3, Math.max(1, PANES.length));
}

/** 一共几页 */
function pageCount() {
  return Math.max(1, Math.ceil(PANES.length / columnCount()));
}

/** 翻一页要滚多少像素：一行的高度 + 行间距 */
function pageStep() {
  return (lastRowHeight || Math.floor(columnsEl.clientHeight) || 1) + paneGap();
}

function currentPage() {
  const total = pageCount();
  const raw = Math.round(columnsEl.scrollTop / pageStep());
  return Math.min(total - 1, Math.max(0, raw));
}

/** 正在平滑滚动去往的页码（连点翻页时以它为准，不然第二次会算回原页） */
let pendingPage = null;
let pendingTimer = 0;

function goToPage(index, behavior = 'smooth') {
  const target = Math.min(pageCount() - 1, Math.max(0, index));
  const top = target * pageStep();
  columnsEl.scrollTo({ top, behavior });

  if (behavior !== 'smooth') {
    pendingPage = null;
    return;
  }

  // 平滑滚动在渲染进程繁忙（多个 webview 正在加载）时会被直接丢掉，
  // 这里兜一次：到点还没滚到位就直接设过去，保证「翻页一定翻得动」。
  pendingPage = target;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    if (Math.abs(columnsEl.scrollTop - top) > 4) columnsEl.scrollTop = top;
    pendingPage = null;
  }, 450);
}

/** 相对翻页：连点时从「上一次的目标页」继续，而不是从还没滚到的当前页算 */
function stepPage(delta) {
  const base = pendingPage != null ? pendingPage : currentPage();
  goToPage(base + delta);
}

/* ------------------------------ 几何计算 ------------------------------ */

/** 把权重换算成像素宽度（扣掉栏间距后按比例分） */
function widthsFromRatios(ratios, cols) {
  const gap = paneGap();
  const usable = Math.max(0, columnsEl.clientWidth - gap * (cols - 1));
  const list = ratios.slice(0, cols);
  const sum = list.reduce((a, b) => a + b, 0) || 1;
  const widths = list.map((ratio) => (usable * ratio) / sum);

  // 兜底：任何一栏都不小于 MIN_PANE_WIDTH。
  // 拖动时已经限制过下限，这里主要防「历史配置 / 手动改 settings.json」
  // 留下极端比例，导致某一栏窄到没法用。多出来的宽度从当前最宽的那栏扣。
  if (cols > 1 && usable >= MIN_PANE_WIDTH * cols) {
    for (let round = 0; round < cols; round++) {
      const index = widths.findIndex((width) => width < MIN_PANE_WIDTH - 0.5);
      if (index < 0) break;

      const widest = widths.indexOf(Math.max(...widths));
      if (widest === index) break;

      const need = MIN_PANE_WIDTH - widths[index];
      const spare = widths[widest] - MIN_PANE_WIDTH;
      const take = Math.min(need, spare);
      if (take <= 0) break;

      widths[index] += take;
      widths[widest] -= take;
    }
  }

  return widths;
}

/**
 * 某一行的栏宽权重：
 *   普通模式用用户拖出来的 columnRatios；
 *   沉浸模式下，被放大那一栏所在的行改成「80% + 其余平分 20%」，
 *   其它行保持不变（不会连累别的页重新排版）。
 */
function ratiosForRow(rowIndex, cols) {
  if (!focusKey || cols < 2) return columnRatios;
  const focusIndex = PANES.findIndex((pane) => pane.cfg.key === focusKey);
  if (focusIndex < 0) return columnRatios;
  if (Math.floor(focusIndex / cols) !== rowIndex) return columnRatios;

  const focusCol = focusIndex % cols;
  const other = (1 - FOCUS_SHARE) / (cols - 1);
  return Array.from({ length: cols }, (_, col) => (col === focusCol ? FOCUS_SHARE : other));
}

/** 占位行：撑出滚动高度 + 提供每页的吸附点 */
function syncSnapTrack(rows, rowHeight, gap) {
  if (!snapTrackEl) return;
  if (snapTrackEl.children.length !== rows) {
    snapTrackEl.textContent = '';
    for (let i = 0; i < rows; i++) {
      const rowEl = document.createElement('div');
      rowEl.className = 'snap-row';
      snapTrackEl.appendChild(rowEl);
    }
  }
  snapTrackEl.style.height = `${rows * rowHeight + (rows - 1) * gap}px`;
}

/** 给每一行画上栏与栏之间的拖动条 */
function renderGutters(rowWidths, rowHeight, gap) {
  if (!guttersEl) return;
  guttersEl.textContent = '';

  const cols = columnCount();
  if (focusKey || cols < 2) return; // 沉浸模式下不提供拖动

  rowWidths.forEach((widths, row) => {
    const top = row * (rowHeight + gap);

    for (let col = 1; col < cols; col++) {
      let x = col * gap;
      for (let i = 0; i < col; i++) x += widths[i];

      const handle = document.createElement('div');
      handle.className = 'gutter';
      handle.dataset.col = String(col);
      handle.style.left = `${x - 7}px`;
      handle.style.top = `${top}px`;
      handle.style.height = `${rowHeight}px`;
      handle.title = '拖动调整宽度 · 双击恢复三等分';
      guttersEl.appendChild(handle);
    }
  });
}

/** 按当前状态把每一栏摆到该在的位置 */
function layoutPanes() {
  const rowHeight = lastRowHeight || Math.floor(columnsEl.clientHeight);
  if (!rowHeight || !columnsEl.clientWidth) return;

  const cols = columnCount();
  const gap = paneGap();
  const rows = Math.ceil(PANES.length / cols);

  const rowWidths = [];
  for (let row = 0; row < rows; row++) {
    rowWidths.push(widthsFromRatios(ratiosForRow(row, cols), cols));
  }

  PANES.forEach((pane, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const widths = rowWidths[row];

    let left = col * gap;
    for (let i = 0; i < col; i++) left += widths[i];

    pane.node.style.left = `${left}px`;
    pane.node.style.top = `${row * (rowHeight + gap)}px`;
    pane.node.style.width = `${widths[col]}px`;
    pane.node.style.height = `${rowHeight}px`;

    // 拖窄了以后工具栏会挤，交给 CSS 把次要按钮收起来
    pane.node.classList.toggle('is-narrow', widths[col] < 360);
  });

  syncSnapTrack(rows, rowHeight, gap);
  renderGutters(rowWidths, rowHeight, gap);

  // 拖动条是绝对定位的，如果让它按 100% 高度铺，多出来的行会撑大滚动高度，
  // 分页就乱了；这里显式对齐到内容总高。
  if (guttersEl) guttersEl.style.height = `${rows * rowHeight + (rows - 1) * gap}px`;
}

/* ------------------------------ 拖动缝隙 ------------------------------ */

let dragState = null;

/** 结束拖动（persist=false 用于异常中断，不写盘） */
function finishDrag(persist = true) {
  if (!dragState) return;
  dragState = null;
  if (dragShield) dragShield.hidden = true;
  document.body.classList.remove('is-resizing');
  layoutPanes();
  if (persist) {
    persistConfig();
    console.log(
      `[renderer] 栏宽已调整：${columnRatios.map((ratio) => ratio.toFixed(2)).join(' / ')}`
    );
  }
}

// 拖到窗口外松手时拿不到 pointerup，窗口失焦就当作结束，别把遮罩留在那儿
window.addEventListener('blur', () => finishDrag(false));

guttersEl.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('.gutter');
  if (!handle || event.button !== 0) return;

  const cols = columnCount();
  const col = Number(handle.dataset.col);
  const usable = columnsEl.clientWidth - paneGap() * (cols - 1);
  if (cols < 2 || !col || usable <= 120) return;

  dragState = {
    col,
    startX: event.clientX,
    startRatios: columnRatios.slice(0, cols),
    sum: columnRatios.slice(0, cols).reduce((a, b) => a + b, 0) || 1,
    usable,
  };

  handle.classList.add('is-active');
  if (dragShield) dragShield.hidden = false;
  document.body.classList.add('is-resizing');
  event.preventDefault();
});

if (dragShield) {
  dragShield.addEventListener('pointermove', (event) => {
    if (!dragState) return;
    // 在窗口外松开鼠标时收不到 pointerup，这里按「按键已松开」兜一次
    if (event.buttons === 0) {
      finishDrag(false);
      return;
    }

    const { col, startX, startRatios, sum, usable } = dragState;
    // 像素位移 → 权重位移：宽度 = usable * ratio / sum
    const delta = ((event.clientX - startX) * sum) / usable;
    // 每栏至少留 MIN_PANE_WIDTH：权重下限 = 最小宽度占可用宽度的比例
    const minRatio = Math.max(0.05, (MIN_PANE_WIDTH * sum) / usable);

    const leftStart = startRatios[col - 1];
    const rightStart = startRatios[col];
    // ★ 只让相邻两栏「一增一减」，总和保持不变，否则权重总和会漂，
    //   拖 180px 只动 20px 这种偏差就是总和变了导致的。
    const moved = Math.min(
      Math.max(leftStart + delta, minRatio),
      leftStart + rightStart - minRatio
    );

    const next = columnRatios.slice();
    next[col - 1] = moved;
    next[col] = leftStart + rightStart - moved;
    columnRatios = next;

    layoutPanes();
    // 重画后把高亮标回同一根
    const active = guttersEl.querySelector(`.gutter[data-col="${col}"]`);
    if (active) active.classList.add('is-active');
  });

  dragShield.addEventListener('pointerup', () => finishDrag(true));
  dragShield.addEventListener('pointercancel', () => finishDrag(false));
}

/* 双击缝隙：恢复三等分 */
guttersEl.addEventListener('dblclick', (event) => {
  if (!event.target.closest('.gutter')) return;
  columnRatios = [1, 1, 1];
  layoutPanes();
  persistConfig();
  toast('已恢复三等分');
});

/* ------------------------------ 沉浸模式 ------------------------------ */

/**
 * 把 is-zoomed / is-strip 同步到各栏，并处理细条里 webview 的尺寸。
 *
 * 细条只有 ~10% 宽，如果把 webview 也压到这么窄，站点会整页重排，
 * 恢复时再排一次，又卡又可能把聊天记录滚没了。所以这里在进入细条前
 * 记下 webview 的实际宽高，细条期间用内联样式钉住，站点视角尺寸不变。
 */
function applyFocusClasses() {
  const cols = columnCount();
  const focusIndex = focusKey ? PANES.findIndex((pane) => pane.cfg.key === focusKey) : -1;
  const focusRow = focusIndex >= 0 ? Math.floor(focusIndex / cols) : -1;

  PANES.forEach((pane, index) => {
    const zoomed = focusIndex >= 0 && index === focusIndex;
    const striped = focusIndex >= 0 && Math.floor(index / cols) === focusRow && !zoomed;

    pane.node.classList.toggle('is-zoomed', zoomed);
    pane.node.classList.toggle('is-strip', striped);

    if (striped && pane.stripBox && pane.stripBox.width > 0) {
      // flex 子项会被拉伸，所以连 flex / align-self 一起钉住
      pane.wv.style.flex = '0 0 auto';
      pane.wv.style.alignSelf = 'flex-start';
      pane.wv.style.width = `${pane.stripBox.width}px`;
      pane.wv.style.height = `${pane.stripBox.height}px`;
    } else {
      pane.wv.style.flex = '';
      pane.wv.style.alignSelf = '';
      pane.wv.style.width = '';
      pane.wv.style.height = '';
    }

    const btn = pane.node.querySelector('.pane-zoom');
    if (btn) {
      btn.innerHTML = zoomed ? ICON_COLLAPSE : ICON_EXPAND;
      btn.title = zoomed ? '恢复三等分' : '放大这一栏（其它栏收成细条）';
      btn.setAttribute('aria-pressed', zoomed ? 'true' : 'false');
      btn.disabled = cols < 2;
    }
  });

  columnsEl.classList.toggle('is-focus-mode', !!focusKey);
}

function enterFocus(pane) {
  const cols = columnCount();
  if (cols < 2) {
    toast('只有一栏时不需要放大');
    return;
  }
  if (!pane) return;

  focusKey = pane.cfg.key;

  // 记下同行其它栏里 webview 的当前尺寸，细条期间钉住不重排
  const focusRow = Math.floor(pane.index / cols);
  PANES.forEach((item) => {
    const striped = item !== pane && Math.floor(item.index / cols) === focusRow;
    item.stripBox = striped
      ? { width: item.wv.clientWidth, height: item.wv.clientHeight }
      : null;
  });

  applyFocusClasses();
  layoutPanes();
  goToPage(focusRow, 'auto');
  console.log(
    `[renderer] 沉浸模式：${pane.cfg.name} 占 ${Math.round(FOCUS_SHARE * 100)}%，` +
      `同行其它栏收成细条`
  );
}

function exitFocus() {
  if (!focusKey) return;
  focusKey = null;
  PANES.forEach((pane) => {
    pane.stripBox = null;
  });
  applyFocusClasses();
  layoutPanes();
  console.log('[renderer] 已退出沉浸模式，恢复栏宽');
}

/** 点同一栏的按钮 = 退出；点别的栏的按钮 = 换到那一栏 */
function togglePaneFocus(pane) {
  if (!pane) return;
  if (focusKey === pane.cfg.key) exitFocus();
  else enterFocus(pane);
}

/* ------------------------------ 汇总 ------------------------------ */

/** 上一次渲染的页码签名，避免滚动时每帧都写 DOM */
let lastPagerSignature = '';

function updatePager() {
  const total = pageCount();
  el.pager.hidden = total <= 1; // 只有一页就不用翻页器了
  if (total <= 1) {
    lastPagerSignature = '';
    return;
  }

  const page = currentPage() + 1;
  const signature = `${page}/${total}`;
  if (signature === lastPagerSignature) return;
  lastPagerSignature = signature;

  el.pageLabel.textContent = `${page} / ${total}`;
  el.pagePrev.disabled = page <= 1;
  el.pageNext.disabled = page >= total;
}

/**
 * 重新算几何。窗口大小、侧栏折叠、栏数变化都会走到这里。
 * 行高 = 面板区可视高度，这是「一页只显示 3 个、其余往下排」的关键。
 */
function relayout() {
  const height = Math.floor(columnsEl.clientHeight);
  if (!height) return; // 还没布局出来，等 ResizeObserver 再调

  const page = currentPage();
  const heightChanged = height !== lastRowHeight;

  lastRowHeight = height;
  columnsEl.style.setProperty('--row-h', `${height}px`);

  applyFocusClasses(); // 先保证细条/放大状态与 focusKey 一致
  layoutPanes();
  updatePager();

  // 行高变了滚动位置会漂，维持在原来那一页
  // （用 setTimeout 而不是 rAF：窗口被遮挡时 rAF 会暂停）
  if (heightChanged) setTimeout(() => goToPage(page, 'auto'), 0);
}

function applyLayout() {
  const count = PANES.length;
  columnsEl.dataset.count = String(count);
  el.hint.textContent = `Enter 发送 · Shift+Enter 换行 · ${count} 栏同步`;

  // 栏数变了：只剩一栏就没得放大；被删掉的那栏也要退出沉浸
  if (columnCount() < 2) focusKey = null;
  if (focusKey && !PANES.some((pane) => pane.cfg.key === focusKey)) focusKey = null;

  relayout();

  // 删掉面板后当前滚动位置可能越界，夹回最后一页
  const maxTop = (pageCount() - 1) * pageStep();
  if (columnsEl.scrollTop > maxTop) goToPage(pageCount() - 1, 'auto');

  updatePager();
}

/* 滚动时更新页码。
   这里刻意不用 requestAnimationFrame 节流：窗口被遮挡或最小化时 rAF 会暂停，
   一旦卡住就再也不更新了；updatePager 内部按「页码签名」去重，开销可忽略。 */
columnsEl.addEventListener('scroll', updatePager, { passive: true });

el.pagePrev.addEventListener('click', () => stepPage(-1));
el.pageNext.addEventListener('click', () => stepPage(1));

// 窗口大小 / 侧栏折叠 / 滚动条出现都会改变可视区尺寸，用 ResizeObserver 最准
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => relayout()).observe(columnsEl);
} else {
  window.addEventListener('resize', relayout);
}

/* ---------------------------- 每栏小工具 ---------------------------- */
function syncAddress(pane, url) {
  if (!url) return;
  if (document.activeElement === pane.address) return; // 用户正在编辑时不打断
  pane.address.value = url;
}

function updateNavButtons(pane) {
  try {
    pane.node.querySelector('[data-act="back"]').disabled = !pane.wv.canGoBack();
    pane.node.querySelector('[data-act="forward"]').disabled = !pane.wv.canGoForward();
  } catch (_) {
    /* webview 还没挂载时 canGoBack 会抛错，忽略即可 */
  }
}

function normalizeUrl(raw) {
  let url = (raw || '').trim();
  if (!url) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function paneNavigate(pane, raw) {
  const url = normalizeUrl(raw);
  if (!url) {
    toast('网址格式不正确');
    return;
  }
  console.log(`[${pane.cfg.name}] 导航到`, url);
  pane.wv.loadURL(url).catch((err) => {
    console.error(`[${pane.cfg.name}] loadURL 失败`, err);
    toast('打开失败：' + err.message);
  });
}

/** 等待某栏 webview 完成首次 dom-ready；超时返回 false */
function paneWhenReady(pane, timeout = 8000) {
  if (pane.ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    pane.waiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** 每栏右上角（以及侧栏列表里）的注入结果指示灯 */
function setPaneState(pane, kind, title) {
  pane.stateKind = kind || '';
  pane.stateTitle = title || '尚未注入';
  pane.stateDot.className = kind ? `pane-state is-${kind}` : 'pane-state';
  pane.stateDot.title = pane.stateTitle;

  const dot = sbListEl.querySelector(`.sb-item[data-key="${pane.cfg.key}"] .sb-dot`);
  if (dot) {
    dot.className = kind ? `sb-dot is-${kind}` : 'sb-dot';
    dot.title = pane.stateTitle;
  }
}

/* ==================================================================
 * 2. 左侧菜单栏 + 设置抽屉
 * ================================================================== */

function focusPane(pane) {
  // 先翻到它所在的那一页，再做高亮
  goToPage(Math.floor(pane.index / columnCount()));
  pane.node.classList.add('is-focus');
  setTimeout(() => pane.node.classList.remove('is-focus'), 900);
  sbListEl.querySelectorAll('.sb-item').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.key === pane.cfg.key);
  });
}

/* ------------------------------ 使用教程 ------------------------------ */
function openTutorial() {
  el.tutorial.classList.add('open');
  el.tutorial.setAttribute('aria-hidden', 'false');
  el.tutorialMask.classList.add('open');
}

function closeTutorial() {
  el.tutorial.classList.remove('open');
  el.tutorial.setAttribute('aria-hidden', 'true');
  el.tutorialMask.classList.remove('open');

  // 第一次看完才记下来，这样中途关窗口下次还会弹
  if (!onboarded) {
    onboarded = true;
    persistConfig();
  }
}

el.btnTutorial.addEventListener('click', openTutorial);
el.btnTutorialStart.addEventListener('click', closeTutorial);
// 刻意不绑定「点遮罩关闭」：首次教程一点就跑掉，容易错过；按 Esc 或点「开始使用」才关。

/* ------------------------------ 免责声明 ------------------------------
 * 两种模式：
 *   forced —— 首次启动的强制阅读：不能 Esc / 点遮罩关闭，必须勾选后点「同意并继续」；
 *   review —— 侧栏入口随时查看：不显示勾选框，点「关闭」或遮罩即可退出。
 * 同意状态写进 settings.json（disclaimerAccepted），此后启动不再强制弹出。
 * ---------------------------------------------------------------------- */
/** 当前这次打开是不是「强制阅读」模式 */
let disclaimerForced = false;

function openDisclaimer(forced = false) {
  disclaimerForced = !!forced;
  el.disclaimer.classList.toggle('is-review', !forced);
  el.btnDisclaimerAgree.hidden = !forced;
  el.btnDisclaimerClose.hidden = !!forced;

  if (forced) {
    el.disclaimerCheck.checked = false;
    el.btnDisclaimerAgree.disabled = true;
  }

  // 每次打开都回到顶部，别让人错过前面的条款
  el.disclaimerBody.scrollTop = 0;
  el.disclaimer.classList.add('open');
  el.disclaimer.setAttribute('aria-hidden', 'false');
  el.disclaimerMask.classList.add('open');
  // 焦点从底部输入框移到浮层上，防止「在声明后面盲打」
  try {
    el.disclaimer.focus({ preventScroll: true });
  } catch (_) {}
}

function closeDisclaimer() {
  el.disclaimer.classList.remove('open');
  el.disclaimer.setAttribute('aria-hidden', 'true');
  el.disclaimerMask.classList.remove('open');
  disclaimerForced = false;
  // 关掉后把焦点还给输入框，接着就能直接提问
  if (el.editor) el.editor.focus();
}

/** 勾选后解锁「同意并继续」；点了才算真正同意 */
function acceptDisclaimer() {
  if (!el.disclaimerCheck.checked) return;
  disclaimerAccepted = true;
  closeDisclaimer();
  persistConfig().catch((err) => console.error('[renderer] 保存免责声明状态失败', err));

  // 首次启动：同意之后再接着看使用教程（顺序固定，避免两个浮层叠在一起）
  if (!onboarded) setTimeout(openTutorial, 260);
}

el.disclaimerCheck.addEventListener('change', () => {
  el.btnDisclaimerAgree.disabled = !el.disclaimerCheck.checked;
});
el.btnDisclaimerAgree.addEventListener('click', acceptDisclaimer);
el.btnDisclaimerClose.addEventListener('click', closeDisclaimer);
el.btnDisclaimer.addEventListener('click', () => openDisclaimer(false));
// 强制模式下点遮罩不关闭；查看模式下允许点空白处退出
el.disclaimerMask.addEventListener('click', () => {
  if (!disclaimerForced) closeDisclaimer();
  else toast('请先勾选「我已阅读并同意」，再点「同意并继续」');
});

/* ------------------------------ 退出所有账号 ------------------------------
 * 主进程直接清空各分区的 Cookie / localStorage 等登录痕迹，不操作任何网页。
 * 点侧栏入口 → 弹确认框（列出所有栏）→ 确认 → 主进程清理 → 刷新各栏页面。
 * -------------------------------------------------------------------------- */
function openLogout() {
  // 列出当前所有已启用面板的名字
  el.logoutList.innerHTML = '';
  PANES.forEach((pane) => {
    const li = document.createElement('li');
    li.textContent = pane.cfg.name;
    el.logoutList.appendChild(li);
  });
  el.logout.classList.add('open');
  el.logout.setAttribute('aria-hidden', 'false');
  el.logoutMask.classList.add('open');
  try {
    el.logout.focus({ preventScroll: true });
  } catch (_) {}
}

function closeLogout() {
  el.logout.classList.remove('open');
  el.logout.setAttribute('aria-hidden', 'true');
  el.logoutMask.classList.remove('open');
  if (el.editor) el.editor.focus();
}

/** 确认退出：调用主进程清理，成功后刷新每一栏，让页面回到未登录态 */
async function confirmLogout() {
  if (!bridge || !bridge.clearAllSessions) {
    toast('当前环境不支持清理，请更新后重试');
    return;
  }
  el.btnLogoutConfirm.disabled = true;
  el.btnLogoutConfirm.textContent = '正在清理…';
  try {
    const result = await bridge.clearAllSessions();
    const names = (result && result.cleaned) || [];
    closeLogout();
    toast(
      names.length
        ? `已清除 ${names.length} 栏登录痕迹：${names.join('、')}`
        : '已清除登录痕迹'
    );
    // 清理后各栏页面里还残留旧会话状态，刷新一下回到登录页
    PANES.forEach((pane) => {
      if (!pane.destroyed) {
        try {
          pane.wv.reload();
        } catch (_) {}
      }
    });
  } catch (err) {
    console.error('[renderer] 退出所有账号失败', err);
    toast('清理失败：' + (err && err.message ? err.message : err));
  } finally {
    el.btnLogoutConfirm.disabled = false;
    el.btnLogoutConfirm.textContent = '退出所有账号';
  }
}

el.btnLogout.addEventListener('click', openLogout);
el.btnLogoutCancel.addEventListener('click', closeLogout);
el.btnLogoutConfirm.addEventListener('click', confirmLogout);
el.logoutMask.addEventListener('click', closeLogout);


/* ------------------------------ 自绘窗口按钮 ------------------------------
 * 窗口是 frame: false 的无边框窗口，系统不画按钮，
 * 左上角这三个「红绿灯」通过 preload 暴露的 windowControls 操作真实窗口。
 * -------------------------------------------------------------------------- */
const winControls = bridge && bridge.windowControls;

function applyWindowState(state) {
  if (!state) return;
  document.body.classList.toggle('is-maximized', !!state.maximized);
  // 窗口失焦时三个点变灰（macOS 的观感）
  document.body.classList.toggle('win-blur', state.focused === false);
  if (el.winMax) {
    el.winMax.title = state.maximized ? '还原' : '最大化';
    el.winMax.setAttribute('aria-label', state.maximized ? '还原窗口' : '最大化窗口');
  }
}

if (winControls) {
  el.winClose.addEventListener('click', () => winControls.close());
  el.winMin.addEventListener('click', () => winControls.minimize());
  el.winMax.addEventListener('click', async () => {
    try {
      applyWindowState(await winControls.toggleMaximize());
    } catch (err) {
      console.error('[renderer] 最大化切换失败', err);
    }
  });

  winControls.onStateChange(applyWindowState);
  winControls
    .getState()
    .then(applyWindowState)
    .catch((err) => console.warn('[renderer] 读取窗口状态失败', err));
} else {
  // 没有 preload 时按钮点了也没反应，直接禁用，别给人假希望
  [el.winClose, el.winMin, el.winMax].forEach((btn) => {
    if (btn) btn.disabled = true;
  });
  console.warn('[renderer] 缺少 windowControls，自绘窗口按钮已禁用');
}

/* ------------------------------ 左侧博客入口 ------------------------------ */
document.querySelectorAll('.sb-blog[data-url]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const url = btn.dataset.url;
    const label = btn.getAttribute('title') || url;
    if (!url) return;

    if (bridge && bridge.openExternal) {
      const ok = await bridge.openExternal(url);
      if (!ok) toast('打开链接失败：' + label);
    } else {
      // 没有 preload 时退回 window.open，主进程同样会交给系统浏览器
      window.open(url, '_blank');
    }
  });
});

/** 行尾的垃圾桶图标（内联 SVG，跟随 currentColor 变色） */
const TRASH_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
  stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M4 7h16" />
  <path d="M9.6 4.6h4.8" />
  <path d="M6.6 7l.82 12.1a1.7 1.7 0 0 0 1.7 1.6h5.76a1.7 1.7 0 0 0 1.7-1.6L17.4 7" />
  <path d="M10.2 11v5.4" />
  <path d="M13.8 11v5.4" />
</svg>`;

function renderSidebar() {
  sbListEl.textContent = '';
  const onlyOne = PANES.length <= 1;

  PANES.forEach((pane) => {
    // 行用 div：行内还要放一个删除按钮，而 <button> 里不能再嵌 <button>
    const row = document.createElement('div');
    row.className = 'sb-item';
    row.dataset.key = pane.cfg.key;
    row.title = `${pane.cfg.name}\n${pane.cfg.url}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');

    const avatar = document.createElement('span');
    avatar.className = 'sb-avatar';
    avatar.textContent = avatarText(pane.cfg.name);
    avatar.style.background = hexToRgba(pane.cfg.color, 0.12);
    avatar.style.color = pane.cfg.color;

    const text = document.createElement('span');
    text.className = 'sb-text';
    text.textContent = pane.cfg.name;

    const dot = document.createElement('span');
    dot.className = pane.stateKind ? `sb-dot is-${pane.stateKind}` : 'sb-dot';
    dot.title = pane.stateTitle;

    // ★ 直接在这里删掉这个模型（不用进设置）
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sb-del';
    del.innerHTML = TRASH_ICON;
    del.disabled = onlyOne;
    del.title = onlyOne ? '至少保留一个模型' : `删除 ${pane.cfg.name}（登录态保留，可撤销）`;
    del.setAttribute('aria-label', `删除 ${pane.cfg.name}`);
    del.addEventListener('mousedown', (event) => event.stopPropagation());
    del.addEventListener('click', (event) => {
      event.stopPropagation(); // 别顺带触发「定位到该栏」
      removePanel(pane.cfg.key);
    });

    row.append(avatar, text, dot, del);
    row.addEventListener('click', () => focusPane(pane));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        focusPane(pane);
      }
    });
    sbListEl.appendChild(row);
  });

  el.btnAddModel.hidden = PANES.length >= MAX_PANELS;
}

function setCollapsed(next, persist = true) {
  sidebarCollapsed = !!next;
  sidebarEl.classList.toggle('is-collapsed', sidebarCollapsed);
  el.btnCollapse.textContent = sidebarCollapsed ? '»' : '«';
  el.btnCollapse.title = sidebarCollapsed ? '展开侧栏' : '收起侧栏';
  if (persist) persistConfig();
}

/* ------------------------------ 设置抽屉 ------------------------------ */
function openSettings() {
  renderSettings();
  el.drawer.classList.add('open');
  el.drawer.setAttribute('aria-hidden', 'false');
  el.drawerMask.classList.add('open');
}

function closeSettings() {
  el.drawer.classList.remove('open');
  el.drawer.setAttribute('aria-hidden', 'true');
  el.drawerMask.classList.remove('open');
}

function iconButton(text, title, disabled, onClick, danger = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = danger ? 'row-btn danger' : 'row-btn';
  btn.textContent = text;
  btn.title = title;
  btn.disabled = !!disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function makeAvatar(name, color, className) {
  const avatar = document.createElement('span');
  avatar.className = className;
  avatar.textContent = avatarText(name);
  avatar.style.background = hexToRgba(color, 0.12);
  avatar.style.color = color;
  return avatar;
}

function renderSettings() {
  if (!el.enabledList) return;

  el.enabledCount.textContent = `${PANES.length} / ${MAX_PANELS}`;

  /* ---------- 已启用 ---------- */
  el.enabledList.textContent = '';
  PANES.forEach((pane, index) => {
    const row = document.createElement('div');
    row.className = 'enabled-row';

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(index + 1);

    const avatar = makeAvatar(pane.cfg.name, pane.cfg.color, 'sb-avatar');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const strong = document.createElement('strong');
    strong.textContent = pane.cfg.name;
    const span = document.createElement('span');
    span.textContent = pane.cfg.url;
    meta.append(strong, span);

    const up = iconButton('↑', '上移', index === 0, () => movePanel(pane.cfg.key, -1));
    const down = iconButton('↓', '下移', index === PANES.length - 1, () =>
      movePanel(pane.cfg.key, 1)
    );
    const del = iconButton('✕', '从面板移除（登录态仍保留）', PANES.length <= 1, () =>
      removePanel(pane.cfg.key), true
    );

    row.append(idx, avatar, meta, up, down, del);
    el.enabledList.appendChild(row);
  });

  /* ---------- 模型库 ---------- */
  el.libraryList.textContent = '';
  MODEL_LIBRARY.forEach((model) => {
    const added = PANES.some((pane) => pane.cfg.key === model.key);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = added ? 'model-card is-added' : 'model-card';
    card.title = added ? `${model.name} 已在面板中` : `添加 ${model.name}（${model.url}）`;

    const avatar = makeAvatar(model.name, model.color, 'sb-avatar');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const strong = document.createElement('strong');
    strong.textContent = model.name;
    const span = document.createElement('span');
    span.textContent = model.url.replace(/^https?:\/\//, '');
    meta.append(strong, span);

    const plus = document.createElement('span');
    plus.className = 'plus';
    plus.textContent = added ? '已加' : '+';

    card.append(avatar, meta, plus);
    card.addEventListener('click', () => {
      if (!added) addModel({ ...model });
    });

    el.libraryList.appendChild(card);
  });
}

/* ------------------------------ 增删排序 ------------------------------ */

async function addModel(model) {
  if (PANES.some((pane) => pane.cfg.key === model.key)) {
    toast('已经在面板里了');
    return;
  }
  if (PANES.length >= MAX_PANELS) {
    toast(`最多 ${MAX_PANELS} 个模型`);
    return;
  }
  syncPanes([...PANES.map((pane) => ({ ...pane.cfg })), { ...model }]);
  // 新栏在最后一页，顺手翻过去并高亮，省得用户自己找
  const added = PANES[PANES.length - 1];
  if (added) focusPane(added);
  toast(`已添加 ${model.name}`);
  await persistConfig();
  renderSettings();
}

/**
 * 删除一个面板（设置抽屉里的 ✕ 和侧栏行尾的垃圾桶都走这里）。
 * 删完给一个「撤销」，手滑点错能一键恢复原位；登录态存在分区里，
 * 加回来不用重新登录。
 */
async function removePanel(key, options = {}) {
  const index = PANES.findIndex((pane) => pane.cfg.key === key);
  if (index < 0) return;

  if (PANES.length <= 1) {
    toast('至少保留一个模型');
    return;
  }

  const snapshot = { ...PANES[index].cfg };
  syncPanes(PANES.filter((pane) => pane.cfg.key !== key).map((pane) => ({ ...pane.cfg })));
  await persistConfig();
  renderSettings();

  if (options.silent) return; // 撤销动作本身不再弹提示
  toast(`已移除 ${snapshot.name}`, 5000, {
    label: '撤销',
    onClick: () => restorePanel(snapshot, index),
  });
}

/** 撤销删除：按原来的位置插回去 */
function restorePanel(cfg, index) {
  if (!cfg || !cfg.key) return;
  if (PANES.some((pane) => pane.cfg.key === cfg.key)) return;

  const list = PANES.map((pane) => ({ ...pane.cfg }));
  list.splice(Math.min(Math.max(index, 0), list.length), 0, { ...cfg });
  syncPanes(list);
  persistConfig();

  const pane = PANES.find((item) => item.cfg.key === cfg.key);
  if (pane) focusPane(pane);
  toast(`已恢复 ${cfg.name}`);
}

async function movePanel(key, delta) {
  const index = PANES.findIndex((pane) => pane.cfg.key === key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= PANES.length) return;

  const list = PANES.map((pane) => ({ ...pane.cfg }));
  [list[index], list[target]] = [list[target], list[index]];
  syncPanes(list);
  await persistConfig();
  renderSettings();
}

async function addCustomModel() {
  const name = el.customName.value.trim();
  if (!name) {
    toast('请先填模型名称');
    el.customName.focus();
    return;
  }
  const url = normalizeUrl(el.customUrl.value);
  if (!url) {
    toast('网址格式不正确');
    el.customUrl.focus();
    return;
  }
  if (PANES.length >= MAX_PANELS) {
    toast(`最多 ${MAX_PANELS} 个模型`);
    return;
  }

  const color = CUSTOM_COLORS[PANES.length % CUSTOM_COLORS.length];
  // key 决定分区名，必须唯一；时间戳足够，且不会和内置模型撞
  const key = `custom-${Date.now().toString(36)}`;

  el.customName.value = '';
  el.customUrl.value = '';
  await addModel({ key, name, url, color });
}

async function resetPanels() {
  const defaults = MODEL_LIBRARY.slice(0, 3).map((model) => ({ ...model }));
  columnRatios = [1, 1, 1];
  focusKey = null;
  syncPanes(defaults);
  toast('已恢复默认三栏');
  await persistConfig();
  renderSettings();
}

/** 把当前面板与侧栏状态写回主进程（主进程负责落盘） */
async function persistConfig() {
  if (!bridge || !bridge.saveConfig) {
    console.warn('[renderer] 缺少 aiBridge.saveConfig，设置无法持久化');
    return;
  }
  try {
    const cfg = await bridge.saveConfig({
      panels: PANES.map((pane) => ({ ...pane.cfg })),
      collapsed: sidebarCollapsed,
      onboarded,
      disclaimerAccepted,
    });
    if (cfg && Array.isArray(cfg.library) && cfg.library.length) {
      MODEL_LIBRARY = cfg.library;
    }
    if (cfg && Number(cfg.maxPanels)) MAX_PANELS = cfg.maxPanels;
  } catch (err) {
    console.error('[renderer] 保存设置失败', err);
    toast('设置保存失败：' + (err && err.message ? err.message : err));
  }
}

/* ==================================================================
 * 3. 底部统一输入框：文字 + 图片
 * ================================================================== */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 单张图片上限 5MB
const MAX_TOTAL_BASE64 = 26 * 1024 * 1024; // 一次广播的 base64 总量上限，防止 IPC / 注入卡死

/** 已附加的图片：{ id, dataUrl, bytes }，顺序即缩略图顺序 */
let attachments = [];
let attachmentSeq = 0;
let pendingImages = 0; // 正在读取/压缩的图片数量，发送前要等它们落地
let toastTimer = null;

function hideToast() {
  el.toast.classList.remove('show');
  el.toast.classList.remove('has-action');
  el.toastAction.hidden = true;
  el.toastAction.onclick = null;
}

/**
 * 底部轻提示。
 * @param {string} message 文案
 * @param {number} duration 停留毫秒
 * @param {{label: string, onClick: Function}} [action] 可选的操作按钮（如「撤销」）
 */
function toast(message, duration = 2200, action = null) {
  el.toastText.textContent = message;
  clearTimeout(toastTimer);

  if (action && action.label) {
    el.toastAction.textContent = action.label;
    el.toastAction.hidden = false;
    el.toast.classList.add('has-action');
    el.toastAction.onclick = () => {
      hideToast();
      action.onClick();
    };
    // 有按钮时要留够时间给人点
    duration = Math.max(duration, 5000);
  } else {
    el.toastAction.hidden = true;
    el.toastAction.onclick = null;
    el.toast.classList.remove('has-action');
  }

  el.toast.classList.add('show');
  toastTimer = setTimeout(hideToast, duration);
}

function setStatus(message, kind = '') {
  el.status.textContent = message;
  el.status.className = `status ${kind}`.trim();
  el.status.title = message;
}

function updateMeta() {
  syncAttachments();
  const text = getEditorText();
  const parts = [];
  if (attachments.length) parts.push(`${attachments.length} 张图片`);
  parts.push(`${text.length} 字`);
  el.counter.textContent = parts.join(' · ');
}

/**
 * 用户用退格键把缩略图删掉时，DOM 变了但 attachments 还没变。
 * 每次统计前按 DOM 里的实际节点校对一遍，避免把已删除的图片发出去。
 */
function syncAttachments() {
  const alive = attachments.filter((item) =>
    el.editor.querySelector(`.img-chip[data-id="${item.id}"]`)
  );
  if (alive.length !== attachments.length) {
    console.log(`[输入框] 同步图片列表：${attachments.length} → ${alive.length}`);
    attachments = alive;
  }
}

/* -------------------------- 编辑器文本读取 -------------------------- */
/**
 * 读取可编辑区域里的纯文本。
 * 缩略图（.img-chip）是 contenteditable=false 的节点，直接读 innerText
 * 会把按钮上的「×」也带出来，所以自己遍历一遍。
 */
function getEditorText() {
  let out = '';
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue || '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const nodeEl = node;
    if (nodeEl.classList && nodeEl.classList.contains('img-chip')) return; // 跳过图片节点
    if (nodeEl.tagName === 'BR') {
      out += '\n';
      return;
    }
    const isBlock = /^(DIV|P|LI|TR|H[1-6]|BLOCKQUOTE)$/.test(nodeEl.tagName);
    if (isBlock && out && !out.endsWith('\n')) out += '\n';
    nodeEl.childNodes.forEach(walk);
    if (isBlock && out && !out.endsWith('\n')) out += '\n';
  };
  el.editor.childNodes.forEach(walk);
  return out
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------------------------- 图片处理 ---------------------------- */
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('FileReader 读取失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

function dataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

/**
 * 体积过大的图片做一次缩放 + 转 JPEG。
 * 目的不是省磁盘，而是避免几 MB 的 base64 在 IPC 和 executeJavaScript
 * 参数里来回拷贝，导致窗口卡顿甚至注入超时。
 */
async function shrinkImage(dataUrl, maxEdge = 2000, quality = 0.9) {
  try {
    const img = await loadImage(dataUrl);
    const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
    const scale = Math.min(1, maxEdge / longest);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // 透明 PNG 转 JPEG 时铺白底，避免变黑
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch (err) {
    console.warn('[renderer] 图片压缩失败，继续使用原图', err);
    return null;
  }
}

/** 把 File 变成可广播的 dataURL，必要时压缩 */
async function fileToDataUrl(file) {
  let dataUrl = await readAsDataURL(file);

  if (dataUrlBytes(dataUrl) > MAX_IMAGE_BYTES) {
    console.log(
      `[renderer] 图片 ${(file.size / 1024 / 1024).toFixed(2)}MB 超过 5MB，尝试压缩`
    );
    const compressed = await shrinkImage(dataUrl);
    if (compressed) dataUrl = compressed;
  }
  return dataUrl;
}

function caretRange() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.editor.contains(range.commonAncestorContainer)) return null;
  return range;
}

function insertNodeAtCaret(node) {
  const range = caretRange();
  if (range) {
    range.deleteContents();
    range.insertNode(node);
  } else {
    el.editor.appendChild(node);
  }

  // 光标挪到新节点之后，方便继续打字
  const sel = window.getSelection();
  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
  el.editor.focus();
}

function createImageChip(att) {
  const wrap = document.createElement('span');
  wrap.className = 'img-chip';
  wrap.contentEditable = 'false'; // 缩略图不能被光标拆分
  wrap.dataset.id = att.id;

  const img = document.createElement('img');
  img.src = att.dataUrl;
  img.alt = '已粘贴的图片';
  img.draggable = false;

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'chip-del';
  del.textContent = '×';
  del.title = '移除这张图片';
  // 阻止 mousedown 抢走光标，否则删除后光标会跳到开头
  del.addEventListener('mousedown', (event) => event.preventDefault());
  del.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    removeAttachment(att.id);
  });

  wrap.append(img, del);
  return wrap;
}

function removeAttachment(id) {
  const index = attachments.findIndex((item) => item.id === id);
  if (index === -1) return;
  attachments.splice(index, 1);
  const node = el.editor.querySelector(`.img-chip[data-id="${id}"]`);
  if (node) node.remove();
  updateMeta();
  console.log(`[输入框] 移除图片 ${id}，剩余 ${attachments.length} 张`);
}

async function addImageFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    console.warn('[renderer] 忽略非图片文件', file && file.type);
    return;
  }
  pendingImages += 1;
  try {
    let dataUrl = await fileToDataUrl(file);
    let bytes = dataUrlBytes(dataUrl);

    if (bytes > MAX_IMAGE_BYTES) {
      toast(`单张图片超过 5MB（${(bytes / 1024 / 1024).toFixed(1)}MB），已跳过`);
      console.warn('[renderer] 图片过大，已跳过', bytes);
      return;
    }

    const att = { id: `img-${++attachmentSeq}`, dataUrl, bytes };
    attachments.push(att);
    insertNodeAtCaret(createImageChip(att));
    updateMeta();
    console.log(
      `[输入框] 添加图片 ${att.id}，${(bytes / 1024).toFixed(0)}KB，共 ${attachments.length} 张`
    );
  } catch (err) {
    console.error('[renderer] 读取图片失败', err);
    toast('图片读取失败，请换一张试试');
  } finally {
    pendingImages -= 1;
  }
}

/** 等待正在解码的图片落地（最多等 timeout 毫秒） */
async function waitForPendingImages(timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (pendingImages > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/* ----------------------------- 粘贴事件 ----------------------------- */
/**
 * Ctrl+V：
 *   - 剪贴板里只有文字 → 交给浏览器默认行为
 *   - 含图片 → 阻止默认行为（否则会插入一整段 base64/文件名），
 *     文字自己插进去，图片转成 dataURL 并插入缩略图
 */
el.editor.addEventListener('paste', (event) => {
  const clipboard = event.clipboardData;
  if (!clipboard) return;

  const items = Array.from(clipboard.items || []);
  const imageItems = items.filter(
    (item) => item.kind === 'file' && item.type && item.type.startsWith('image/')
  );
  if (imageItems.length === 0) return; // 纯文本粘贴走默认逻辑

  event.preventDefault();

  const plainText = clipboard.getData('text/plain');
  if (plainText) {
    try {
      document.execCommand('insertText', false, plainText);
    } catch (err) {
      console.warn('[输入框] 插入粘贴文本失败', err);
    }
  }

  imageItems.forEach((item) => {
    const file = item.getAsFile();
    if (!file) return;
    addImageFile(file).catch((err) => console.error('[renderer] addImageFile 异常', err));
  });
});

// 本地选图
el.btnImage.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  const files = Array.from(el.fileInput.files || []);
  files.forEach((file) => {
    addImageFile(file).catch((err) => console.error('[renderer] addImageFile 异常', err));
  });
  el.fileInput.value = ''; // 允许重复选择同一张图
});

el.editor.addEventListener('input', updateMeta);

/* ---------------------------- 清空 / 发送 ---------------------------- */
function clearEditor(focus = true) {
  el.editor.innerHTML = '';
  attachments = [];
  updateMeta();
  if (focus) el.editor.focus();
}

el.btnClear.addEventListener('click', () => {
  clearEditor();
  setStatus('已清空输入框');
});

let sending = false;

async function submitAll() {
  if (sending) return;

  sending = true;
  el.btnSend.disabled = true;
  el.btnSend.textContent = '发送中…';

  try {
    // 图片可能还在解码（尤其是大截图），先等它落地，否则会漏图
    await waitForPendingImages();
    syncAttachments();

    const text = getEditorText();
    const oversized = attachments.filter((item) => item.bytes > MAX_IMAGE_BYTES);
    const usable = attachments.filter((item) => item.bytes <= MAX_IMAGE_BYTES);
    if (oversized.length) toast('已跳过体积超限的图片');

    const images = usable.map((item) => item.dataUrl);

    if (!text && images.length === 0) {
      toast('请先输入文字，或粘贴一张图片');
      return;
    }

    if (!PANES.length) {
      toast('还没有添加任何模型，先到设置里加一个');
      return;
    }

    const totalBase64 = images.reduce((sum, item) => sum + item.length, 0);
    if (totalBase64 > MAX_TOTAL_BASE64) {
      toast('图片总量过大，请减少图片数量后重试');
      return;
    }

    const payload = {
      id: `p-${Date.now().toString(36)}`,
      text,
      images,
      from: 'single-window',
      ts: Date.now(),
    };

    console.log(
      `[输入框] 广播 #${payload.id}｜文字 ${text.length} 字｜图片 ${images.length} 张` +
        `｜base64 ${(totalBase64 / 1024).toFixed(0)}KB`
    );

    // 有 preload 就走 IPC（保持「广播」语义，将来多开窗口也能用）；
    // 万一 preload 没加载，直接在本窗口内分发，功能不至于瘫掉。
    if (bridge) {
      bridge.broadcastPrompt(payload);
      setStatus('已广播，等待各栏注入结果…', 'warn');
    } else {
      console.warn('[renderer] window.aiBridge 不存在，改为窗口内直接分发');
      handlePrompt(payload);
    }

    clearEditor();
    toast(`已发送：${images.length ? images.length + ' 张图 + ' : ''}${text.length} 字`);
  } catch (err) {
    console.error('[renderer] 发送失败', err);
    setStatus('发送失败：' + err.message, 'err');
    toast('发送失败，请看控制台日志');
  } finally {
    // 短暂冷却，防止连点造成多次广播
    setTimeout(() => {
      sending = false;
      el.btnSend.disabled = false;
      el.btnSend.textContent = '全部发送';
    }, 700);
  }
}

el.btnSend.addEventListener('click', () => {
  submitAll();
});

// 回车发送，Shift+Enter 换行；中文输入法组词期间的回车不发送
el.editor.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (event.isComposing || event.keyCode === 229) return; // 输入法正在组词
  if (event.shiftKey) return; // 换行
  event.preventDefault();
  submitAll();
});

/* ---------------------------- 侧栏 / 抽屉事件 ---------------------------- */
el.btnCollapse.addEventListener('click', () => setCollapsed(!sidebarCollapsed));
el.btnAddModel.addEventListener('click', openSettings);
el.btnSettings.addEventListener('click', openSettings);
el.btnCloseSettings.addEventListener('click', closeSettings);
el.drawerMask.addEventListener('click', closeSettings);
el.btnAddCustom.addEventListener('click', () => {
  addCustomModel().catch((err) => console.error('[renderer] 添加自定义模型失败', err));
});
el.btnReset.addEventListener('click', () => {
  resetPanels().catch((err) => console.error('[renderer] 恢复默认失败', err));
});

// 自定义模型的两个输入框：回车直接提交
[el.customName, el.customUrl].forEach((input) => {
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addCustomModel().catch((err) => console.error('[renderer] 添加自定义模型失败', err));
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // 退出所有账号确认框优先关闭
  if (el.logout.classList.contains('open')) {
    closeLogout();
    return;
  }
  // 免责声明优先：强制模式下 Esc 无效（必须勾选同意），查看模式下才关
  if (el.disclaimer.classList.contains('open')) {
    if (!disclaimerForced) closeDisclaimer();
    else toast('请先勾选「我已阅读并同意」，再点「同意并继续」');
    return;
  }
  if (el.tutorial.classList.contains('open')) {
    closeTutorial();
    return;
  }
  // 沉浸模式优先：Esc 先恢复三等分
  if (focusKey) {
    exitFocus();
    return;
  }
  if (el.drawer.classList.contains('open')) closeSettings();
});

/* ==================================================================
 * 3.5 ★ AI 总结：提取三栏最新回答 → 调大模型 API → 流式渲染 Markdown
 * ------------------------------------------------------------------
 * 独立于上面的「注入提问」流程，只读三栏网页内容，不向网页写任何东西。
 * 分为四块：
 *   (a) 配置的读写（localStorage）
 *   (b) 轻量 Markdown 渲染器（内置，规避 CSP 不能引 CDN 的限制）
 *   (c) 从 webview 提取最新回答 + 拼 prompt + 请求 API（SSE 流式）
 *   (d) 弹窗开关与事件绑定
 * ================================================================== */

/* ------------------------ (a) 配置读写 ------------------------ */
const API_CONFIG_KEY = 'ai-summary-api-config';
const API_CONFIG_DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
};

/**
 * 预设服务商列表：点一下就把 Base URL + Model 填好，用户只补 API Key。
 * 都是 OpenAI 兼容接口；Base URL 填到协议根路径即可（normalizeBaseUrl 会自动补 /chat/completions）。
 */
const API_PRESETS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', color: '#4d6bfe' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', color: '#2f6bd8' },
  { name: '千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', color: '#7c5cff' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', color: '#2b3446' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', color: '#0f9d76' },
];

/** 读取本地保存的 API 配置；缺字段回退默认值 */
function loadApiConfig() {
  try {
    const raw = localStorage.getItem(API_CONFIG_KEY);
    if (!raw) return { ...API_CONFIG_DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      baseUrl: (parsed.baseUrl || API_CONFIG_DEFAULTS.baseUrl).trim(),
      apiKey: parsed.apiKey || '',
      model: (parsed.model || API_CONFIG_DEFAULTS.model).trim(),
    };
  } catch (err) {
    console.warn('[总结] 读取 API 配置失败，使用默认值', err);
    return { ...API_CONFIG_DEFAULTS };
  }
}

/** 保存配置到 localStorage */
function saveApiConfig(config) {
  try {
    localStorage.setItem(API_CONFIG_KEY, JSON.stringify(config));
    return true;
  } catch (err) {
    console.error('[总结] 保存 API 配置失败', err);
    return false;
  }
}

/* ------------------------ (b) 轻量 Markdown 渲染器 ------------------------
 * 项目 CSP 为 script-src 'self'，无法引 CDN 的 marked.js；项目又没有任何 npm
 * 依赖（纯 Electron 直接 loadFile）。所以这里内置一个覆盖常用语法的轻量渲染器：
 * 代码块、行内代码、标题、表格、引用、列表、分隔线、加粗/斜体/删除线、链接。
 * 输出前先做 HTML 转义，防止总结内容里的 <script> 之类被当成标签执行。
 * ------------------------------------------------------------------ */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 渲染一行内联元素：加粗/斜体/删除线/行内代码/链接 */
function renderInline(text) {
  let s = escapeHtml(text);
  // 行内代码（先处理，避免里面的 *、_ 被误判）
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 链接 [文字](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 加粗 **x** 或 __x__
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // 斜体 *x* 或 _x_
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  // 删除线 ~~x~~
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s;
}

/** 把一段 Markdown 文本转成 HTML */
function markdownToHtml(md) {
  if (!md) return '';
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let inList = null; // 'ul' | 'ol'
  let inTable = false;
  let tableRows = [];
  let inQuote = false;

  const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
  const closeTable = () => {
    if (inTable) {
      // 渲染累积的表格行
      const html = ['<table>'];
      tableRows.forEach((row, idx) => {
        const cells = row.map((c) => (idx === 0 ? '<th>' : '<td>') + renderInline(c) + (idx === 0 ? '</th>' : '</td>'));
        html.push(`<tr>${cells.join('')}</tr>`);
      });
      html.push('</table>');
      out.push(html.join(''));
      tableRows = [];
      inTable = false;
    }
  };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };

  const isTableSep = (line) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && /-/.test(line) && /\|/.test(line);
  const parseTableRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw;

    // ---- 代码块 ----
    if (/^```/.test(line.trim())) {
      closeList(); closeTable(); closeQuote();
      const lang = line.trim().slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++; // 跳过结束的 ```
      const code = escapeHtml(buf.join('\n'));
      out.push(`<pre><code>${code}</code></pre>`);
      continue;
    }

    // ---- 表格 ----
    if (/^\s*\|/.test(line) && line.trim().endsWith('|')) {
      closeList(); closeQuote();
      if (!inTable) { inTable = true; tableRows = []; }
      tableRows.push(parseTableRow(line));
      i++;
      // 下一行是分隔行则跳过
      if (i < lines.length && isTableSep(lines[i])) i++;
      continue;
    }
    closeTable();

    // ---- 引用 ----
    if (/^\s*>/.test(line)) {
      closeList();
      const text = line.replace(/^\s*>\s?/, '');
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      out.push(`<p>${renderInline(text)}</p>`);
      i++;
      continue;
    }
    closeQuote();

    // ---- 无序列表 ----
    if (/^\s*[-*+]\s+/.test(line)) {
      closeTable();
      if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
      out.push(`<li>${renderInline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`);
      i++;
      continue;
    }

    // ---- 有序列表 ----
    if (/^\s*\d+[.)]\s+/.test(line)) {
      closeTable();
      if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
      out.push(`<li>${renderInline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
      i++;
      continue;
    }
    closeList();

    // ---- 标题 ----
    const h = /^(#{1,4})\s+(.*)$/.exec(line.trim());
    if (h) {
      closeTable();
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // ---- 分隔线 ----
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeTable();
      out.push('<hr />');
      i++;
      continue;
    }

    // ---- 空行 ----
    if (line.trim() === '') {
      closeList(); closeTable();
      i++;
      continue;
    }

    // ---- 普通段落 ----
    out.push(`<p>${renderInline(line)}</p>`);
    i++;
  }

  closeList(); closeTable(); closeQuote();
  return out.join('');
}

/* ------------------------ (c) 提取 + 请求 + 流式渲染 ------------------------ */

/**
 * 注入到 webview 里的提取脚本：抓取聊天流里「最后一段 AI 回复」的文本。
 * 自包含、无外部依赖，返回最后 1500 字符（超出 Token 限制的截断策略）。
 * 尽量命中各站点通用的消息容器，再退回到 body 全文。
 */
const EXTRACT_SCRIPT = `(() => {
  const MAX_LEN = 1500;
  const text = (n) => (n ? (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim() : '');

  // 优先找「AI 回复」的候选容器：按常见 class 匹配，取最后一个可见节点
  const selectors = [
    '[class*="markdown"]', '[class*="message"]', '[class*="answer"]',
    '[class*="assistant"]', '[class*="reply"]', '[class*="bubble"]',
    '[class*="content"]', '[class*="chat"]', '[data-testid*="message"]',
  ];
  let best = null;
  let bestLen = 0;
  for (const sel of selectors) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(sel)); } catch (_) {}
    for (const node of nodes) {
      if (!node.isConnected) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 10) continue;
      const t = text(node);
      if (t.length > bestLen) { bestLen = t.length; best = t; }
    }
  }

  let result = best || text(document.body);
  if (result.length > MAX_LEN) result = result.slice(result.length - MAX_LEN);
  return result;
})()`;

/**
 * 从三个 webview 里提取各自的最新回答文本。
 * 逐个执行 EXTRACT_SCRIPT，失败或为空时用占位符兜底，不阻断整体流程。
 */
async function extractAnswers() {
  const results = [];
  for (const pane of PANES) {
    const name = pane.cfg.name;
    try {
      if (pane.destroyed) {
        results.push({ name, text: '', ok: false });
        continue;
      }
      // 等 webview 就绪再执行，避免拿到空白页
      await paneWhenReady(pane, 4000);
      const text = await pane.wv.executeJavaScript(EXTRACT_SCRIPT, true);
      const cleaned = String(text || '').trim();
      results.push({ name, text: cleaned, ok: cleaned.length > 0 });
      console.log(`[总结] ${name} 提取到 ${cleaned.length} 字`);
    } catch (err) {
      console.warn(`[总结] ${name} 提取失败`, err && err.message);
      results.push({ name, text: '', ok: false });
    }
  }
  return results;
}

/** 拼接发送给大模型的 prompt */
function buildSummaryPrompt(answers) {
  const parts = answers.map((a, idx) => {
    const body = a.text ? a.text : '（未提取到内容）';
    return `【AI-${idx + 1} 的回答（${a.name}）】：\n${body}`;
  });
  return (
    `你是一个答案评审专家。以下是${answers.length}个不同的 AI 对同一问题的回答：\n\n` +
    parts.join('\n\n') +
    `\n\n请先直接提取出它们的【最终答案】，如果答案一致请明确标出；如果有差异，请对比分析。` +
    `最后用 Markdown 表格形式总结它们各自的主要思路和亮点。`
  );
}

/** 把 Base URL 规范化：确保以 /chat/completions 结尾（兼容用户少写/多写斜杠） */
function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  url = url.replace(/\/+$/, ''); // 去掉末尾斜杠
  // 已经是完整的 chat/completions 地址就不再拼
  if (/\/chat\/completions$/i.test(url)) return url;
  return url + '/chat/completions';
}

/** 中止上一个尚未完成的总结请求（避免连点两次串流） */
let summaryAbort = null;
let summarizing = false;

/**
 * 核心流程：提取三栏答案 → 请求 API（SSE 流式）→ 逐段渲染 Markdown。
 * 全程 try-catch，任何一步失败都会在弹窗里给出友好提示。
 */
async function runSummary() {
  if (summarizing) return;
  summarizing = true;

  const config = loadApiConfig();
  if (!config.apiKey) {
    toast('请先在「API 设置」里填入 API Key');
    openApiSettings();
    summarizing = false;
    return;
  }

  // 打开弹窗并进入「加载中」状态
  openSummary();
  setSummaryState('正在提取三家答案…', 'loading');
  el.summaryContent.textContent = '';
  el.summarySub.textContent = '正在从三个面板抓取最新回答';

  try {
    // 1) 提取
    const answers = await extractAnswers();
    const validCount = answers.filter((a) => a.ok).length;
    if (validCount === 0) {
      setSummaryState('没有提取到任何回答，请先在三个面板完成提问', 'err');
      el.summarySub.textContent = '未获取到有效内容';
      return;
    }
    el.summarySub.textContent = `已提取 ${validCount}/${answers.length} 栏回答，正在生成总结…`;

    // 2) 拼 prompt + 请求体
    const prompt = buildSummaryPrompt(answers);
    const url = normalizeBaseUrl(config.baseUrl);
    const body = {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };

    // 3) 发起流式请求（可中止）
    summaryAbort = new AbortController();
    setSummaryState('正在请求大模型…', 'loading');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: summaryAbort.signal,
    });

    if (!response.ok) {
      // 尝试读出错误信息，给出更友好的提示
      let detail = '';
      try {
        const errText = await response.text();
        detail = errText.slice(0, 300);
      } catch (_) {}
      throw new Error(`API 返回 ${response.status}${detail ? '：' + detail : ''}`);
    }
    if (!response.body) {
      throw new Error('当前环境不支持流式读取（response.body 为空）');
    }

    // 4) 解析 SSE 流
    setSummaryState('正在生成总结…', 'loading');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let accumulated = '';      // 累积的全部增量文本
    let buffer = '';           // 跨 chunk 的残留缓冲（SSE 可能被切断）
    let renderTimer = null;    // 节流渲染，避免每个 delta 都触发一次 DOM 重排

    // 渲染函数：把累积文本转 HTML 并自动滚动到底部
    const render = () => {
      el.summaryContent.innerHTML =
        markdownToHtml(accumulated) +
        '<span class="summary-cursor" aria-hidden="true"></span>';
      const box = el.summaryContent.parentElement;
      box.scrollTop = box.scrollHeight;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 把新字节拼进缓冲，按行解析
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 最后一段可能是不完整行，留到下次
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        // 解析 JSON，提取 choices[0].delta.content
        try {
          const json = JSON.parse(data);
          const delta = json.choices && json.choices[0] && json.choices[0].delta;
          const content = delta && delta.content;
          if (typeof content === 'string' && content) {
            accumulated += content;
            // 节流：合并同一帧内的多次渲染，最多每 40ms 刷一次
            if (!renderTimer) {
              renderTimer = setTimeout(() => { renderTimer = null; render(); }, 40);
            }
          }
        } catch (_) {
          // 某些服务商会发 keep-alive 或非标准行，忽略即可
        }
      }
    }

    // 5) 收尾：确保最后一次渲染、清除光标
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    el.summaryContent.innerHTML = markdownToHtml(accumulated);
    const box = el.summaryContent.parentElement;
    box.scrollTop = box.scrollHeight;

    if (!accumulated) {
      setSummaryState('模型没有返回内容，请检查 Model 名称或稍后重试', 'err');
    } else {
      setSummaryState(`总结完成 · 共 ${accumulated.length} 字`, 'done');
      el.summarySub.textContent = '综合三家答案的共识与差异';
    }
  } catch (err) {
    // 用户主动关闭 / 再次点击导致的 AbortError 不当作错误
    if (err && err.name === 'AbortError') {
      setSummaryState('已停止', '');
    } else {
      console.error('[总结] 请求失败', err);
      setSummaryState('总结失败：' + (err && err.message ? err.message : String(err)), 'err');
      el.summarySub.textContent = '请检查 API 配置是否正确';
    }
  } finally {
    summaryAbort = null;
    summarizing = false;
  }
}

/* ------------------------ (d) 弹窗开关与事件绑定 ------------------------ */

function setSummaryState(text, kind) {
  el.summaryState.textContent = text;
  el.summaryState.className = 'state ' + (kind || '');
  el.summaryState.innerHTML =
    (kind === 'loading'
      ? '<span class="spin"></span>' + escapeHtml(text)
      : escapeHtml(text));
}

/** 渲染预设服务商按钮，并高亮与当前配置匹配的那一个 */
function renderApiPresets(current) {
  if (!el.apiPresets) return;
  el.apiPresets.textContent = '';

  API_PRESETS.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'api-preset';

    const dot = document.createElement('span');
    dot.className = 'preset-dot';
    dot.style.background = preset.color;
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(preset.name));

    // 当前 Base URL 与该预设一致时高亮
    if (current && (current.baseUrl || '').replace(/\/+$/, '') === preset.baseUrl.replace(/\/+$/, '')) {
      btn.classList.add('is-active');
    }

    // 点选：自动填入 Base URL + Model（保留已填的 API Key）
    btn.addEventListener('click', () => {
      el.apiBaseUrl.value = preset.baseUrl;
      el.apiModel.value = preset.model;
      // 高亮切换
      el.apiPresets.querySelectorAll('.api-preset').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    });

    el.apiPresets.appendChild(btn);
  });
}

function openApiSettings() {
  const config = loadApiConfig();
  el.apiBaseUrl.value = config.baseUrl;
  el.apiKey.value = config.apiKey;
  el.apiModel.value = config.model;
  renderApiPresets(config);
  el.apiSettings.classList.add('open');
  el.apiSettings.setAttribute('aria-hidden', 'false');
  el.apiSettingsMask.classList.add('open');
  el.apiBaseUrl.focus();
}

function closeApiSettings() {
  el.apiSettings.classList.remove('open');
  el.apiSettings.setAttribute('aria-hidden', 'true');
  el.apiSettingsMask.classList.remove('open');
}

function openSummary() {
  el.summaryModal.classList.add('open');
  el.summaryModal.setAttribute('aria-hidden', 'false');
  el.summaryMask.classList.add('open');
}

function closeSummary() {
  // 关闭时若仍在请求中，主动中止
  if (summaryAbort) summaryAbort.abort();
  el.summaryModal.classList.remove('open');
  el.summaryModal.setAttribute('aria-hidden', 'true');
  el.summaryMask.classList.remove('open');
}

// 侧栏「API 设置」按钮
el.btnApiSettings.addEventListener('click', openApiSettings);

// API 设置弹窗：保存 / 取消 / 遮罩点击 / 回车保存
el.btnApiSave.addEventListener('click', () => {
  const config = {
    baseUrl: el.apiBaseUrl.value.trim() || API_CONFIG_DEFAULTS.baseUrl,
    apiKey: el.apiKey.value.trim(),
    model: el.apiModel.value.trim() || API_CONFIG_DEFAULTS.model,
  };
  if (!config.baseUrl) { toast('Base URL 不能为空'); return; }
  if (!config.apiKey) { toast('请填写 API Key'); return; }
  if (!config.model) { toast('请填写 Model 名称'); return; }
  if (saveApiConfig(config)) {
    toast('API 配置已保存');
    closeApiSettings();
  } else {
    toast('保存失败，请重试');
  }
});
el.btnApiCancel.addEventListener('click', closeApiSettings);
el.apiSettingsMask.addEventListener('click', closeApiSettings);
[el.apiBaseUrl, el.apiKey, el.apiModel].forEach((input) => {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      el.btnApiSave.click();
    }
  });
});

// 总结弹窗：关闭 / 遮罩点击 / 复制全文
el.btnSummaryClose.addEventListener('click', closeSummary);
el.summaryMask.addEventListener('click', closeSummary);
el.btnSummaryCopy.addEventListener('click', async () => {
  const text = el.summaryContent.innerText || el.summaryContent.textContent || '';
  if (!text) { toast('没有可复制的内容'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制总结全文');
  } catch (err) {
    toast('复制失败，请手动选中复制');
  }
});

// 底部「✨ 总结答案」按钮
el.btnSummarize.addEventListener('click', () => {
  runSummary().catch((err) => {
    console.error('[总结] 未捕获异常', err);
    setSummaryState('总结失败：' + (err && err.message ? err.message : String(err)), 'err');
  });
});

// Esc 关闭两个新弹窗（追加到已有的全局 Esc 处理之后）
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (el.summaryModal.classList.contains('open')) { closeSummary(); return; }
  if (el.apiSettings.classList.contains('open')) { closeApiSettings(); return; }
});

/* ------------------------ 微信公众号二维码浮层 ------------------------
 * 浮层放在 body 级、position: fixed，否则会被侧栏的 overflow: hidden 裁掉。
 * 鼠标悬停到「微信公众号」条目时，用 getBoundingClientRect 算出固定坐标，
 * 加 .show 触发「慢慢浮现」过渡；移开即移除。 */
function showWechatQr() {
  const trigger = el.wechatTrigger;
  const qr = el.wechatQr;
  if (!trigger || !qr) return;

  const rect = trigger.getBoundingClientRect();
  // 浮层贴在条目右侧、垂直居中对齐
  const x = rect.right + 12;
  let y = rect.top + rect.height / 2;

  // 防止浮层底部超出窗口：往上收一点
  const qrHeight = qr.offsetHeight || 180;
  if (y + qrHeight / 2 > window.innerHeight - 12) {
    y = window.innerHeight - 12 - qrHeight / 2;
  }
  if (y - qrHeight / 2 < 12) y = 12 + qrHeight / 2;

  qr.style.setProperty('--qr-x', `${Math.round(x)}px`);
  qr.style.setProperty('--qr-y', `${Math.round(y)}px`);
  qr.classList.add('show');
}

function hideWechatQr() {
  if (el.wechatQr) el.wechatQr.classList.remove('show');
}

if (el.wechatTrigger && el.wechatQr) {
  el.wechatTrigger.addEventListener('mouseenter', showWechatQr);
  el.wechatTrigger.addEventListener('mouseleave', hideWechatQr);
}

/* ==================================================================
 * 4. 收到提示词 → 分别注入各栏
 * ================================================================== */

/** 把注入结果翻译成一句人话，用于底部状态行 */
function describeResult(raw) {
  if (raw.startsWith('ok:')) return '已发送';
  if (raw.startsWith('need-login')) return '需要先登录';
  if (raw.startsWith('no-input')) return '未找到输入框';
  if (raw.startsWith('skip-empty')) return '空内容';
  if (raw.startsWith('error')) return '注入异常';
  return raw;
}

/**
 * 全局发送流水线：一次提问的「填内容 + 一起发」跑完，才处理下一次提问。
 * 不加这个锁的话，连续两次提问可能交叉执行——第二次的文字先填进去，
 * 第一次的发送再点下去，就发错内容了。
 */
let promptPipeline = Promise.resolve();

function handlePrompt(payload) {
  promptPipeline = promptPipeline
    .then(() => runPrompt(payload))
    .catch((err) => {
      console.error('[renderer] 注入流程异常', err);
      setStatus('注入流程异常：' + (err && err.message), 'err');
      return [];
    });
  return promptPipeline;
}

/**
 * 两阶段发送：
 *   阶段一 prepare —— 各栏并行把文字/图片填进各自的输入框，并等发送按钮就绪；
 *   阶段二 send    —— 全部就绪后，同一刻一起点发送，做到「一起发」。
 * 图片上传慢的那一栏，最多让其它栏等它几秒，但发出去的时间点是齐的。
 */
async function runPrompt(payload) {
  const count = PANES.length;
  if (!count) {
    setStatus('没有可用的面板', 'err');
    return [];
  }

  console.log(
    `[renderer] 收到广播 #${payload.id}｜文字 ${(payload.text || '').length} 字` +
      `｜图片 ${(payload.images || []).length} 张，开始准备 ${count} 栏`
  );

  PANES.forEach((pane) => setPaneState(pane, 'running', '正在填入…'));
  setStatus('正在把问题填入各栏…', 'warn');
  const startedAt = performance.now();

  // ---------- 阶段一：只填不发 ----------
  const prepResults = await Promise.all(
    PANES.map((pane) => queueInject(pane, { ...payload, action: 'prepare' }))
  );
  const readyFlags = prepResults.map((result) => result.startsWith('ready:'));
  const readyCount = readyFlags.filter(Boolean).length;
  const prepareCost = Math.round(performance.now() - startedAt);
  console.log(
    `[renderer] ${count} 栏准备完成（${prepareCost}ms，就绪 ${readyCount}/${count}）`,
    prepResults
  );

  if (readyCount === 0) {
    const summary = PANES.map((pane, i) => `${pane.cfg.name} ${describeResult(prepResults[i])}`);
    setStatus(summary.join(' · '), 'err');
    return prepResults;
  }

  // ---------- 阶段二：同一刻一起发 ----------
  setStatus(`已就绪 ${readyCount}/${count}，正在同时发送…`, 'warn');

  const sendStartedAt = performance.now();
  const finalResults = await Promise.all(
    PANES.map(async (pane, i) => {
      if (!readyFlags[i]) return prepResults[i]; // 没填进去的栏不参与发送
      return queueInject(pane, { ...payload, action: 'send' });
    })
  );
  console.log(
    `[renderer] ${count} 栏同时发送完成（${Math.round(performance.now() - sendStartedAt)}ms）`,
    finalResults
  );

  const summary = PANES.map((pane, i) => `${pane.cfg.name} ${describeResult(finalResults[i])}`);
  const okCount = finalResults.filter((r) => r.startsWith('ok:')).length;
  const kind = okCount === finalResults.length ? 'ok' : okCount > 0 ? 'warn' : 'err';

  setStatus(summary.join(' · '), kind);
  console.log('[renderer] 各栏注入结果:', finalResults);
  return finalResults;
}

/** 每栏独立的串行队列，避免连续提问时两次注入抢同一个输入框 */
function queueInject(pane, payload) {
  pane.queue = pane.queue
    .then(() => injectPane(pane, payload))
    .catch((err) => {
      console.error(`[${pane.cfg.name}] 注入队列异常`, err);
      return `error:${err && err.message ? err.message : String(err)}`;
    });
  return pane.queue;
}

async function injectPane(pane, payload) {
  if (pane.destroyed) return 'error:pane-removed';

  const ready = await paneWhenReady(pane, 8000);
  if (!ready) console.warn(`[${pane.cfg.name}] webview 尚未就绪，仍然尝试注入`);
  if (pane.destroyed) return 'error:pane-removed';

  // 注意：action 一定要带过去，否则注入脚本会走默认的「一体化」流程
  const script = buildScript({
    text: payload.text || '',
    images: Array.isArray(payload.images) ? payload.images : [],
    action: payload.action || 'all',
  });

  const started = performance.now();
  try {
    // 第二个参数 true = 以「用户手势」身份执行，部分站点会检查这个
    const result = await pane.wv.executeJavaScript(script, true);
    const cost = Math.round(performance.now() - started);
    console.log(`[${pane.cfg.name}] 注入结果(${cost}ms):`, result);

    const text = String(result);
    if (pane.destroyed) return text;

    if (text.startsWith('ready:')) {
      // 第一阶段只是填好了，还没发，指示灯保持「进行中」
      setPaneState(pane, 'running', '已填入，等待统一发送');
    } else {
      setPaneState(pane, text.startsWith('ok:') ? 'ok' : 'err', text);
    }
    return text;
  } catch (err) {
    console.error(`[${pane.cfg.name}] executeJavaScript 失败`, err);
    const text = `error:${err && err.message ? err.message : String(err)}`;
    if (!pane.destroyed) setPaneState(pane, 'err', text);
    return text;
  }
}

// 订阅主进程广播；主进程会把消息再发回本窗口，实现「一次提问各家分发」
if (bridge) {
  bridge.onPrompt((payload) => {
    handlePrompt(payload).catch((err) => {
      console.error('[renderer] 处理广播失败', err);
      setStatus('注入流程异常：' + err.message, 'err');
    });
  });
}

/**
 * 把 injectedMain 的源码 + 参数拼成一段可在目标页面执行的表达式。
 * 用 JSON.stringify 序列化参数，几百 KB 的 base64 也能安全传递。
 */
function buildScript(payload) {
  return `(${injectedMain.toString()})(${JSON.stringify(payload)})`;
}

/* ==================================================================
 * 5. 启动
 * ================================================================== */

/**
 * 校准侧栏背景图的位置锚点。
 * 背景图用 `inset: 0 0 var(--sb-bottom-h) 0` 定位（底部向上抬「博客 + 按钮区」高度），
 * 只要把 `--sb-bottom-h` 设成 .sb-blogs 与 .sb-foot 的实际高度之和，主体就始终
 * 贴在博客上方——不管窗口多高、模型多少个都不会漂。
 * 侧栏折叠/展开、增删模型后这两块高度可能变，所以用 ResizeObserver 盯着更新。
 */
function calibrateSidebarBackground() {
  const blogsEl = document.querySelector('.sb-blogs');
  const footEl = document.querySelector('.sb-foot');
  if (!blogsEl || !footEl) return;

  const apply = () => {
    // 底部向上抬「博客 + 公众号 + 按钮区」三块的总高度，主体才始终落在博客上方
    const wechatEl = document.querySelector('.sb-wechat');
    const wechatH = wechatEl && !sidebarCollapsed ? wechatEl.offsetHeight : 0;
    const h = blogsEl.offsetHeight + wechatH + footEl.offsetHeight;
    sidebarEl.style.setProperty('--sb-bottom-h', `${h}px`);
  };

  apply();
  // 侧栏折叠会隐藏博客区文字、高度可能变化，随侧栏尺寸一起重算
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(apply).observe(sidebarEl);
    new ResizeObserver(apply).observe(blogsEl);
  }
}

async function bootstrap() {
  syncPanes(INITIAL.panels);
  setCollapsed(INITIAL.collapsed, false);
  updateMeta();
  el.editor.focus();
  // 校准侧栏背景图：让它始终贴着「博客」区块的上方，不随窗口高低漂移
  calibrateSidebarBackground();

  // 主进程是配置的唯一数据源：拿到后再校正一次（通常和首屏完全一致）
  if (bridge && bridge.getConfig) {
    try {
      const cfg = await bridge.getConfig();
      if (cfg) {
        if (Array.isArray(cfg.library) && cfg.library.length) MODEL_LIBRARY = cfg.library;
        if (Number(cfg.maxPanels)) MAX_PANELS = cfg.maxPanels;
        if (Array.isArray(cfg.panels) && cfg.panels.length) syncPanes(cfg.panels);
        if (typeof cfg.collapsed === 'boolean') setCollapsed(cfg.collapsed, false);
        if (typeof cfg.onboarded === 'boolean') onboarded = cfg.onboarded;
        if (typeof cfg.disclaimerAccepted === 'boolean') {
          disclaimerAccepted = cfg.disclaimerAccepted;
        }
      }
      console.log(
        `[renderer] 配置已同步：${PANES.length} 栏（${PANES.map((p) => p.cfg.name).join(' / ')}）`
      );
    } catch (err) {
      console.warn('[renderer] 读取配置失败，沿用首屏配置', err);
    }
  } else {
    console.warn('[renderer] 缺少 aiBridge.getConfig，设置改动无法持久化');
  }

  // 首次启动的门槛顺序是固定的：先强制阅读免责声明，同意之后才轮到使用教程。
  // 放在配置同步之后，状态以主进程为准（换机器 / 清缓存会重新弹）。
  if (!disclaimerAccepted) setTimeout(() => openDisclaimer(true), 260);
  else if (!onboarded) setTimeout(openTutorial, 260);
}

bootstrap().catch((err) => {
  console.error('[renderer] 启动失败', err);
});

/* ==================================================================
 * 6. ★★★ 注入脚本（真正跑在 AI 网页里的代码）★★★
 * ------------------------------------------------------------------
 * 这个函数不会在渲染进程执行，它被 toString() 后交给 executeJavaScript，
 * 所以：不能引用外部变量、不能调用本文件里的任何 helper。
 *
 * 三个站点的 DOM 千差万别，需要针对性调整的地方只有两处：
 *   (1) SITE_CONFIG —— 输入框 / 发送按钮的选择器、图片上传后的等待时长
 *   (2) ★ 标记的 findInput / findSendButton 里的兜底规则
 * 其它逻辑（文字注入、paste/drop 派发、结果返回）都是通用的。
 * ================================================================== */
async function injectedMain(payload) {
  const HOST = location.hostname;
  const log = (...args) => console.log('[inject]', ...args);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // 拟人化小工具：区间随机整数，发送前加一点「犹豫」停顿，节奏别太机械
  const randInt = (min, max) => Math.round(min + Math.random() * (max - min));

  /* ------------------------------------------------------------------
   * ★ 站点适配表：网站改版后优先改这里
   *   input  : 输入框候选选择器（数组顺序 = 优先级，越靠前越优先）
   *   send   : 发送按钮候选选择器
   *   imageSettleMs : 粘贴图片后等待上传完成的毫秒数（太短会发出空图）
   *   sendSettleMs  : 点击发送后，等待 DOM 反应的时间
   *
   * 下面这些选择器是按 2026-11 线上真实 DOM 校准过的，改版后如果
   * 日志里出现 no-input / 找不到发送按钮，优先回来改这里。
   * ------------------------------------------------------------------ */
  const SITE_CONFIG = {
    'www.doubao.com': {
      // 编辑器是 tiptap/ProseMirror；页面上另有一个隐藏 textarea，别选错
      input: [
        'div.tiptap.ProseMirror[contenteditable="true"]',
        '[data-testid="chat_input_input"]',
        'div[contenteditable="true"]',
      ],
      send: [
        '[data-testid="chat_input_send_button"]',
        'button[aria-label*="发送"]',
        'button[class*="send"]',
      ],
      imageSettleMs: 2200,
      sendSettleMs: 500,
    },
    'www.qianwen.com': {
      // 输入区是 contenteditable 的 div[role=textbox]，placeholder 是「向千问提问」
      input: [
        '[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"]',
        'textarea',
      ],
      send: [
        'button[aria-label="发送消息"]',
        'button[aria-label*="发送"]',
        '[class*="sendBtn"]',
        '[class*="send-btn"]',
      ],
      imageSettleMs: 2000,
      sendSettleMs: 500,
    },
    'deepseek.com': {
      // 输入框是 textarea（id=chat-input），发送按钮是无文字的图标按钮，
      // 找不到时靠 Enter 兜底；选择器以 2026-11 线上 DOM 校准
      input: [
        'textarea#chat-input',
        '[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"]',
        'textarea',
      ],
      send: [
        'button[aria-label*="发送"]',
        'div[role="button"][aria-label*="发送"]',
        '[class*="send-btn"]',
        '[class*="sendBtn"]',
      ],
      imageSettleMs: 2000,
      sendSettleMs: 500,
    },
    'www.kimi.com': {
      // 编辑器 class 是 chat-input-editor，发送按钮是个 div 不是 button
      input: [
        'div.chat-input-editor[contenteditable="true"]',
        '[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"]',
        'textarea',
      ],
      send: [
        'div.send-button-container',
        '[class*="send-button"]',
        'button[aria-label*="发送"]',
      ],
      imageSettleMs: 2000,
      sendSettleMs: 500,
    },
    'yuanbao.tencent.com': {
      // 元宝用的是 Quill 富文本（.ql-editor），发送键多为图标按钮
      input: [
        '.ql-editor[contenteditable="true"]',
        '[contenteditable="true"]',
        'textarea',
      ],
      send: [
        'a[class*="send"]',
        'button[class*="send"]',
        '[class*="send-btn"]',
        'button[aria-label*="发送"]',
      ],
      imageSettleMs: 2200,
      sendSettleMs: 500,
    },
    'chatglm.cn': {
      // 智谱清言：输入框通常是 textarea，找不到时退回可编辑 div
      input: [
        'textarea',
        '[contenteditable="true"]',
      ],
      send: [
        'button[aria-label*="发送"]',
        '[class*="send-btn"]',
        '[class*="sendBtn"]',
        '#send-btn',
      ],
      imageSettleMs: 2000,
      sendSettleMs: 500,
    },
    'yiyan.baidu.com': {
      // 文心一言：老版是 #chat-textarea，新版可能换成可编辑 div
      input: [
        '#chat-textarea',
        'textarea',
        '[contenteditable="true"]',
      ],
      send: [
        '#sendBtn',
        'button[aria-label*="发送"]',
        '[class*="send"]',
      ],
      imageSettleMs: 2000,
      sendSettleMs: 500,
    },
  };

  const DEFAULT_CONFIG = {
    input: [],
    send: [],
    imageSettleMs: 1800,
    sendSettleMs: 450,
  };

  const pickConfig = () => {
    const bareHost = HOST.replace(/^www\./, '');
    const hit = Object.keys(SITE_CONFIG).find((key) => {
      const bareKey = key.replace(/^www\./, '');
      return bareHost === bareKey || bareHost.endsWith('.' + bareKey) || bareHost.includes(bareKey);
    });
    return Object.assign({}, DEFAULT_CONFIG, hit ? SITE_CONFIG[hit] : {});
  };
  const cfg = pickConfig();

  /* ------------------------- 可见性判断 ------------------------- */
  const isVisible = (node) => {
    if (!node || !node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 14) return false;
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
      return false;
    }
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
      return false;
    }
    // 被遮罩 / 弹窗盖住的输入框不参与匹配
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
    const hitNode = document.elementFromPoint(x, y);
    if (hitNode && hitNode !== node && !node.contains(hitNode) && !hitNode.contains(node)) {
      return false;
    }
    return true;
  };

  /* -------------------------- 找输入框 -------------------------- */
  /**
   * 收集所有可编辑元素，并带上优先级。
   * 需求要求「contenteditable 优先于 textarea」，所以这里先按优先级、
   * 再按「离页面底部更近」排序——聊天输入框基本都在最下方。
   */
  function collectInputs() {
    const pool = [];
    const seen = new Set();

    const add = (selector, priority) => {
      let list = [];
      try {
        list = Array.from(document.querySelectorAll(selector));
      } catch (err) {
        log('选择器非法', selector, err && err.message);
        return;
      }
      for (const node of list) {
        if (seen.has(node) || !node.isConnected) continue;
        seen.add(node);
        const editable =
          node.tagName === 'TEXTAREA' ||
          node.isContentEditable ||
          node.getAttribute('contenteditable') === 'true';
        if (!editable) continue;
        // 只保留最外层可编辑节点，避免命中编辑器内部的 span
        if (node.parentElement && node.parentElement.closest('[contenteditable="true"]')) continue;
        if (node.disabled || node.readOnly) continue;
        if (!isVisible(node)) continue;
        pool.push({ node, priority });
      }
    };

    // 站点定制选择器优先级最高（0、1、2…），通用规则排后面
    cfg.input.forEach((selector, index) => add(selector, index));
    add('[contenteditable="true"]', 50);
    add('textarea', 100);

    pool.sort(
      (a, b) =>
        a.priority - b.priority ||
        b.node.getBoundingClientRect().bottom - a.node.getBoundingClientRect().bottom
    );
    return pool;
  }

  function findInput() {
    const pool = collectInputs();
    return pool.length ? pool[0].node : null;
  }

  /**
   * 粗略判断当前是不是停在登录页。
   * 未登录的栏没有输入框，如果死等 6 秒会拖慢另外两栏的发送节奏，
   * 这里提前退出，并把状态标成「需要先登录」。
   */
  function isLoginPage() {
    return /(^|\/)(sign[_-]?in|login|passport|auth)(\/|$)/i.test(location.pathname);
  }

  async function waitForInput(timeout) {
    const deadline = Date.now() + timeout;
    do {
      const node = findInput();
      if (node) return node;
      if (isLoginPage()) {
        log('页面停在登录页，先登录再提问');
        return null;
      }
      await sleep(80);
    } while (Date.now() < deadline);
    return null;
  }

  /* -------------------------- 注入文字 -------------------------- */
  /** 用一小段特征串判断文字到底有没有进编辑器（去掉空白再比对，避免格式差异） */
  function textLanded(target, text) {
    const probe = String(text || '').replace(/\s+/g, '').slice(0, 6);
    if (!probe) return true;
    const current = String(
      target.tagName === 'TEXTAREA' ? target.value : target.innerText || target.textContent || ''
    ).replace(/\s+/g, '');
    return current.includes(probe);
  }

  /** 把光标放进编辑器并全选内容，方便后续「覆盖式」写入 */
  function selectAllContent(target) {
    target.focus();
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * 用 paste 事件把纯文本送进编辑器。
   * ★ 千问（Slate）这类编辑器的内部状态只认 paste / beforeinput：
   *   直接改 DOM 或 execCommand 时文字能显示出来，但组件的 state 没变，
   *   发送按钮会一直是 disabled，点不动。paste 走的是站点自己的粘贴逻辑，
   *   状态能同步，按钮才会亮。
   */
  function pasteText(target, text) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      let evt;
      try {
        evt = new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
      } catch (err) {
        evt = document.createEvent('Event');
        evt.initEvent('paste', true, true);
      }
      if (!evt.clipboardData) {
        try {
          Object.defineProperty(evt, 'clipboardData', { value: dt });
        } catch (_) {}
      }
      target.focus();
      const notCanceled = target.dispatchEvent(evt);
      log('文本 paste 已派发，页面是否处理:', !notCanceled);
      return true;
    } catch (err) {
      log('文本 paste 失败', err && err.message);
      return false;
    }
  }

  async function setText(target, text) {
    if (!text) return true;

    if (target.tagName === 'TEXTAREA') {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      target.focus();
      descriptor.set.call(target, text);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(80);
      log('textarea 已写入，长度', text.length, '校验:', textLanded(target, text));
      return textLanded(target, text);
    }

    // 第一选择：paste。Slate / Lexical / ProseMirror 都会把它当作用户粘贴处理，
    // 组件内部状态能同步，发送按钮才会从 disabled 变成可用。
    selectAllContent(target);
    pasteText(target, text);
    await sleep(120);
    if (textLanded(target, text)) {
      log('paste 注入文字成功，长度', text.length);
      return true;
    }

    // 第二选择：execCommand（对普通 contenteditable 最快）
    for (let attempt = 1; attempt <= 2; attempt++) {
      selectAllContent(target);

      let ok = false;
      try {
        ok = document.execCommand('insertText', false, text);
      } catch (err) {
        log('execCommand insertText 抛错', err && err.message);
      }

      // 有些编辑器会异步重渲染，等一拍再读结果
      await sleep(90);
      if (textLanded(target, text)) {
        log(`execCommand insertText ${ok ? '成功' : '返回 false 但内容已写入'}，长度 ${text.length}`);
        return true;
      }

      // 最后兜底：直接改 DOM，再手动派发 input 事件
      log(`第 ${attempt} 轮文字未落地，退回 DOM 写入`);
      target.innerHTML = '';
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      target.appendChild(paragraph);
      target.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
      );

      const sel2 = getSelection();
      const range2 = document.createRange();
      range2.selectNodeContents(target);
      range2.collapse(false);
      sel2.removeAllRanges();
      sel2.addRange(range2);

      await sleep(90);
      if (textLanded(target, text)) return true;
      await sleep(120);
    }

    return false;
  }

  /* -------------------------- 注入图片 -------------------------- */
  /**
   * base64 dataURL → File。
   * 这里刻意不用 fetch(dataURL)：部分站点 CSP 的 connect-src 不含 data:，
   * fetch 会被拦；atob 手动解码不经过网络栈，最稳。
   */
  function dataUrlToFile(dataUrl, index) {
    const comma = dataUrl.indexOf(',');
    const meta = comma >= 0 ? dataUrl.slice(0, comma) : '';
    const raw = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const mimeMatch = /data:([^;]+)/.exec(meta);
    const type = mimeMatch && mimeMatch[1].startsWith('image/') ? mimeMatch[1] : 'image/png';

    const binary = atob(raw.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return new File([bytes], `paste-${Date.now()}-${index + 1}.png`, { type });
  }

  async function buildDataTransfer(images) {
    const dt = new DataTransfer();
    for (let i = 0; i < images.length; i++) {
      const file = await dataUrlToFile(images[i], i);
      dt.items.add(file);
    }
    return dt;
  }

  /**
   * 主方案：构造一个带 files 的 paste 事件。
   * 网站的上传逻辑基本都挂在 paste handler 上，这是成功率最高的方式。
   */
  function firePaste(target, dataTransfer) {
    let event;
    try {
      event = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
    } catch (err) {
      log('ClipboardEvent 构造失败，退回 createEvent', err && err.message);
      event = document.createEvent('Event');
      event.initEvent('paste', true, true);
    }
    // 老版本 Chromium 不会把 clipboardData 带进事件对象，这里补一刀
    if (!event.clipboardData) {
      try {
        Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
      } catch (err) {
        log('补 clipboardData 失败', err && err.message);
      }
    }
    target.focus();
    const notCanceled = target.dispatchEvent(event);
    log('paste 已派发，页面是否处理了它:', !notCanceled);
    return !notCanceled;
  }

  /**
   * 兜底方案：drop 事件。部分站点（尤其是带拖拽上传的）只认这个。
   */
  function fireDrop(target, dataTransfer) {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer,
    };
    target.focus();
    try {
      target.dispatchEvent(new DragEvent('dragenter', init));
      target.dispatchEvent(new DragEvent('dragover', init));
    } catch (err) {
      log('dragenter/dragover 派发失败', err && err.message);
    }
    let notCanceled = true;
    try {
      notCanceled = target.dispatchEvent(new DragEvent('drop', init));
    } catch (err) {
      log('drop 派发失败', err && err.message);
    }
    log('drop 已派发，页面是否处理了它:', !notCanceled);
    return !notCanceled;
  }

  function mediaFingerprint(target) {
    const mediaCount = document.querySelectorAll(
      'img[src^="blob:"], img[src^="data:"], [class*="upload"], [class*="preview"]'
    ).length;
    return `${mediaCount}|${(target.innerHTML || '').length}`;
  }

  async function injectImages(target, images) {
    const dataTransfer = await buildDataTransfer(images);
    const before = mediaFingerprint(target);

    // paste 返回值：页面若 preventDefault 了事件（处理了粘贴），返回 true。
    // 只要 paste 被站点接管，就绝不再补 drop——否则同一批文件会被处理两次，
    // 千问这类上传慢的站点就会多出一张重复图。
    const pasteHandled = firePaste(target, dataTransfer);

    if (pasteHandled) {
      // paste 已接管，只需等上传完成（下面用轮询收口，不再固定长睡）
      log('paste 已被页面接管，等待上传完成');
    } else {
      log('paste 未被页面处理，改用 drop 兜底');
      fireDrop(target, dataTransfer);
    }

    // 等图片上传完成：发送按钮从 disabled 变可用才是真正可发的信号，
    // 轮询比固定 sleep 更快，也避免图片还没传完就发出空图。
    await waitForUploadDone(target, images.length, cfg.imageSettleMs);

    const changed = mediaFingerprint(target) !== before;
    log('图片注入结果:', changed || pasteHandled ? '成功' : '无变化（可能被站点忽略）');
    return changed || pasteHandled;
  }

  /**
   * 等待图片上传完成。以「输入框内容不再变化 + 发送按钮就绪」为收口信号，
   * 每 120ms 探一次，比一次性固定 sleep 更快、更稳。
   */
  async function waitForUploadDone(target, imageCount, maxMs) {
    const deadline = Date.now() + maxMs;
    let last = null;
    let stable = 0;
    do {
      const fp = mediaFingerprint(target);
      if (last !== null && fp === last) {
        stable += 1;
        if (stable >= 2) break; // 连续两拍内容不变，认为上传已稳定
      } else {
        last = fp;
        stable = 0;
      }
      await sleep(120);
    } while (Date.now() < deadline);
    return stable >= 2;
  }

  /* -------------------------- 点击发送 -------------------------- */
  function nodeLabel(node) {
    return [
      node.getAttribute && node.getAttribute('aria-label'),
      node.getAttribute && node.getAttribute('title'),
      node.getAttribute && node.getAttribute('data-testid'),
      node.id,
      typeof node.className === 'string' ? node.className : '',
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  function looksDisabled(node) {
    if (!node || !node.isConnected) return true;
    if (node.disabled) return true;
    if (node.getAttribute('aria-disabled') === 'true') return true;
    const style = getComputedStyle(node);
    if (Number(style.opacity) < 0.35) return true;
    if (style.pointerEvents === 'none') return true;
    const className = typeof node.className === 'string' ? node.className : '';
    if (/(^|[\s_-])(disabled|is-disabled)([\s_-]|$)/i.test(className)) return true;
    return false;
  }

  function findSendButton(input) {
    const nodes = [];
    const seen = new Set();
    const push = (selector) => {
      try {
        document.querySelectorAll(selector).forEach((node) => {
          if (seen.has(node)) return;
          seen.add(node);
          nodes.push(node);
        });
      } catch (err) {
        /* 选择器非法就跳过 */
      }
    };

    cfg.send.forEach(push);
    push('button');
    push('[role="button"]');

    const inputRect = input.getBoundingClientRect();
    const candidates = [];

    for (const raw of nodes) {
      if (!raw.isConnected || input.contains(raw)) continue;
      const node = raw.closest('button, [role="button"]') || raw;
      const rect = node.getBoundingClientRect();
      if (rect.width < 12 || rect.height < 12 || rect.width > 400) continue;
      if (rect.bottom < 0 || rect.top > innerHeight) continue;

      const label = nodeLabel(node);
      const text = (node.innerText || node.textContent || '').trim();
      const matched =
        /发送|send|submit|提交/.test(label) || /^(发送|发送消息|提交|send|submit)$/i.test(text);
      if (!matched) continue;
      // 排除「发送验证码」「登录」这类按钮
      if (/验证码|登录|注册|评论|搜索/.test(text)) continue;
      if (looksDisabled(node)) continue;

      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      // 发送按钮通常在输入框右下角：按距离排序，取最近的那个
      const distanceX = Math.abs((rect.left + rect.right) / 2 - (inputRect.right - 8));
      const distanceY = Math.abs((rect.top + rect.bottom) / 2 - (inputRect.bottom + 6));
      candidates.push({ node, score: distanceX + distanceY });
    }

    candidates.sort((a, b) => a.score - b.score);
    return candidates.length ? candidates[0].node : null;
  }

  async function waitForSendButton(input, timeout) {
    const deadline = Date.now() + timeout;
    do {
      const button = findSendButton(input);
      if (button) return button;
      await sleep(80);
    } while (Date.now() < deadline);
    return null;
  }

  function pressEnter(target) {
    target.focus();
    const init = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      charCode: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    };
    for (const type of ['keydown', 'keypress', 'keyup']) {
      try {
        target.dispatchEvent(new KeyboardEvent(type, init));
      } catch (err) {
        log('Enter 派发失败', type, err && err.message);
      }
    }
    log('已模拟 Enter');
  }

  /** 发送后判断输入框是否被清空（大多数站点的通用信号） */
  function stillHasText(target, text) {
    if (!text) return false;
    const probe = text.replace(/\s+/g, ' ').trim().slice(0, 12);
    if (!probe) return false;
    const current = target.tagName === 'TEXTAREA' ? target.value : target.innerText || '';
    return current.replace(/\s+/g, ' ').includes(probe);
  }

  /**
   * 页面上「消息条数」的粗略指纹。
   * 用来避免误判：点完发送后有些站点清空输入框有延迟，
   * 如果消息列表已经多了一条，就不要再补 Enter，否则会重复提问。
   */
  function messageFingerprint() {
    return document.querySelectorAll(
      '[class*="message"], [data-testid*="message"], [class*="bubble"], [class*="chat-item"], [class*="msg-item"]'
    ).length;
  }

  /**
   * 真正按「发送」：优先点按钮，找不到就回车。
   * 返回 'clicked' / 'enter'，供上层拼状态字符串。
   */
  async function performSend(input, text, buttonWaitMs) {
    const button = await waitForSendButton(input, buttonWaitMs);
    let mode = 'enter';

    if (button) {
      // 拟人：找到按钮后稍作停顿再点，节奏别太机械；幅度收窄到 80~260ms
      // 既保留一点拟人感，又不拖慢整体节奏
      await sleep(randInt(80, 260));
      log('点击发送按钮', nodeLabel(button).slice(0, 80));
      const beforeMessages = messageFingerprint();
      button.click();
      mode = 'clicked';
      await sleep(cfg.sendSettleMs);

      if (stillHasText(input, text)) {
        // 输入框没被清空时再确认一下消息列表有没有变化，避免重复发送
        if (messageFingerprint() !== beforeMessages) {
          log('输入框未清空，但消息列表已增加，判定发送成功');
        } else {
          log('点击后输入框仍有原文，补一次 Enter');
          pressEnter(input);
          mode = 'enter';
          await sleep(400);
        }
      }
    } else {
      // 拟人：回车前也停顿一下
      await sleep(randInt(80, 260));
      log('没找到可用的发送按钮，回退回车发送');
      pressEnter(input);
      await sleep(500);
    }
    return mode;
  }

  /* ---------------------------- 主流程 ----------------------------
   * payload.action：
   *   prepare —— 只把文字/图片填进输入框，等发送按钮就绪后就返回，不点发送
   *   send    —— 输入框里已经有内容，立刻点发送（三栏几乎同一时刻触发）
   *   all     —— 老的一体化流程（调试单栏时用）
   * ------------------------------------------------------------------ */
  try {
    if (!payload || (!payload.text && !(payload.images && payload.images.length))) {
      return `skip-empty:${HOST}`;
    }

    const action = payload.action || 'all';

    // ---------- 第二阶段：只负责「按发送」 ----------
    if (action === 'send') {
      const input = await waitForInput(2500);
      if (!input) return `${isLoginPage() ? 'need-login' : 'no-input'}:${HOST}`;
      const mode = await performSend(input, payload.text || '', 1500);
      const status = `ok:${mode}:${HOST}`;
      log('发送完成', status);
      return status;
    }

    const input = await waitForInput(6000);
    if (!input) {
      const reason = isLoginPage() ? 'need-login' : 'no-input';
      log(reason === 'need-login' ? '当前停在登录页' : '6 秒内没找到可用输入框，可能页面结构变化');
      return `${reason}:${HOST}`;
    }
    log('命中输入框', input.tagName, String(input.className || '').slice(0, 80));

    const textOk = await setText(input, payload.text || '');
    if (!textOk) log('文字注入可能失败（站点结构或校验限制），仍继续尝试发送');
    await sleep(120);

    if (payload.images && payload.images.length) {
      await injectImages(input, payload.images);
    }

    // ---------- 第一阶段：填完内容就停手，等主流程统一发号施令 ----------
    if (action === 'prepare') {
      const button = await waitForSendButton(input, 3500);
      const status = `ready:${button ? 'button' : 'enter'}:${HOST}`;
      log('内容已填入，等待统一发送', status);
      return status;
    }

    // ---------- action=all：一体化 ----------
    const mode = await performSend(input, payload.text || '', 3500);
    const status = `ok:${mode}:${HOST}`;
    log('注入完成', status);
    return status;
  } catch (err) {
    log('注入异常', err && err.stack ? err.stack : err);
    return `error:${(err && err.message) || String(err)}:${HOST}`;
  }
}

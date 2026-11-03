/**
 * preload.js —— 预加载脚本
 * ------------------------------------------------------------------
 * 运行在「窗口渲染进程」的隔离上下文里（contextIsolation: true），
 * 只通过 contextBridge 暴露最小可用的 IPC 接口给 index.html 使用。
 *
 * 暴露的接口（挂到 window.aiBridge）：
 *   - broadcastPrompt(payload)  payload = { text: string, images: string[] }
 *   - onPrompt(cb)              cb(payload)，返回取消监听的函数
 *   - getConfig()               读取模型库 / 已启用面板 / 侧栏状态
 *   - saveConfig(partial)       保存面板 / 侧栏 / 教程状态，返回保存后的完整配置
 *   - openExternal(url)         用系统浏览器打开外链
 *   - windowControls.*          无边框窗口的最小化 / 最大化 / 关闭 / 状态订阅
 *
 * 注意：这里不暴露 ipcRenderer 本身、也不暴露 Node 能力，
 * 页面脚本无法借此访问文件系统或其它窗口。
 */

const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL_BROADCAST = 'broadcast-prompt'; // 渲染 → 主进程
const CHANNEL_RECEIVE = 'receive-prompt'; // 主进程 → 全部窗口

contextBridge.exposeInMainWorld('aiBridge', {
  /**
   * 把统一提问广播给所有窗口。
   * @param {{ text?: string, images?: string[], id?: string, from?: string|number, slot?: string }} payload
   */
  broadcastPrompt(payload) {
    if (!payload || typeof payload !== 'object') {
      console.error('[preload] broadcastPrompt 收到的 payload 不合法:', payload);
      return;
    }
    ipcRenderer.send(CHANNEL_BROADCAST, {
      id: payload.id,
      text: payload.text ?? '',
      images: Array.isArray(payload.images) ? payload.images : [],
      from: payload.from ?? null,
      slot: payload.slot ?? null,
    });
  },

  /**
   * 监听其它窗口广播过来的提示词。
   * @param {(payload: { id: string, text: string, images: string[], from: any, ts: number }) => void} callback
   * @returns {() => void} 取消监听
   */
  onPrompt(callback) {
    if (typeof callback !== 'function') {
      console.error('[preload] onPrompt 需要传入函数');
      return () => {};
    }
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch (err) {
        // 回调里的异常不能影响后续消息
        console.error('[preload] onPrompt 回调执行出错:', err);
      }
    };
    ipcRenderer.on(CHANNEL_RECEIVE, listener);
    return () => ipcRenderer.removeListener(CHANNEL_RECEIVE, listener);
  },

  /**
   * 读取当前配置（主进程是唯一数据源，settings.json 在 userData 目录）。
   * @returns {Promise<{ panels: any[], collapsed: boolean, library: any[], maxPanels: number }>}
   */
  getConfig() {
    return ipcRenderer.invoke('config:get');
  },

  /**
   * 保存配置。主进程会校验 URL、去重、限流（最多 9 栏）后写盘。
   * @param {{ panels: any[], collapsed?: boolean, onboarded?: boolean, disclaimerAccepted?: boolean }} partial
   * @returns {Promise<{ panels: any[], collapsed: boolean, onboarded: boolean, disclaimerAccepted: boolean, library: any[], maxPanels: number }>}
   */
  saveConfig(partial) {
    return ipcRenderer.invoke('config:save', {
      panels: partial && Array.isArray(partial.panels) ? partial.panels : [],
      collapsed: !!(partial && partial.collapsed),
      onboarded: !!(partial && partial.onboarded),
      disclaimerAccepted: !!(partial && partial.disclaimerAccepted),
    });
  },

  /**
   * 用系统默认浏览器打开外链（右侧博客入口）。
   * @param {string} url http/https 地址
   * @returns {Promise<boolean>} 是否成功
   */
  openExternal(url) {
    return ipcRenderer.invoke('shell:open-external', String(url || ''));
  },

  /**
   * 一键退出所有账号：清空所有已启用面板分区的登录痕迹（Cookie / localStorage 等）。
   * 主进程直接删数据，不操作任何网页。
   * @returns {Promise<{ cleaned: string[] }>} 成功清除的模型名列表
   */
  clearAllSessions() {
    return ipcRenderer.invoke('session:clear-all');
  },

  /**
   * 无边框窗口的自绘按钮（macOS 风格「红绿灯」）。
   * frame: false 之后系统不再提供窗口按钮，页面上的按钮通过这几个方法操作真实窗口。
   */
  windowControls: {
    minimize() {
      return ipcRenderer.invoke('window:minimize');
    },

    /** 最大化 / 还原（全屏时先退出全屏） */
    toggleMaximize() {
      return ipcRenderer.invoke('window:toggle-maximize');
    },

    close() {
      return ipcRenderer.invoke('window:close');
    },

    /** @returns {Promise<{maximized: boolean, fullscreen: boolean, focused: boolean}>} */
    getState() {
      return ipcRenderer.invoke('window:state');
    },

    /**
     * 订阅窗口状态变化（最大化 / 还原 / 聚焦变化）。
     * @param {(state: {maximized: boolean, fullscreen: boolean, focused: boolean}) => void} callback
     * @returns {() => void} 取消监听
     */
    onStateChange(callback) {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, state) => {
        try {
          callback(state);
        } catch (err) {
          console.error('[preload] windowControls.onStateChange 回调出错:', err);
        }
      };
      ipcRenderer.on('window:state', listener);
      return () => ipcRenderer.removeListener('window:state', listener);
    },
  },
});

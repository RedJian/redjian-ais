/**
 * trim-dist.js —— electron-builder 的 afterPack 钩子：极致精简运行时
 * ------------------------------------------------------------------
 * Electron 的完整运行时约 350MB，其中有一大半对「纯 webview 的 AI 工具」
 * 来说是多余的。这里只删「零风险、绝对不影响运行」的部分：
 *
 *   1. locales：55 个语言包只留 zh-CN（和 en-US 兜底），省约 48MB；
 *   2. LICENSES.chromium.html：纯许可文本，省 5.7MB。
 *
 * 刻意保留所有 DLL（dxcompiler / vulkan / vk_swiftshader / d3dcompiler 等）：
 * 它们是 GPU 硬件加速失败时的软件渲染兜底，在没有独显 / 远程桌面的机器上
 * 删掉会导致「渲染进程崩溃」。体积优先级低于「保证任何机器都能跑」。
 *
 * 用法：package.json 的 build.afterPack 指向本脚本。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 要保留的语言包（Chromium 需要 en-US 作为兜底，zh-CN 是界面语言） */
const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);

/** 相对 app 根目录的「整文件删除」清单（只放零风险的纯文本/许可文件） */
const REMOVE_FILES = [
  'LICENSES.chromium.html',
];

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

module.exports = async function trimDist(context) {
  const appOutDir = context.appOutDir;
  if (!appOutDir) return;

  let freed = 0;
  const log = (msg) => console.log(`[trim] ${msg}`);

  // 1) locales 只留 zh-CN + en-US
  const localesDir = path.join(appOutDir, 'locales');
  if (fs.existsSync(localesDir)) {
    for (const file of fs.readdirSync(localesDir)) {
      if (KEEP_LOCALES.has(file)) continue;
      const full = path.join(localesDir, file);
      try {
        freed += fs.statSync(full).size;
        fs.unlinkSync(full);
      } catch (_) {
        /* 删不掉就跳过 */
      }
    }
    log(`locales 已裁剪（只留 ${[...KEEP_LOCALES].join(' / ')}）`);
  }

  // 2) 删除整文件
  for (const rel of REMOVE_FILES) {
    const full = path.join(appOutDir, rel);
    if (fs.existsSync(full)) {
      try {
        freed += fs.statSync(full).size;
        fs.unlinkSync(full);
        log(`已删除 ${rel}`);
      } catch (_) {
        /* 跳过 */
      }
    }
  }

  if (freed > 0) {
    log(`共释放 ${humanSize(freed)} 运行时体积`);
  } else {
    log('无可裁剪内容（可能已经裁剪过）');
  }
};

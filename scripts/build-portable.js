/**
 * build-portable.js —— 打出「单文件免安装」的 Windows exe
 * ------------------------------------------------------------------
 * 思路：
 *   1. 先用 electron-builder --dir 产出 dist/win-unpacked（完整运行时 + asar）；
 *   2. 再用 NSIS 把整个目录压进一个 exe，exe 启动时解压到 %TEMP% 并拉起应用。
 *
 * 为什么不用 electron-builder 自带的 portable target：
 *   它的启动器在这台机器上 ExecWait 拉不起子进程（解压完成后直接退出，
 *   既不报错也不运行），所以换成自己写的一份 NSIS 脚本，逻辑完全可控。
 *
 * 用法：npm run dist
 *   等价于 npm run pack && node scripts/build-portable.js
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const VERSION = pkg.version;

const SOURCE_DIR = path.join(ROOT, 'dist', 'win-unpacked');
const OUT_FILE = path.join(ROOT, 'dist', `AI-Compare-Portable-${VERSION}.exe`);
const ICON_FILE = path.join(ROOT, 'build', 'icon.ico');
const NSI_FILE = path.join(__dirname, 'portable.nsi');

/** 按优先级找一个可用的 makensis */
function findMakensis() {
  const candidates = [];

  if (process.env.NSIS_HOME) {
    candidates.push(path.join(process.env.NSIS_HOME, 'makensis.exe'));
  }

  // electron-builder 下载的 NSIS（本项目装依赖时会顺带下来）
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || '',
    'electron-builder',
    'Cache'
  );
  try {
    for (const dir of fs.readdirSync(cacheRoot)) {
      if (!dir.startsWith('nsis-')) continue;
      const nested = path.join(cacheRoot, dir);
      for (const sub of fs.readdirSync(nested)) {
        candidates.push(path.join(nested, sub, 'Bin', 'makensis.exe'));
        candidates.push(path.join(nested, sub, 'makensis.exe'));
      }
    }
  } catch (_) {
    /* 没有缓存目录就跳过 */
  }

  candidates.push('C:\\Program Files (x86)\\NSIS\\makensis.exe');
  candidates.push('C:\\Program Files\\NSIS\\makensis.exe');

  const hit = candidates.find((file) => file && fs.existsSync(file));
  if (!hit) {
    console.error(
      [
        '[dist] 找不到 makensis.exe。三种解决办法：',
        '  1) 先跑一次 npm run pack（会顺带下载 NSIS 到 electron-builder 缓存）；',
        '  2) 安装 NSIS 3.x 后重试（默认路径 Program Files\\NSIS）；',
        '  3) 设置环境变量 NSIS_HOME 指向 NSIS 安装目录。',
      ].join('\n')
    );
    process.exit(1);
  }
  return hit;
}

function main() {
  if (!fs.existsSync(path.join(SOURCE_DIR, 'AI-Compare.exe'))) {
    console.error('[dist] 缺少 dist/win-unpacked，先执行 npm run pack');
    process.exit(1);
  }

  // NSIS 3 读带中文的脚本必须是有 BOM 的 UTF-8，否则报 "Bad text encoding"。
  // 这里复制一份加 BOM 的临时脚本去编译，源文件保持普通 UTF-8，方便编辑与 diff。
  const nsiWithBom = path.join(ROOT, 'dist', '.portable-build.nsi');
  const raw = fs.readFileSync(NSI_FILE);
  const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  fs.writeFileSync(nsiWithBom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]));
  console.log(`[dist] 脚本编码: UTF-8 ${hasBom ? '(已有 BOM)' : '(已补 BOM)'}`);

  const makensis = findMakensis();
  console.log('[dist] makensis:', makensis);
  console.log('[dist] 打包目录:', SOURCE_DIR);
  console.log('[dist] 输出文件:', OUT_FILE);

  const startedAt = Date.now();
  const result = spawnSync(
    makensis,
    [
      '/V2', // 只打印警告和错误
      `/DAPP_VERSION=${VERSION}`,
      `/DSOURCE_DIR=${SOURCE_DIR}`,
      `/DOUT_FILE=${OUT_FILE}`,
      `/DICON_FILE=${ICON_FILE}`,
      nsiWithBom,
    ],
    { stdio: 'inherit' }
  );

  if (result.error) {
    console.error('[dist] 调用 makensis 失败:', result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error('[dist] makensis 退出码', result.status);
    process.exit(result.status || 1);
  }

  const size = fs.statSync(OUT_FILE).size;
  console.log(
    `[dist] 完成：${path.basename(OUT_FILE)}（${(size / 1024 / 1024).toFixed(0)} MB，` +
      `耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)} 秒）`
  );
}

main();

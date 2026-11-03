/**
 * NSIS 便携版启动器脚本
 * ------------------------------------------------------------------
 * 做四件事：
 *   1. 把 dist/win-unpacked 里的 app 解压到 %TEMP%\AI-Compare-runtime-<版本>；
 *      解压过一次就复用（有 .runtime-ok 标记），后续启动是秒开；
 *   2. 设置 PORTABLE_EXECUTABLE_DIR / PORTABLE_EXECUTABLE_FILE，
 *      主进程据此把 userData 放到「exe 同级的 AI-Compare-Data」；
 *   3. 启动 AI-Compare.exe 并等它退出，把退出码透出来；
 *   4. 全程静默，不写注册表、不建快捷方式、不需要管理员权限。
 *
 * 编译由 scripts/build-portable.js 调用 makensis 完成，不要在别处直接编。
 */

Unicode true
SetCompressor /SOLID lzma

!include "FileFunc.nsh"

; 下面几个宏由 build-portable.js 通过 /D 传入
!ifndef APP_VERSION
  !define APP_VERSION "1.0.0"
!endif
!ifndef SOURCE_DIR
  !error "缺少 SOURCE_DIR（win-unpacked 的绝对路径）"
!endif
!ifndef OUT_FILE
  !error "缺少 OUT_FILE（输出 exe 的绝对路径）"
!endif
!ifndef ICON_FILE
  !define ICON_FILE ""
!endif

Name "红笺-群问AI"
OutFile "${OUT_FILE}"
Icon "${ICON_FILE}"

RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
XPStyle on

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "红笺-群问AI"
VIAddVersionKey /LANG=2052 "FileDescription" "红笺-群问AI 便携版（免安装）"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "OriginalFilename" "AI-Compare-Portable-${APP_VERSION}.exe"
VIAddVersionKey /LANG=2052 "LegalCopyright" "AI Compare"

Var APP_DIR
Var MARKER

Section "portable"
  ; 运行时目录：带版本号，升级后自动换新目录，不会跑到旧代码上
  StrCpy $APP_DIR "$TEMP\AI-Compare-runtime-${APP_VERSION}"
  StrCpy $MARKER "$APP_DIR\.runtime-ok"

  ; 顺手清掉旧版本留下的运行时（升级后不占着几百 MB）
  FindFirst $0 $1 "$TEMP\AI-Compare-runtime-*"
  clean_loop:
    StrCmp $1 "" clean_done
    StrCmp $1 "AI-Compare-runtime-${APP_VERSION}" clean_next
    RMDir /r "$TEMP\$1"
    clean_next:
    FindNext $0 $1
    Goto clean_loop
  clean_done:
  FindClose $0

  IfFileExists "$MARKER" 0 extract
  IfFileExists "$APP_DIR\AI-Compare.exe" run extract

  extract:
    RMDir /r "$APP_DIR"
    CreateDirectory "$APP_DIR"
    SetOutPath "$APP_DIR"
    File /r "${SOURCE_DIR}\*.*"

    ; 全部解压完才写标记，避免解压中断留下「看起来完整」的目录
    FileOpen $9 "$MARKER" w
    FileWrite $9 "ok"
    FileClose $9

  run:
    IfFileExists "$APP_DIR\AI-Compare.exe" 0 missing

    SetOutPath "$APP_DIR"
    ; 便携关键：告诉应用「启动器在哪」，主进程据此把数据目录放到 exe 旁边
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR")'
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH")'

    ExecWait '"$APP_DIR\AI-Compare.exe"' $0
    SetErrorLevel $0
    Goto done

  missing:
    ; 理论上不会走到，真出了就让用户知道，而不是双击后毫无反应
    MessageBox MB_ICONSTOP "程序文件不完整，请重新下载 exe。$\r$\n缺失：$APP_DIR\AI-Compare.exe"
    SetErrorLevel 2

  done:
SectionEnd

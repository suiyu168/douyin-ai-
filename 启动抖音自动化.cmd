@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\electron\cli.js" (
  echo 正在安装首次运行所需组件，请稍候...
  if not exist "D:\小V猫数据\npm-cache" mkdir "D:\小V猫数据\npm-cache"
  call npm.cmd ci --cache "D:\小V猫数据\npm-cache" --no-audit --no-fund
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

if not exist "D:\小V猫数据\抖音自动化\OCR\chi_sim.traineddata.gz" (
  echo 正在下载本地中文 OCR 模型到 D 盘...
  if not exist "D:\小V猫数据\抖音自动化\OCR" mkdir "D:\小V猫数据\抖音自动化\OCR"
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -Command "& { Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz' -OutFile 'D:\小V猫数据\抖音自动化\OCR\chi_sim.traineddata.gz' -UseBasicParsing -TimeoutSec 120 }"
  if errorlevel 1 echo OCR 模型下载失败，其他功能仍可使用，下次启动会重试。
)

start "抖音自动化" /min node.exe "%~dp0node_modules\electron\cli.js" "%~dp0"
endlocal

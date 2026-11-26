<#
.SYNOPSIS
采集 ADMX 与其服务端的“同步基准”快照，供后续服务端更新时逐字段对比。

.DESCRIPTION
ADMX 运行时依赖两个服务端形态，基准必须分开记录：

1. 交付 sidecar：`adm-binaries/admAgent_*_Windows_x86_64.zip` 解出的 `admAgent.exe`，
   由 `scripts/prepare-agent-binary.mjs` 拷到 `src-tauri/binaries/admAgent-<triple>.exe`
   并由 `bundle.externalBin` 打进安装包（本项目不提交该二进制，基线在 adm-binaries 仓库）。
2. 内嵌还原服务端源码：`desktop/internal/server/`（已冻结的资料性实现，不走进交付链路），
   其差分基座为 `scripts/parity/capture-parity.ps1` + `parity_test.go`。

快照只记录身份字段（版本、模块伪版本、大小、SHA256、源码树哈希），不读配置内容。

.EXAMPLE
pwsh -File scripts/server-baseline.ps1
pwsh -File scripts/server-baseline.ps1 -OutFile doc/admx-server-baseline.json
#>
param(
  [string]$OutFile = '',
  [string]$AppRoot = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = if ($AppRoot) { (Resolve-Path -LiteralPath $AppRoot).Path } else { Split-Path -Parent $PSScriptRoot }

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# 目录内容哈希：按相对路径排序后对 “相对路径:文件SHA256” 行拼接再取 SHA256，
# 不依赖文件 mtime，源码改动必然改变结果，仅换行差/时序差不会。
function Get-TreeSha256([string]$Dir, [string[]]$Include) {
  if (-not (Test-Path -LiteralPath $Dir)) { return $null }
  $root = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd('\', '/')
  $files = Get-ChildItem -LiteralPath $root -Recurse -File -Include $Include | Sort-Object FullName
  if (-not $files) { return $null }
  $lines = foreach ($f in $files) {
    $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
    "$rel`:$(Get-Sha256 $f.FullName)"
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '' } finally { $sha.Dispose() }
}

# go version -m 给出 sidecar 的真实模块伪版本（包名 0.4.7 与模块版本不一致，必须分别记录）
function Get-GoModuleInfo([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  if (-not (Get-Command go -ErrorAction SilentlyContinue)) { return $null }
  $out = & go version -m $Path 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  $info = @{ goVersion = $null; module = $null; moduleVersion = $null }
  foreach ($line in $out) {
    $t = $line.Trim()
    if (-not $info.goVersion -and $t -match ':\s*(go[\w.]+)\s*$') { $info.goVersion = $Matches[1] }
    elseif (-not $info.module -and $t -match '^path\s+(\S+)$') { $info.module = $Matches[1] }
    elseif (-not $info.moduleVersion -and $t -match '^mod\s+\S+\s+(\S+)') { $info.moduleVersion = $Matches[1] }
  }
  [pscustomobject]$info
}

function Get-SidecarArchive {
  $dir = Join-Path $repoRoot 'adm-binaries'
  if (-not (Test-Path -LiteralPath $dir)) { return $null }
  $candidates = @(Get-ChildItem -LiteralPath $dir -File |
    Where-Object { $_.Name -match '^admAgent_(.+)_Windows_x86_64\.zip$' } |
    ForEach-Object { [pscustomobject]@{ File = $_; Version = [version]$Matches[1] } } |
    Sort-Object Version)
  if (-not $candidates.Count) { return $null }
  $candidates[-1].File
}

$tauriConfigPath = Join-Path $repoRoot 'src-tauri/tauri.conf.json'
if (-not (Test-Path -LiteralPath $tauriConfigPath)) { throw "未找到 $tauriConfigPath" }
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
$productName = $tauriConfig.productName

$gitHead = $null; $gitHeadSubject = $null; $gitDirty = @()
if (Get-Command git -ErrorAction SilentlyContinue) {
  $gitHead = (& git -C $repoRoot rev-parse HEAD 2>$null)
  if ($LASTEXITCODE -ne 0) { $gitHead = $null }
  $gitHeadSubject = (& git -C $repoRoot log -1 --format='%ci %s' 2>$null)
  $gitDirty = @(& git -C $repoRoot status --porcelain 2>$null)
}

# 交付 sidecar（打包源，gnu triple 与本机打包配方一致）
$archive = Get-SidecarArchive
$sidecarBin = Join-Path $repoRoot 'src-tauri/binaries/admAgent-x86_64-pc-windows-gnu.exe'
$sidecarInfo = Get-GoModuleInfo $sidecarBin

# 已安装实例（若存在）
$installDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA $productName } else { $null }
$installedExe = if ($installDir) { Join-Path $installDir ($productName + '.exe') } else { $null }
$installedSidecar = if ($installDir) { Join-Path $installDir 'admAgent.exe' } else { $null }
$installedProductVersion = $null
if ($installedExe -and (Test-Path -LiteralPath $installedExe)) {
  $installedProductVersion = (Get-Item -LiteralPath $installedExe).VersionInfo.ProductVersion
}

# 内嵌还原服务端源码基准（冻结资料，不进交付链路）
$embeddedDir = Join-Path $repoRoot 'desktop/internal/server'
$embeddedNewest = Get-ChildItem -LiteralPath $embeddedDir -Recurse -File -Include '*.go', '*.json' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1

$snapshot = [ordered]@{
  capturedAt      = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
  app             = [ordered]@{
    productName = $productName
    version     = $tauriConfig.version
    identifier  = $tauriConfig.identifier
    repo        = $repoRoot
    gitHead     = $gitHead
    gitHeadInfo = $gitHeadSubject
    gitDirty    = $gitDirty
  }
  sidecar         = [ordered]@{
    archive           = if ($archive) { 'adm-binaries/' + $archive.Name } else { $null }
    archiveBytes      = if ($archive) { $archive.Length } else { $null }
    archiveSha256     = if ($archive) { Get-Sha256 $archive.FullName } else { $null }
    binaryPath        = 'src-tauri/binaries/admAgent-x86_64-pc-windows-gnu.exe'
    binaryBytes       = if (Test-Path -LiteralPath $sidecarBin) { (Get-Item -LiteralPath $sidecarBin).Length } else { $null }
    binarySha256      = Get-Sha256 $sidecarBin
    goVersion         = if ($sidecarInfo) { $sidecarInfo.goVersion } else { $null }
    module            = if ($sidecarInfo) { $sidecarInfo.module } else { $null }
    moduleVersion     = if ($sidecarInfo) { $sidecarInfo.moduleVersion } else { $null }
  }
  installed       = [ordered]@{
    dir            = $installDir
    productVersion = $installedProductVersion
    exeBytes       = if ($installedExe -and (Test-Path -LiteralPath $installedExe)) { (Get-Item -LiteralPath $installedExe).Length } else { $null }
    exeSha256      = Get-Sha256 $installedExe
    sidecarSha256  = Get-Sha256 $installedSidecar
    sidecarMatchesPackagedSource = ((Get-Sha256 $installedSidecar) -eq (Get-Sha256 $sidecarBin))
  }
  embeddedServer  = [ordered]@{
    note          = '冻结资料性实现，不走进交付链路；仅作为内嵌还原服务的源码基准'
    sourceDir     = 'desktop/internal/server'
    fileCount     = @(Get-ChildItem -LiteralPath $embeddedDir -Recurse -File -Include '*.go', '*.json' -ErrorAction SilentlyContinue).Count
    treeSha256    = Get-TreeSha256 $embeddedDir @('*.go', '*.json')
    newestFile    = if ($embeddedNewest) { ($embeddedNewest.FullName.Substring($repoRoot.Length).TrimStart('\', '/') -replace '\\', '/') } else { $null }
    newestModTime = if ($embeddedNewest) { $embeddedNewest.LastWriteTime.ToString('yyyy-MM-ddTHH:mm:sszzz') } else { $null }
  }
  parityBaseline  = [ordered]@{
    harnessScript   = 'scripts/parity/capture-parity.ps1'
    harnessSha256   = Get-Sha256 (Join-Path $repoRoot 'scripts/parity/capture-parity.ps1')
    testSha256      = Get-Sha256 (Join-Path $repoRoot 'desktop/internal/server/parity_test.go')
    documentedSteps = 61
    documentedResult = 'differences=0, order-only=4, whitelisted=2 (Stage 0-7 全部交付时)'
  }
}

$json = $snapshot | ConvertTo-Json -Depth 6
if ($OutFile) {
  $outPath = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $repoRoot $OutFile }
  $outDir = Split-Path -Parent $outPath
  if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  Set-Content -LiteralPath $outPath -Value $json -Encoding utf8NoBOM
  Write-Output "基准快照已写入 $outPath"
  Write-Output ("sidecar={0} app={1} embedded={2}" -f $snapshot.sidecar.binarySha256, $snapshot.app.version, $snapshot.embeddedServer.treeSha256)
} else {
  $json
}

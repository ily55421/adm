param(
  [string]$Exe = "$PSScriptRoot\..\..\src-tauri\binaries\admAgent-x86_64-pc-windows-gnu.exe",
  [string]$Out = "$env:PI_SCRATCH_DIR\parity",
  [switch]$SkipOriginal,
  [switch]$SkipEmbedded
)

# 内嵌 server 与原版 EXE 的差分基座：
#   1) 用隔离目录 + 独立 TCP 端口拉起原版 admAgent.exe
#   2) 同一套场景分别打原版与 desktop/internal/server 的内嵌实现
#   3) 逐项比对 status / body（已归一化 uuid、时间戳、pid、工作区路径）

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$desktop = Join-Path $repo 'desktop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function New-FreePort {
  $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); return $p
}
# 往隔离目录写两侧一致的全局 admAgent.json：model + providers + mcp。
# mcp 三个服务器：echo（正常）/ broken（启动失败）/ off（disabled）。夹具 scripts/parity/mcp-echo-server.js。
# 注：原版 GET /v1/config 会把全局配置合并三次，同一 source 的 args 因此变三份；这是其内部行为，
# 本地只写一份文件（该放大在差分里单独归类，不作为实现差距）。
function Write-ParityConfig([string]$base) {
  $serverJs = Join-Path $repo 'scripts\parity\mcp-echo-server.js'
  $cfg = [ordered]@{
    model     = @{ model = 'adm-models'; provider = 'admAgent' }
    providers = @{
      admAgent = @{
        id = 'admAgent'; name = 'admAgent'; type = 'openai-compat'; discover_models = $false
        models = @(@{
          id = 'adm-models'; name = 'adm-models'; ctx_size = 256000
          provider_max_output_tokens = 65536; default_reasoning_effort = 'medium'
          reasoning_levels = @('low', 'medium', 'high'); supports_images = $true; can_reason = $true; options = @{}
        })
      }
    }
    mcp = @{
      echo   = @{ type = 'stdio'; command = 'node'; args = @($serverJs) }
      broken = @{ type = 'stdio'; command = 'definitely-not-a-real-binary-xyz' }
      off    = @{ type = 'stdio'; command = 'node'; args = @($serverJs); disabled = $true }
    }
  } | ConvertTo-Json -Depth 12
  New-Item -ItemType Directory -Force -Path "$base\global" | Out-Null
  Set-Content -Path (Join-Path "$base\global" 'admAgent.json') -Value $cfg -Encoding utf8
}

function Invoke-Capture([string]$label, [string]$baseUrl) {
  $env:PARITY_LABEL = $label
  $env:PARITY_OUT = $Out
  $env:PARITY_WS = Join-Path $Out "ws-$label"
  if ($baseUrl) { $env:PARITY_BASEURL = $baseUrl } else { Remove-Item Env:PARITY_BASEURL -ErrorAction SilentlyContinue }
  Push-Location $desktop
  try {
    go test ./internal/server -run TestParityCapture -count=1 -v 2>&1 | Select-Object -Last 6 | ForEach-Object { "  $_" }
  } finally { Pop-Location }
}

if (-not $SkipOriginal) {
  $port = New-FreePort
  $b = Join-Path $Out 'orig'
  # 每次跑都重建隔离目录，避免上一轮留下的 admAgent.json 串场
  Remove-Item -Recurse -Force $b -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $b, "$b\global", "$b\ws", "$b\data" | Out-Null
  Write-ParityConfig $b
  $ol = $env:LOCALAPPDATA; $oh = $env:HOME; $og = $env:ADMAGENT_GLOBAL_DATA
  $env:LOCALAPPDATA = $b; $env:HOME = $b; $env:ADMAGENT_GLOBAL_DATA = "$b\global"
  # 与原版隔离目录保持同一叶子名（global），使 data_directory 在归一化后可比
  $proc = Start-Process -FilePath (Resolve-Path $Exe) -ArgumentList @('server','--host',"tcp://127.0.0.1:$port",'--cwd',"$b\ws",'--data-dir',"$b\global") -PassThru -WindowStyle Hidden
  $env:LOCALAPPDATA = $ol; $env:HOME = $oh; $env:ADMAGENT_GLOBAL_DATA = $og
  Write-Output "[parity] original pid=$($proc.Id) port=$port"
  try { Invoke-Capture 'original' "http://127.0.0.1:$port" }
  finally { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } }
}

if (-not $SkipEmbedded) {
  $b = Join-Path $Out 'emb'
  Remove-Item -Recurse -Force $b -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $b | Out-Null
  Write-ParityConfig $b
  $ol = $env:LOCALAPPDATA; $oh = $env:HOME; $og = $env:ADMAGENT_GLOBAL_DATA
  $env:LOCALAPPDATA = $b; $env:HOME = $b; $env:ADMAGENT_GLOBAL_DATA = "$b\global"
  Write-Output '[parity] embedded (in-process)'
  try { Invoke-Capture 'embedded' $null }
  finally { $env:LOCALAPPDATA = $ol; $env:HOME = $oh; $env:ADMAGENT_GLOBAL_DATA = $og }
}

$origPath = Join-Path $Out 'capture-original.json'
$embPath = Join-Path $Out 'capture-embedded.json'
if (-not (Test-Path $origPath) -or -not (Test-Path $embPath)) { Write-Output '[parity] 缺少 capture 文件，跳过差分'; exit 2 }

# 归一化：抹平两边的隔离根目录与内置密钥值，否则路径/密钥噪声会盖住真实差异
function Normalize-Text([string]$s) {
  if (-not $s) { return $s }
  $leaf = Split-Path $Out -Leaf
  foreach ($seg in @('orig', 'emb')) {
    foreach ($p1 in @((Join-Path $Out $seg), "$leaf\$seg", "$leaf/$seg", "\\$leaf\\$seg")) {
      $s = $s.Replace($p1, '<root>')
      $s = $s.Replace($p1.Replace('\', '\\'), '<root>')
    }
  }
  # 测试侧已把 scratch 路径里的 UUID 归一化成 <uuid>，全路径不再匹配；按 <leaf>\<seg> 段补刀
  foreach ($seg in @('orig', 'emb')) {
    $s = $s.Replace("$leaf\$seg", '<root>')
    $s = $s.Replace("$($leaf.Replace('\', '\\'))\\$seg", '<root>')
  }
  $s = [regex]::Replace($s, '"api_key":"[^"]*"', '"api_key":"<key>"')
  return $s
}

# 语义化 JSON：键排序后压缩，避免键顺序 / 空白造成假差异
function ConvertTo-Canonical($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [bool]) { return $v.ToString().ToLower() }
  if ($v -is [string]) { return (ConvertTo-Json -InputObject $v -Compress) }
  if ($v -is [System.Management.Automation.PSCustomObject]) {
    $names = @($v.PSObject.Properties.Name | Sort-Object)
    $parts = foreach ($n in $names) { '"' + $n + '":' + (ConvertTo-Canonical $v.$n) }
    return '{' + ($parts -join ',') + '}'
  }
  if ($v -is [System.Collections.IEnumerable]) {
    $parts = foreach ($item in $v) { ConvertTo-Canonical $item }
    return '[' + ($parts -join ',') + ']'
  }
  return ([string]$v)
}

function Get-CanonicalBody($text) {
  $t = [string]$text
  if ($t -eq '') { return '' }
  try { return (ConvertTo-Canonical ($t | ConvertFrom-Json)) } catch { return $t }
}

$o = Get-Content $origPath -Raw | ConvertFrom-Json
$e = Get-Content $embPath -Raw | ConvertFrom-Json
$om = @{}; foreach ($s in $o.steps) { $om[$s.id] = $s }
$em = @{}; foreach ($s in $e.steps) { $em[$s.id] = $s }
$ids = @($om.Keys) + @($em.Keys) | Sort-Object -Unique
$diff = 0
$orderOnly = 0
$wl = 0
# 已文档化的允许差异（不是实现差距）：id -> 原因
$whitelist = @{
  'version' = '内嵌标识 0.4.7-admx.N'
  'config'  = '原版 GET /v1/config 会把全局配置合并三次，args / skills_paths 因此重复；内嵌不复刻该放大'
}
foreach ($id in $ids) {
  $a = $om[$id]; $b2 = $em[$id]
  if (-not $b2) { "MISSING-IN-EMBEDDED  $id  (orig=$($a.status))"; $diff++; continue }
  if (-not $a) { "EXTRA-IN-EMBEDDED   $id  (emb=$($b2.status))"; $diff++; continue }
  if ($a.status -ne $b2.status) { "STATUS  $id  orig=$($a.status) emb=$($b2.status)"; $diff++; continue }
  $ab = Normalize-Text ([string]$a.body)
  $eb = Normalize-Text ([string]$b2.body)
  $ca = Get-CanonicalBody $ab
  $cb = Get-CanonicalBody $eb
  if ($ca -ne $cb) {
    if ($whitelist.ContainsKey($id)) {
      $wl++
      "WHITELIST  $id（$($whitelist[$id])）"
      continue
    }
    $diff++
    "BODY    $id"
    "        orig= $($ca.Substring(0,[Math]::Min(240,$ca.Length)))"
    "        emb = $($cb.Substring(0,[Math]::Min(240,$cb.Length)))"
  } elseif ($ab -ne $eb) {
    $orderOnly++
    "ORDER   $id  （语义一致，仅键序/空白不同）"
  }
}
Write-Output ("[parity] steps={0} differences={1} order-only={2} whitelisted={3}" -f $ids.Count, $diff, $orderOnly, $wl)
if ($diff -gt 0) { exit 1 }

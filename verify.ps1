param(
    [switch]$AllowPlaceholder
)

$ErrorActionPreference = 'Stop'
$pluginPath = Join-Path $PSScriptRoot 'lightboard_illust_status.js'

if (-not (Test-Path -LiteralPath $pluginPath)) {
    throw "배포 파일이 없습니다: $pluginPath"
}

$text = Get-Content -LiteralPath $pluginPath -Raw -Encoding UTF8

& node --check $pluginPath
if ($LASTEXITCODE -ne 0) {
    throw 'node --check 실패'
}

if ($text -notmatch '(?m)^//@name lightboard-illust-status-v42\s*$') {
    throw '업데이트 식별자인 //@name이 변경되었습니다.'
}

if ($text -notmatch '(?m)^//@version ([0-9]+\.[0-9]+\.[0-9]+)\s*$') {
    throw '유효한 //@version을 찾지 못했습니다.'
}
$version = $Matches[1]
$displayVersionMatch = [regex]::Match($text, '(?m)^//@display-name soya comfy manager plugin (v[0-9]+\.[0-9]+\.[0-9]+)\s*$')
if (-not $displayVersionMatch.Success) {
    throw '유효한 플러그인 표시 버전을 찾지 못했습니다.'
}
$displayVersion = $displayVersionMatch.Groups[1].Value
if (-not $text.Contains("<h1>soya comfy manager $displayVersion</h1>")) {
    throw "대시보드 제목 표시 버전이 플러그인 표시 버전과 다릅니다: $displayVersion"
}
if (-not $text.Contains("<div class=`"sub`">v$version ·")) {
    throw "대시보드 배포 버전이 //@version과 다릅니다: $version"
}
$versionLineEnd = $text.IndexOf("`n", $text.IndexOf('//@version'))
if ($versionLineEnd -lt 0) {
    $versionLineEnd = $text.Length
}
$versionPrefixBytes = [Text.Encoding]::UTF8.GetByteCount($text.Substring(0, $versionLineEnd))
if ($versionPrefixBytes -gt 512) {
    throw "//@version이 첫 512바이트 밖에 있습니다: $versionPrefixBytes bytes"
}

if ($text -notmatch '(?m)^//@update-url https://raw\.githubusercontent\.com/[^/]+/LB_plugin/main/lightboard_illust_status\.js\s*$') {
    throw '고정 형식의 HTTPS GitHub raw update-url이 없습니다.'
}
if (-not $AllowPlaceholder -and $text.Contains('YOUR_GITHUB_ID')) {
    throw '배포 전에 YOUR_GITHUB_ID를 실제 GitHub 아이디로 바꾸십시오.'
}

$forbiddenPatterns = @(
    'getChat',
    'setChat',
    'chatIndex',
    'cannot read file name'
)
foreach ($pattern in $forbiddenPatterns) {
    if ($text -match [regex]::Escape($pattern)) {
        throw "역할 경계를 침범할 수 있는 문자열이 발견되었습니다: $pattern"
    }
}

$requiredSignals = @(
    'lb-xnai-regenerate-all/',
    'lb-xnai-generate-all/',
    'lb-xnai-reroll-assets/',
    'lb-xnai-gen/',
    'lb-xnai-edit/'
)
foreach ($signal in $requiredSignals) {
    if (-not $text.Contains($signal)) {
        throw "필수 모듈 동작 식별자가 없습니다: $signal"
    }
}

$requiredCompatibilityTokens = @(
    "'?m=1'",
    'slot_animation_metadata',
    'asset_display_metadata',
    'asset_reroll',
    "module_expected: 'soya-v59'"
)
foreach ($token in $requiredCompatibilityTokens) {
    if (-not $text.Contains($token)) {
        throw "soya-v59 호환성 식별자가 없습니다: $token"
    }
}

$requiredBundleFiles = @(
    'module\라이트보드  삽화 4.1.0-soya-v59.module.charx',
    'module\라이트보드  삽화 4.1.0-soya-v58.module.charx',
    'module\라이트보드  삽화 4.1.0-soya-v57.module.charx',
    'module\라이트보드  삽화 4.1.0-soya-v56.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v55.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v54.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v53.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v52.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v51.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v50.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v49.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v48.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v47.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v46.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v45.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v44.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v43.module.charx',
    'module\라이트보드  삽화 3.4.1-soya-v42.module.charx',
    'module\🔦라이트보드 - 3.4.0-soya-0704.module.charx'
)
foreach ($relativePath in $requiredBundleFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $relativePath))) {
        throw "필수 배포 파일이 없습니다: $relativePath"
    }
}

$currentModulePath = Join-Path $PSScriptRoot 'module\라이트보드  삽화 4.1.0-soya-v59.module.charx'
$expectedCurrentModuleSha256 = '0309D183135350E7C6C728188B09B8A85230EBFC8A3F0BED3DD95DB80BCDD772'
$actualCurrentModuleSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $currentModulePath).Hash
if ($actualCurrentModuleSha256 -ne $expectedCurrentModuleSha256) {
    throw "soya-v59 배포 모듈 해시가 검증된 완성본과 다릅니다: $actualCurrentModuleSha256"
}

$backendPath = Join-Path $PSScriptRoot 'backend'
if (Test-Path -LiteralPath $backendPath) {
    throw '백엔드는 이 저장소에 포함하지 않습니다. E:\test3\comfyui_hooking_server에서 관리하십시오.'
}

Write-Host "검증 성공: lightboard-illust-status-v42 $version"
if ($AllowPlaceholder -and $text.Contains('YOUR_GITHUB_ID')) {
    Write-Warning '초기 골격 검증입니다. push 전에 YOUR_GITHUB_ID를 교체하십시오.'
}

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
    'lb-xnai-gen/'
)
foreach ($signal in $requiredSignals) {
    if (-not $text.Contains($signal)) {
        throw "필수 모듈 동작 식별자가 없습니다: $signal"
    }
}

$requiredBundleFiles = @(
    'module\라이트보드  삽화 3.4.1-soya-v42.module.charx',
    'module\🔦라이트보드 - 3.4.0-soya-0704.module.charx',
    'backend\server.py',
    'backend\modes\illustration_context_pipeline.py'
)
foreach ($relativePath in $requiredBundleFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $relativePath))) {
        throw "필수 배포 파일이 없습니다: $relativePath"
    }
}

$backendServer = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'backend\server.py') -Raw -Encoding UTF8
$backendPipeline = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'backend\modes\illustration_context_pipeline.py') -Raw -Encoding UTF8
$backendMarkers = @(
    'app.router.add_get("/s/{key}", handle_api_illustration_context_short_slots)',
    '"short_slot_manifest": True',
    '"lookup_key_length": 24'
)
foreach ($marker in $backendMarkers) {
    if (-not $backendServer.Contains($marker)) {
        throw "v42 호환 백엔드 표식이 없습니다: $marker"
    }
}
if (-not $backendPipeline.Contains('session_slots_by_lookup_key')) {
    throw 'v42 조회 키 슬롯 회수 함수가 없습니다.'
}

Write-Host "검증 성공: lightboard-illust-status-v42 $version"
if ($AllowPlaceholder -and $text.Contains('YOUR_GITHUB_ID')) {
    Write-Warning '초기 골격 검증입니다. push 전에 YOUR_GITHUB_ID를 교체하십시오.'
}

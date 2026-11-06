#Requires -Version 7.0
<#
.SYNOPSIS
    A4 冒烟前置盘点与可执行清单：确认 VS Code / Copilot 扩展 / Copilot CLI / 插件加载能力。

.DESCRIPTION
    本脚本只做环境盘点与只读验证，默认不联网、不安装扩展、不调用模型、不读取任何凭据内容。
    它回答三个问题：官方 Copilot Chat 是否就绪、`lib/plugin` 能否被真实客户端加载、
    还缺哪一步需要用户动手。

.PARAMETER Install
    显式要求安装官方扩展（GitHub.copilot 与 GitHub.copilot-chat）。需要联网与有效订阅；
    不加该开关时脚本只报告缺失，不会安装任何东西。

.PARAMETER Editor
    stable / insiders，默认 stable。指定检查与安装到哪个 VS Code。

.PARAMETER RunModel
    额外执行一次真实模型的非交互冒烟（会消耗 Copilot 配额），需要先启动 MCP 端点。

.EXAMPLE
    pwsh -NoProfile -File scripts/copilot-smoke.ps1
    pwsh -NoProfile -File scripts/copilot-smoke.ps1 -Editor insiders -Install
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [ValidateSet('stable', 'insiders')]
    [string]$Editor = 'stable',
    [switch]$RunModel
)

$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$Plugin = Join-Path $Root 'lib\plugin'
$Cli = if ($Editor -eq 'insiders') { 'code-insiders' } else { 'code' }
$Official = @('GitHub.copilot', 'GitHub.copilot-chat')

# 运行一个命令并返回是否有输出；用于只读探测。
function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# 读取指定编辑器的扩展列表与版本。
function Get-Extensions([string]$CliName) {
    if (-not (Test-Command $CliName)) { return @() }
    return @(& $CliName --list-extensions --show-versions 2>$null)
}

# 汇总一条检查结果，供最终 JSON 使用。
function Add-Check([System.Collections.ArrayList]$List, [string]$Name, [bool]$Ok, [string]$Detail) {
    $List.Add([ordered]@{ check = $Name; ok = $Ok; detail = $Detail }) | Out-Null
}

$checks = [System.Collections.ArrayList]::new()

# 1. 编辑器与官方扩展。
$editorVersion = if (Test-Command $Cli) { (& $Cli --version 2>$null | Select-Object -First 1) } else { '' }
Add-Check $checks 'editor' ([bool]$editorVersion) "$Cli=$editorVersion"
$extensions = Get-Extensions $Cli
$installed = @($Official | Where-Object { $extensions -match "^$([regex]::Escape($_))@" })
Add-Check $checks 'official-copilot' ($installed.Count -eq $Official.Count) ("已安装: " + ($(if ($installed.Count) { $installed -join ', ' } else { '无' })))

# 2. Copilot CLI 与插件加载能力。
$cliVersion = if (Test-Command 'copilot') { (& copilot --version 2>$null | Select-Object -First 1) } else { '' }
Add-Check $checks 'copilot-cli' ([bool]$cliVersion) "copilot=$cliVersion"
if ($cliVersion) {
    $plugins = & copilot plugin list --json 2>$null | Out-String
    Add-Check $checks 'copilot-cli-plugin-command' ($LASTEXITCODE -eq 0) 'copilot plugin list --json'
}

# 3. 本仓库插件产物。
Add-Check $checks 'lib-plugin' (Test-Path (Join-Path $Plugin 'plugin.json')) "路径 $Plugin"
if (Test-Path (Join-Path $Plugin 'plugin.json')) {
    $listed = & copilot --plugin-dir $Plugin plugin list --json 2>$null | Out-String
    $loaded = $listed -match '"name"\s*:\s*"dsh-superagent"'
    Add-Check $checks 'plugin-loaded-by-cli' $loaded 'copilot --plugin-dir lib/plugin plugin list --json'
}

# 4. 可选安装：只有显式 -Install 才联网。
if ($Install) {
    foreach ($id in $Official) {
        if ($extensions -match "^$([regex]::Escape($id))@") { continue }
        & $Cli --install-extension $id --force 2>&1 | ForEach-Object { Write-Host $_ }
    }
    $extensions = Get-Extensions $Cli
    $installed = @($Official | Where-Object { $extensions -match "^$([regex]::Escape($_))@" })
    Add-Check $checks 'official-copilot-after-install' ($installed.Count -eq $Official.Count) ("已安装: " + ($(if ($installed.Count) { $installed -join ', ' } else { '无' })))
}

# 5. 可选真实模型冒烟：只在显式 -RunModel 时执行。
if ($RunModel) {
    $prompt = '只用 dsh-superagent 插件工具：调用 orchestrator_read 读取 tickets，并原样返回结果。'
    $output = & copilot -p $prompt --plugin-dir $Plugin --allow-all-tools -s 2>&1 | Out-String
    Add-Check $checks 'model-smoke' ($LASTEXITCODE -eq 0) ($output.Trim() | Select-Object -First 1)
}

$report = [ordered]@{
    editor = $Editor
    generatedAt = (Get-Date).ToString('o')
    checks = $checks
    manual = @(
        '在 VS Code 安装官方 GitHub.copilot 与 GitHub.copilot-chat，并登录有 Copilot 权限的账号。',
        '按客户端文档把 lib/plugin 放入 agent plugins 目录，或在命令面板执行插件安装。',
        '确认 dsh-superagent 插件处于启用状态，且三个技能可见。',
        '先启动守护与 MCP 端点（scripts/dsh-superagent-windows.ps1 -Action start），再在 Copilot 中验证工具出现。',
        '依次调用 orchestrator_read(tickets)、orchestrator_route、orchestrator_reply，记录调用与返回。',
        '保存 Copilot 的插件页与工具调用截图到 .artifacts/screenshots/（不提交）。'
    )
}
$report | ConvertTo-Json -Depth 5
if ($checks | Where-Object { -not $_.ok }) { exit 1 }
exit 0

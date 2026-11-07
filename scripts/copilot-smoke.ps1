#Requires -Version 7.0
<#
.SYNOPSIS
    A4 只读盘点：Windows + VS Code Stable 的官方 Copilot 客户端是否就位。

.DESCRIPTION
    验收范围（2026-11-06 用户收敛）：A4 只认 Windows 上 VS Code Stable 里官方 Copilot /
    Copilot Chat 中真实发生的验证行为。Copilot CLI、VS Code Insiders（用户已卸载）以及
    其他编辑器与宿主一律不计入 A4，最多作为前置证据单列。

    脚本默认只读：不联网、不安装扩展、不调用模型、不读取也不输出任何凭据内容；
    只有显式传 -Install 时才尝试安装官方扩展，并把真实输出与退出码原样记录。

    退出码 0 表示自动前置条件齐备、A4 仍待人工验证（client-ready-manual-pending）；
    退出码 1 表示自动前置条件缺失（blocked）。两者都不表示 A4 通过。

.PARAMETER Install
    显式要求尝试安装官方扩展 GitHub.copilot 与 GitHub.copilot-chat。需要联网与有效订阅；
    其中 Copilot Chat 内置在 VS Code 里（实测 1.145.2 为 0.73.0），市场安装通常会被拒绝降级，
    脚本如实记录失败原因，不把失败改写成成功。

.EXAMPLE
    pwsh -NoProfile -File scripts/copilot-smoke.ps1
    pwsh -NoProfile -File scripts/copilot-smoke.ps1 -Install
#>
[CmdletBinding()]
param(
    [switch]$Install
)

$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$PluginDir = Join-Path $Root 'lib\plugin'
$ExpectedSkills = @('dsh-superagent', 'dsh-superagent-feishu', 'dsh-superagent-github')
$Official = @('GitHub.copilot', 'GitHub.copilot-chat')

# 定位 Stable 安装根、应用目录、版本与 code CLI；找不到时返回 $null。
function Find-StableCode {
    $candidates = [System.Collections.Generic.List[string]]::new()
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'Microsoft VS Code')) }
    if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code')) }
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code')) }

    foreach ($root in $candidates) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $appDir = Get-ChildItem -LiteralPath $root -Directory |
            ForEach-Object { Join-Path $_.FullName 'resources\app' } |
            Where-Object { Test-Path -LiteralPath (Join-Path $_ 'product.json') } |
            Select-Object -First 1
        if (-not $appDir) { continue }
        $product = Get-Content -LiteralPath (Join-Path $appDir 'product.json') -Raw | ConvertFrom-Json
        return [pscustomobject]@{
            Root    = $root
            AppDir  = $appDir
            Version = $product.version
            Commit  = $product.commit
            Cli     = (Join-Path $root 'bin\code.cmd')
        }
    }
    return $null
}

# 读取内置 Copilot Chat 扩展清单；VS Code 1.116 起 Chat 以内置扩展形式随 IDE 分发。
function Get-BuiltinChat([string]$AppDir) {
    $manifest = Join-Path $AppDir 'extensions\copilot\package.json'
    if (-not (Test-Path -LiteralPath $manifest)) { return $null }
    $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    return [pscustomobject]@{
        Path      = $manifest
        Name      = $json.name
        Publisher = $json.publisher
        Version   = $json.version
        Display   = $json.displayName
        Engines   = $json.engines.vscode
        BuiltIn   = $true
    }
}

# 从 workbench 主脚本确认 Agent Plugins 设置键与命令是否存在（能力检测，不改任何配置）。
function Get-PluginCapability([string]$AppDir) {
    $main = Join-Path $AppDir 'out\vs\workbench\workbench.desktop.main.js'
    if (-not (Test-Path -LiteralPath $main)) { return $null }
    $text = [System.IO.File]::ReadAllText($main)
    return [pscustomobject]@{
        ChatPluginsEnabled  = $text.Contains('chat.plugins.enabled')
        ChatPluginLocations = $text.Contains('chat.pluginLocations')
        LegacyPluginPaths   = $text.Contains('chat.plugins.paths')
        Commands            = @([regex]::Matches($text, 'workbench\.action\.chat\.[A-Za-z]*[Pp]lugin[A-Za-z]*') |
            ForEach-Object Value | Sort-Object -Unique)
    }
}

# 只报告登录状态的存在性：globalStorage 目录与系统凭据条目的有无，绝不读取内容。
function Get-LoginExistence {
    $storage = Join-Path $env:APPDATA 'Code\User\globalStorage'
    $list = & cmdkey /list 2>$null | Out-String
    $entries = if ($list) { @([regex]::Matches($list, '(?im)^\s*Target:.*copilot.*$')).Count } else { 0 }
    return [pscustomobject]@{
        Determinable      = $false
        Reason            = '登录态只存在于 VS Code 密钥存储与 Copilot Chat 会话内，IDE 外无法可靠判定；此处仅报告存在性'
        GlobalStorage     = [ordered]@{
            'github.copilot'      = Test-Path -LiteralPath (Join-Path $storage 'github.copilot')
            'github.copilot-chat' = Test-Path -LiteralPath (Join-Path $storage 'github.copilot-chat')
        }
        CredentialEntries = $entries
    }
}

# 读取用户设置中是否已声明插件位置；只做文本匹配，不解析 JSONC，也不判定启用状态。
function Get-UserPluginSettings {
    $settings = Join-Path $env:APPDATA 'Code\User\settings.json'
    if (-not (Test-Path -LiteralPath $settings)) {
        return [pscustomobject]@{ File = $settings; Exists = $false; HasPluginLocations = $false; PointsToLibPlugin = $false }
    }
    $raw = Get-Content -LiteralPath $settings -Raw
    return [pscustomobject]@{
        File               = $settings
        Exists             = $true
        HasPluginLocations = [bool]($raw -match '"chat\.pluginLocations"')
        PointsToLibPlugin  = [bool]($raw -match 'lib[/\\]+plugin')
    }
}

# 汇总一条检查结果；required 为假时只作信息项，不影响退出码。
function Add-Check([System.Collections.ArrayList]$List, [string]$Name, [bool]$Required, [bool]$Ok, [string]$Detail) {
    $List.Add([ordered]@{ check = $Name; required = $Required; ok = $Ok; detail = $Detail }) | Out-Null
}

$checks = [System.Collections.ArrayList]::new()
$editor = Find-StableCode

# 1. Stable 编辑器。
$editorDetail = '未找到 VS Code Stable 安装'
if ($editor) { $editorDetail = "版本 $($editor.Version)，安装根 $($editor.Root)" }
Add-Check $checks 'vs-code-stable' $true ([bool]$editor) $editorDetail

$chat = if ($editor) { Get-BuiltinChat $editor.AppDir } else { $null }
$chatDetail = '未找到内置 Copilot Chat 扩展'
if ($chat) { $chatDetail = "$($chat.Publisher).$($chat.Name) $($chat.Version)（内置，engines $($chat.Engines)）" }
Add-Check $checks 'builtin-copilot-chat' $true ([bool]$chat) $chatDetail

# 2. 官方扩展列表：Chat 为内置；GitHub.copilot 是补全扩展，缺失不影响插件平台。
$extensions = @()
if ($editor -and (Test-Path -LiteralPath $editor.Cli)) { $extensions = @(& $editor.Cli --list-extensions --show-versions 2>$null) }
foreach ($id in $Official) {
    $hit = @($extensions | Where-Object { $_ -match "^$([regex]::Escape($id))@" }) | Select-Object -First 1
    $builtIn = $chat -and ($id -eq 'GitHub.copilot-chat')
    $detail = '未安装（补全扩展；插件平台由内置 Chat 提供）'
    if ($hit) { $detail = $hit } elseif ($builtIn) { $detail = "内置 $($chat.Version)，不经市场安装" }
    Add-Check $checks "extension-$id" $false ([bool]$hit -or [bool]$builtIn) $detail
}

# 3. Agent Plugins 能力。
$capability = if ($editor) { Get-PluginCapability $editor.AppDir } else { $null }
$capabilityOk = [bool]($capability -and $capability.ChatPluginsEnabled -and $capability.ChatPluginLocations)
$capabilityDetail = '无法读取 workbench 主脚本'
if ($capability) {
    $capabilityDetail = "chat.plugins.enabled=$($capability.ChatPluginsEnabled)，chat.pluginLocations=$($capability.ChatPluginLocations)，命令 $($capability.Commands.Count) 个"
}
Add-Check $checks 'agent-plugins-capability' $true $capabilityOk $capabilityDetail

# 4. 插件产物与三个技能。
$manifest = Join-Path $PluginDir 'plugin.json'
$pluginOk = Test-Path -LiteralPath $manifest
$pluginName = ''
$pluginVersion = ''
if ($pluginOk) {
    $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $pluginName = $json.name
    $pluginVersion = $json.version
}
$packageDetail = "缺少 $manifest，先执行 pnpm build"
if ($pluginOk) { $packageDetail = "$pluginName@$pluginVersion，路径 $PluginDir（需先 pnpm build）" }
Add-Check $checks 'lib-plugin-package' $true $pluginOk $packageDetail

$skills = @()
if (Test-Path -LiteralPath (Join-Path $PluginDir 'skills')) {
    $skills = @(Get-ChildItem -LiteralPath (Join-Path $PluginDir 'skills') -Directory | Select-Object -ExpandProperty Name | Sort-Object)
}
$skillsOk = ($skills.Count -eq $ExpectedSkills.Count) -and -not @($ExpectedSkills | Where-Object { $skills -notcontains $_ })
$skillsText = '无'
if ($skills.Count) { $skillsText = $skills -join ', ' }
Add-Check $checks 'plugin-skills' $true $skillsOk "技能: $skillsText；期望 3 个"

# 5. 可选安装：只有显式 -Install 才联网，失败原因原样记录。
$installLog = [System.Collections.ArrayList]::new()
if ($Install -and $editor) {
    foreach ($id in $Official) {
        $before = @($extensions | Where-Object { $_ -match "^$([regex]::Escape($id))@" })
        $beforeText = '未安装'
        if ($before.Count) { $beforeText = $before[0] }
        $output = & $editor.Cli --install-extension $id --force 2>&1 | Out-String
        $exit = $LASTEXITCODE
        $lastLine = ($output.Trim() -split "`r?`n" | Select-Object -Last 1)
        $installLog.Add([ordered]@{ id = $id; before = $beforeText; exitCode = $exit; output = $lastLine }) | Out-Null
    }
    $extensions = @(& $editor.Cli --list-extensions --show-versions 2>$null)
    foreach ($id in $Official) {
        $hit = @($extensions | Where-Object { $_ -match "^$([regex]::Escape($id))@" }) | Select-Object -First 1
        $afterText = '未安装'
        if ($hit) { $afterText = $hit }
        $installLog.Add([ordered]@{ id = $id; after = $afterText }) | Out-Null
    }
}

# 6. 登录状态存在性与用户设置（只读）。
$login = Get-LoginExistence
$settings = Get-UserPluginSettings

# 7. Copilot CLI 只作前置证据，明确不计入 A4 验收。
$cliVersion = if (Get-Command 'copilot' -ErrorAction SilentlyContinue) { (& copilot --version 2>$null | Select-Object -First 1) } else { '' }

$blocked = @($checks | Where-Object { $_.required -and -not $_.ok })
$status = if ($blocked.Count) { 'blocked' } else { 'client-ready-manual-pending' }

# 只列出官方扩展；其余第三方扩展与本项验收无关，不写入报告。
$officialInstalled = @($extensions | Where-Object { $Official -contains ($_ -split '@')[0] })

$report = [ordered]@{
    scope = 'Windows + VS Code Stable 官方 Copilot / Copilot Chat；Insiders（用户已卸载）、Copilot CLI、其他编辑器与宿主均不计入 A4'
    generatedAt = (Get-Date).ToString('o')
    a4Status = $status
    editor = $editor
    copilotChat = $chat
    installedExtensions = [ordered]@{ total = $extensions.Count; official = $officialInstalled }
    pluginCapability = $capability
    plugin = [ordered]@{ path = $PluginDir; name = $pluginName; version = $pluginVersion; skills = $skills }
    login = $login
    userSettings = $settings
    install = $installLog
    preEvidence = [ordered]@{
        copilotCli = $cliVersion
        note = 'Copilot CLI 只能证明插件包可被读取，不计入 A4 验收'
    }
    checks = $checks
    manualSteps = @(
        'Stable 打开后按 Ctrl+Shift+P，运行 “Chat: Install Plugin from Source”（workbench.action.chat.installPluginFromSource），输入插件目录的绝对路径（实测 file:/// URI 会被拒，例如 D:\WorkSpace\dsh-superagent-prototype\lib\plugin）；或在用户设置写入 chat.pluginLocations（该键为机器级 MACHINE，工作区设置无效）。',
        '在 Copilot Chat 里登录有 Copilot 权限的 GitHub 账号；本脚本只报登录状态存在性，不读取任何凭据。',
        '确认 Copilot 的插件列表中 dsh-superagent 处于启用状态，且技能 dsh-superagent、dsh-superagent-github、dsh-superagent-feishu 均可见。',
        '先在仓库根启动守护与 MCP 端点（pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action start -Config <机器配置文件>），再在 Copilot Chat 中确认工具可列并可调用：orchestrator_read(tickets) → orchestrator_route → orchestrator_reply。',
        '把插件页、技能列表与工具调用截图保存到 .artifacts/screenshots/（不提交），然后把结果回填 docs/009-copilot-plugin.md 的 §11。'
    )
}

$report | ConvertTo-Json -Depth 8

if ($blocked.Count) {
    Write-Host ''
    Write-Host "A4 自动前置条件缺失 $($blocked.Count) 项：$(($blocked | ForEach-Object { $_.check }) -join ', ')" -ForegroundColor Yellow
    exit 1
}
Write-Host ''
Write-Host '自动前置条件齐备；A4 仍为“客户端就位、待人工验证”，不得据此标通过。' -ForegroundColor Yellow
exit 0

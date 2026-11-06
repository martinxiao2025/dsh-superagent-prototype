#Requires -Version 7.0
<#
.SYNOPSIS
    Windows 下的 dsh-superagent 守护与保活演练脚本。

.DESCRIPTION
    产品自带的 scripts/dsh-superagent 依赖 tmux、ps 与 fcntl，只能在 POSIX 上运行。
    本脚本用 PowerShell 提供等价的 Windows 守护能力：单实例、手动停止标记、子进程日志留存、
    崩溃后按延迟自动拉起、健康探测，以及一次可复跑的强制终止演练（A6）。

    不引入 nssm 等第三方服务包装器，也不注册计划任务；守护进程本身是隐藏的 pwsh 进程，
    由 `start` 拉起、由 `stop` 结束。这样既不需要管理员权限，也不会在系统里留下持久项。

.PARAMETER Action
    start / supervise / stop / status / drill。supervise 是内部循环，由 start 以隐藏进程方式拉起。

.PARAMETER Profile
    DSH profile 名，默认取环境变量 DSH_SUPERAGENT_PROFILE 或 `superagent`。

.PARAMETER Url
    管理 API 基地址，默认取 DSH_SUPERAGENT_URL 或 `http://127.0.0.1:3082`。

.PARAMETER Command
    要守护的命令行。缺省为 `dsh --profile <Profile> --no-open`。
    本机没有 dsh 宿主时，演练可用 `node --experimental-transform-types scripts/keepalive-host.mjs`。

.PARAMETER RestartDelaySeconds
    子进程退出后到下一次拉起之间的等待秒数，默认 1。

.PARAMETER MaxRestarts
    最大连续重启次数，0 表示不限制（默认）。

.PARAMETER TimeoutSeconds
    start/drill 等待健康就绪的秒数，默认 120。

.EXAMPLE
    pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action start
    pwsh -NoProfile -File scripts/dsh-superagent-windows.ps1 -Action drill `
        -Command 'node --experimental-transform-types scripts/keepalive-host.mjs'
#>
[CmdletBinding()]
param(
    [ValidateSet('start', 'supervise', 'stop', 'status', 'drill')]
    [string]$Action = 'status',
    [string]$Profile = $(if ($env:DSH_SUPERAGENT_PROFILE) { $env:DSH_SUPERAGENT_PROFILE } else { 'superagent' }),
    [string]$Url = $(if ($env:DSH_SUPERAGENT_URL) { $env:DSH_SUPERAGENT_URL } else { 'http://127.0.0.1:3082' }),
    [string]$Command = $(if ($env:DSH_SUPERAGENT_COMMAND) { $env:DSH_SUPERAGENT_COMMAND } else { '' }),
    [int]$RestartDelaySeconds = 1,
    [int]$MaxRestarts = 0,
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Control = Join-Path $Root ".artifacts\control\windows\$Profile"
$Logs = Join-Path $Root '.artifacts\logs'
$SupervisorPidFile = Join-Path $Control 'supervisor.pid'
$ServicePidFile = Join-Path $Control 'service.pid'
$StopMarker = Join-Path $Control 'manually-stopped'
$RestartCounter = Join-Path $Control 'restarts.count'
$SupervisorLog = Join-Path $Logs "dsh-superagent-$Profile-supervisor.log"

New-Item -ItemType Directory -Force -Path $Control, $Logs | Out-Null

# 把含空格的参数包成引号形式；Start-Process 的 ArgumentList 只是按空格拼接，不会自动加引号。
function Quote-Arg([string]$Value) {
    if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
    return $Value
}

# 返回缺省命令行；本机安装 dsh 后即为产品真实启动方式。
function Get-ServiceCommand {
    if ($Command) { return $Command }
    return "dsh --profile $Profile --no-open"
}

# 追加一行带时间戳的守护日志，编码为 UTF-8 无 BOM。
function Write-Log([string]$Message) {
    $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz'), $Message
    Add-Content -LiteralPath $SupervisorLog -Value $line -Encoding utf8
}

# 读取 PID 文件；文件缺失、内容非法或进程已退出时返回 $null。
function Read-LivePid([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue).Trim()
    $value = 0
    if (-not [int]::TryParse($text, [ref]$value)) { return $null }
    if (Get-Process -Id $value -ErrorAction SilentlyContinue) { return $value }
    return $null
}

# 读取管理 API 的健康状态；不可达时返回 $null。
function Get-Health {
    try {
        $response = Invoke-RestMethod -Uri ($Url.TrimEnd('/') + '/orchestrator/api/state') -TimeoutSec 2 `
            -Headers @{ 'x-orchestrator-request' = '1' }
    } catch {
        return $null
    }
    return $response
}

# 轮询直到 runtime 健康为 ready；超时返回 $null。
function Wait-Ready([int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $state = Get-Health
        if ($state -and $state.health -and $state.health.runtime -and $state.health.runtime.state -eq 'ready') {
            return $state
        }
        Start-Sleep -Milliseconds 250
    }
    return $null
}

# 运行 MCP 探针（initialize + tools/list），返回解析后的 JSON 或 $null。
function Invoke-Probe {
    $probe = Join-Path $PSScriptRoot 'keepalive-probe.mjs'
    if (-not (Test-Path -LiteralPath $probe)) { return $null }
    $output = & node $probe 2>&1
    $code = $LASTEXITCODE
    try { $parsed = $output | ConvertFrom-Json } catch { $parsed = $null }
    if ($parsed) { $parsed | Add-Member -NotePropertyName exit -NotePropertyValue $code -Force }
    return $parsed
}

# 清理残留的 PID 文件与停止标记；不触碰仍在运行的进程。
function Clear-State {
    Remove-Item -LiteralPath $SupervisorPidFile, $ServicePidFile, $RestartCounter -ErrorAction SilentlyContinue
}

# 结束一个进程树；先请求正常结束，超时后强制终止。
function Stop-Tree([int]$ProcessId, [int]$GraceSeconds = 5) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    & taskkill.exe /PID $ProcessId /T 2>$null | Out-Null
    $deadline = (Get-Date).AddSeconds($GraceSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 200
    }
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
}

# 守护循环：启动子进程、等待退出、按延迟重启，直到出现手动停止标记或达到重启上限。
function Invoke-Supervise {
    $restarts = 0
    Write-Log "supervisor start pid=$PID profile=$Profile command=$(Get-ServiceCommand)"
    while (-not (Test-Path -LiteralPath $StopMarker)) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $out = Join-Path $Logs "dsh-superagent-$Profile-$stamp-$PID.out.log"
        $err = Join-Path $Logs "dsh-superagent-$Profile-$stamp-$PID.err.log"
        $started = Get-Date
        try {
            $child = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-Command', (Quote-Arg (Get-ServiceCommand))) `
                -WorkingDirectory $Root -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        } catch {
            Write-Log "child spawn failed: $($_.Exception.Message)"
            Start-Sleep -Seconds ([Math]::Max(1, $RestartDelaySeconds))
            continue
        }
        Set-Content -LiteralPath $ServicePidFile -Value $child.Id -Encoding utf8
        Write-Log "child start pid=$($child.Id) out=$out"
        $child.WaitForExit()
        $uptime = [int]((Get-Date) - $started).TotalMilliseconds
        Write-Log "child exit pid=$($child.Id) code=$($child.ExitCode) uptimeMs=$uptime"
        Remove-Item -LiteralPath $ServicePidFile -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $StopMarker) { break }
        # 子进程正常退出也可能是被人为结束；只要没有停止标记，就按崩溃处理。
        if ($MaxRestarts -gt 0 -and $restarts -ge $MaxRestarts) {
            Write-Log "restart limit reached ($MaxRestarts); supervisor exits"
            break
        }
        $restarts++
        Set-Content -LiteralPath $RestartCounter -Value $restarts -Encoding utf8
        Write-Log "restart scheduled in ${RestartDelaySeconds}s (count=$restarts)"
        Start-Sleep -Seconds ([Math]::Max(1, $RestartDelaySeconds))
    }
    Write-Log "supervisor stop pid=$PID restarts=$restarts"
}

# start：清理旧状态后以隐藏进程拉起守护循环，并等待健康就绪。
function Invoke-Start {
    $running = Read-LivePid $SupervisorPidFile
    if ($running) {
        Write-Host "守护进程已在运行（PID $running），未重复启动。"
        return 0
    }
    if (Test-Path -LiteralPath $StopMarker) {
        Write-Host '存在手动停止标记；先执行 -Action stop 的清理，或删除该标记后再启动。'
        return 1
    }
    Clear-State
    $arguments = @('-NoProfile', '-File', (Quote-Arg $PSCommandPath), '-Action', 'supervise', '-Profile', (Quote-Arg $Profile), '-Url', (Quote-Arg $Url),
        '-RestartDelaySeconds', "$RestartDelaySeconds", '-MaxRestarts', "$MaxRestarts")
    if ($Command) { $arguments += @('-Command', (Quote-Arg $Command)) }
    $supervisor = Start-Process -FilePath 'pwsh' -ArgumentList $arguments -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath $SupervisorPidFile -Value $supervisor.Id -Encoding utf8
    $state = Wait-Ready $TimeoutSeconds
    if (-not $state) {
        Write-Host "启动健康检查超时（${TimeoutSeconds}s）；请查看 $SupervisorLog"
        return 1
    }
    Write-Host ("dsh-superagent 已就绪：supervisor={0} health={1}" -f $supervisor.Id, ($state.health.runtime.state))
    return 0
}

# stop：写手动停止标记，结束子进程树与守护进程，并清理 PID 文件与标记。
function Invoke-Stop {
    Set-Content -LiteralPath $StopMarker -Value (Get-Date).ToString('o') -Encoding utf8
    $service = Read-LivePid $ServicePidFile
    $supervisor = Read-LivePid $SupervisorPidFile
    if ($service) { Stop-Tree $service 10 }
    if ($supervisor) { Stop-Tree $supervisor 5 }
    Clear-State
    # 进程已全部退出后清掉标记；否则下次 start 会被“存在手动停止标记”拒绝。
    $alive = @($service, $supervisor) | Where-Object { $_ -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) }
    if (-not $alive.Count) { Remove-Item -LiteralPath $StopMarker -ErrorAction SilentlyContinue }
    Write-Host 'dsh-superagent 已停止；自动恢复保持暂停，直到再次 start。'
    return 0
}

# status：输出守护进程、子进程、健康与重启次数的 JSON。
function Invoke-Status {
    $state = Get-Health
    $restarts = 0
    if (Test-Path -LiteralPath $RestartCounter) { [int]::TryParse((Get-Content -LiteralPath $RestartCounter -Raw).Trim(), [ref]$restarts) | Out-Null }
    $report = [ordered]@{
        profile = $Profile
        url = $Url
        supervisor = Read-LivePid $SupervisorPidFile
        service = Read-LivePid $ServicePidFile
        manuallyStopped = (Test-Path -LiteralPath $StopMarker)
        restarts = $restarts
        health = if ($state) { $state.health } else { $null }
        setup = if ($state) { $state.setup } else { $null }
        log = $SupervisorLog
    }
    $report | ConvertTo-Json -Depth 6
    $script:StatusExit = if ($report.supervisor -and $state -and $state.health.runtime.state -eq 'ready') { 0 } else { 1 }
}

# drill：A6 演练。启动 → 用 taskkill /F 强杀真实子进程 → 观察自动拉起 →
# 用管理 API 与 MCP 探针确认恢复 → 记录恢复耗时与日志证据，最后停止并清理。
function Invoke-Drill {
    $evidenceDir = Join-Path $Root '.artifacts\keepalive'
    New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $evidenceFile = Join-Path $evidenceDir "drill-$stamp.json"
    $result = [ordered]@{
        startedAt = (Get-Date).ToString('o')
        profile = $Profile
        command = Get-ServiceCommand
        lockWaitMs = 0
        startupMs = $null
        kill = $null
        recoveryMs = $null
        restarts = $null
        probeBefore = $null
        probeAfter = $null
        healthAfter = $null
        logs = @()
        evidence = $evidenceFile
        passed = $false
        reason = ''
    }

    # 演练必须从干净状态开始。
    Set-Content -LiteralPath $StopMarker -Value (Get-Date).ToString('o') -Encoding utf8
    $oldService = Read-LivePid $ServicePidFile
    $oldSupervisor = Read-LivePid $SupervisorPidFile
    if ($oldService) { Stop-Tree $oldService 10 }
    if ($oldSupervisor) { Stop-Tree $oldSupervisor 5 }
    Clear-State
    Remove-Item -LiteralPath $StopMarker -ErrorAction SilentlyContinue

    # 上一次硬杀可能留下 proper-lockfile 的锁目录；等过 30 秒 stale 窗口再启动，避免把失败当结论。
    $stateDir = if ($env:KEEPALIVE_STATE_DIR) { $env:KEEPALIVE_STATE_DIR } else { Join-Path $Root '.artifacts\keepalive\state' }
    $lockDir = "$stateDir.lock"
    if (Test-Path -LiteralPath $lockDir) {
        $age = ((Get-Date) - (Get-Item -LiteralPath $lockDir).LastWriteTime).TotalSeconds
        if ($age -lt 31) {
            $wait = [int](32 - $age)
            $result.lockWaitMs = $wait * 1000
            Start-Sleep -Seconds $wait
        }
    }

    $startBegin = Get-Date
    $code = Invoke-Start
    $result.startupMs = [int]((Get-Date) - $startBegin).TotalMilliseconds
    if ($code -ne 0) {
        $result.reason = '首次启动未就绪'
        $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidenceFile -Encoding utf8
        return 1
    }

    $service = Read-LivePid $ServicePidFile
    if (-not $service) {
        $result.reason = '未找到被守护的子进程 PID'
        $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidenceFile -Encoding utf8
        return 1
    }
    # PID 可能被系统复用；核对命令行，避免误杀无关进程。
    $marker = if ((Get-ServiceCommand) -match '([^\s\\/]+\.(?:mjs|js|ts))') { $Matches[1] } else { ((Get-ServiceCommand) -split '\s+')[0] }
    $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $service" -ErrorAction SilentlyContinue).CommandLine
    if (-not $commandLine -or $commandLine -notlike "*$marker*") {
        $result.reason = "PID $service 的命令行不含 $marker，拒绝强杀"
        $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidenceFile -Encoding utf8
        Invoke-Stop | Out-Null
        return 1
    }
    $result.probeBefore = Invoke-Probe

    # 真实强制终止整棵进程树，模拟崩溃而不是优雅退出。
    $killAt = Get-Date
    $result.kill = [ordered]@{ pid = $service; at = $killAt.ToString('o'); command = "taskkill /F /T /PID $service" }
    & taskkill.exe /F /T /PID $service 2>&1 | Out-Null
    $killDeadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $killDeadline -and (Get-Process -Id $service -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 100
    }
    $result.kill.exited = -not [bool](Get-Process -Id $service -ErrorAction SilentlyContinue)

    # 等待守护进程拉起新的子进程并恢复健康；恢复时间从强杀时刻算起。
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $recovered = $false
    while ((Get-Date) -lt $deadline) {
        $current = Read-LivePid $ServicePidFile
        $state = Get-Health
        if ($current -and $current -ne $service -and $state -and $state.health.runtime -and $state.health.runtime.state -eq 'ready') {
            $probe = Invoke-Probe
            if ($probe -and $probe.ok -eq $true) {
                $result.recoveryMs = [int]((Get-Date) - $killAt).TotalMilliseconds
                $result.probeAfter = $probe
                $result.healthAfter = $state.health
                $result.restarts = if (Test-Path -LiteralPath $RestartCounter) { [int](Get-Content -LiteralPath $RestartCounter -Raw).Trim() } else { $null }
                $recovered = $true
                break
            }
        }
        Start-Sleep -Milliseconds 250
    }

    $result.passed = [bool]($recovered -and $result.probeBefore.ok -eq $true -and $result.kill.exited)
    if (-not $result.passed) { $result.reason = '强杀后未在超时内恢复，或 MCP 探针未通过' }
    $result.logs = @(Get-ChildItem -LiteralPath $Logs -Filter "dsh-superagent-$Profile-*" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -ExpandProperty FullName)
    $result.finishedAt = (Get-Date).ToString('o')
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidenceFile -Encoding utf8

    Invoke-Stop | Out-Null
    Write-Host ($result | ConvertTo-Json -Depth 8)
    if ($result.passed) { return 0 }
    return 1
}

switch ($Action) {
    'supervise' { Invoke-Supervise; exit 0 }
    'start' { exit (Invoke-Start) }
    'stop' { exit (Invoke-Stop) }
    'status' { Invoke-Status; exit $script:StatusExit }
    'drill' { exit (Invoke-Drill) }
}

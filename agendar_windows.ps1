# Registra o robô no Agendador de Tarefas do Windows (execução diária às 07:30).
# Execute no PowerShell, dentro da pasta rpa/:   .\agendar_windows.ps1
$pasta  = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = (Get-Command python).Source
$acao   = New-ScheduledTaskAction -Execute $python -Argument "-m bot_cotacoes" -WorkingDirectory $pasta
$gatilho = New-ScheduledTaskTrigger -Daily -At 7:30am
$config  = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName "AgroConecta - Robo de Cotacoes" -Action $acao -Trigger $gatilho `
    -Settings $config -Description "Coleta diaria de cotacoes CEAGESP para o AgroConecta" -Force
Write-Host "Tarefa registrada. Logs em $pasta\logs"

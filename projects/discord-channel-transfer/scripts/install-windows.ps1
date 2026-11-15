param(
  [Parameter(Mandatory = $true)][string]$PiHost,
  [Parameter(Mandatory = $true)][string]$PiUser,
  [Parameter(Mandatory = $true)][string]$HostKey
)
$ErrorActionPreference = 'Stop'
if ($PiHost -notmatch '^[A-Za-z0-9.:-]+$' -or $PiUser -notmatch '^[a-z_][a-z0-9_-]*$') { throw 'Ungültiger Host oder Benutzername.' }
if ($HostKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/]+=*$') { throw 'Verifizierten Ed25519-Hostschlüssel angeben.' }
if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) { throw 'Windows OpenSSH-Client fehlt.' }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\DiscordTransfer'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
$knownHosts = Join-Path $installDir 'known_hosts'
[IO.File]::WriteAllText($knownHosts, "$PiHost $HostKey`n", [Text.UTF8Encoding]::new($false))
$launcher = @"
@echo off
title MRGBBN Discord Transfer
ssh.exe -o "UserKnownHostsFile=%~dp0known_hosts" -o StrictHostKeyChecking=yes -o ServerAliveInterval=30 -o ConnectTimeout=10 -t $PiUser@$PiHost "/home/$PiUser/.local/bin/channel-transfer"
if errorlevel 1 (
  echo.
  echo Verbindung fehlgeschlagen. Pi und PC muessen sich im gleichen Netz befinden.
  echo Verwende das Linux-Passwort des Pi-Benutzers $PiUser.
  pause
)
"@
[IO.File]::WriteAllText((Join-Path $installDir 'dct.cmd'), $launcher, [Text.ASCIIEncoding]::new())
$userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $installDir).TrimStart(';'), 'User')
}
if (($env:Path -split ';') -notcontains $installDir) { $env:Path += ';' + $installDir }
# Explorer must see the new per-user PATH before it launches a fresh CMD window.
if (-not ('ChannelTransfer.EnvironmentBroadcast' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace ChannelTransfer {
  public static class EnvironmentBroadcast {
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
  }
}
'@
}
$broadcastResult = [UIntPtr]::Zero
[void][ChannelTransfer.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$broadcastResult)
Write-Output 'Installiert. Neues CMD-Fenster öffnen und dct eingeben.'
Write-Output ('Direkter Start: ' + (Join-Path $installDir 'dct.cmd'))

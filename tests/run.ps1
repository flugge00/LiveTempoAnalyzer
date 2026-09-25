# Runs the DSP tests. Uses `node` if installed, otherwise VS Code's bundled Electron in Node mode.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'run.mjs'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  & node $script
} else {
  $code = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'
  $env:ELECTRON_RUN_AS_NODE = '1'
  $p = Start-Process -FilePath $code -ArgumentList "`"$script`"" -Wait -PassThru -NoNewWindow
  Remove-Item Env:ELECTRON_RUN_AS_NODE
  exit $p.ExitCode
}

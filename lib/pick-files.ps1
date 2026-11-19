param([string]$OutFile = "")

# NOTE: this file must stay ASCII-only (no BOM needed then).
# Windows PowerShell 5.1 reads a BOM-less file as ANSI/GBK; a Chinese comment
# can then swallow the following newline and the script fails to parse.
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

$owner = New-Object System.Windows.Forms.Form
$owner.Text = "Pick attachment files"
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0

# With two monitors CenterScreen can open on the other screen; park the owner at
# the center of the working area of the monitor that currently holds the mouse.
$screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position)
$area = $screen.WorkingArea
$owner.Location = New-Object System.Drawing.Point -Property @{
  X = [int]($area.X + ($area.Width / 2))
  Y = [int]($area.Y + ($area.Height / 2))
}
$owner.Show()
$owner.Activate()

$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Choose attachments"
$dialog.Multiselect = $true
$dialog.CheckFileExists = $true
$dialog.Filter = "All files (*.*)|*.*"

try {
  $answer = $dialog.ShowDialog($owner)
} finally {
  try { $owner.Close() } catch { }
  $owner.Dispose()
}

$picked = @()
if ($answer -eq [System.Windows.Forms.DialogResult]::OK) {
  $picked = $dialog.FileNames
}

# The console code page is GBK, so Chinese paths returned through stdout arrive
# at node as mojibake. Write them to a UTF-8 file and let node read that instead.
if ($OutFile) {
  try {
    $json = ConvertTo-Json -InputObject @($picked) -Compress
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Write-Output ($picked -join "`n")
  }
} else {
  Write-Output ($picked -join "`n")
}
$ErrorActionPreference = "Stop"
$models = @(
  @{ Name = "vosk-model-small-cn-0.22"; Size = 43898754; Url = "https://hf-mirror.com/localstack/vosk-models/resolve/main/vosk-model-small-cn-0.22.zip" },
  @{ Name = "vosk-model-small-en-us-0.15"; Size = 41205931; Url = "https://hf-mirror.com/localstack/vosk-models/resolve/main/vosk-model-small-en-us-0.15.zip" },
  @{ Name = "vosk-model-small-ja-0.22"; Size = 49704573; Url = "https://hf-mirror.com/localstack/vosk-models/resolve/main/vosk-model-small-ja-0.22.zip" }
)
$modelsDir = Join-Path $PSScriptRoot "..\models"
New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
$chunk = 4MB
foreach ($m in $models) {
  $zip = Join-Path $modelsDir ($m.Name + ".zip")
  if ((Test-Path $zip) -and ((Get-Item $zip).Length -eq $m.Size)) { Write-Host "OK $($m.Name)"; continue }
  $n = [math]::Ceiling($m.Size / $chunk)
  Write-Host "Downloading $($m.Name) in $n parts..."
  $batch = @()
  for ($i = 0; $i -lt $n; $i++) {
    $start = $i * $chunk
    $end = [math]::Min(($i + 1) * $chunk - 1, $m.Size - 1)
    $part = Join-Path $env:TEMP "$($m.Name).part$i"
    if ((Test-Path $part) -and ((Get-Item $part).Length -eq ($end - $start + 1))) { continue }
    $cargs = @("-sL", "--retry", "6", "--retry-delay", "2", "--max-time", "600", "-r", "$start-$end", "-o", $part, $m.Url)
    $batch += Start-Process -FilePath "curl.exe" -ArgumentList $cargs -PassThru -WindowStyle Hidden
    if ($batch.Count -ge 8) { $batch | Wait-Process; $batch = @() }
  }
  if ($batch.Count -gt 0) { $batch | Wait-Process }
  $out = [System.IO.File]::Create($zip)
  for ($i = 0; $i -lt $n; $i++) {
    $part = Join-Path $env:TEMP "$($m.Name).part$i"
    $bytes = [System.IO.File]::ReadAllBytes($part)
    $out.Write($bytes, 0, $bytes.Length)
  }
  $out.Close()
  for ($i = 0; $i -lt $n; $i++) { Remove-Item (Join-Path $env:TEMP "$($m.Name).part$i") -Force -ErrorAction SilentlyContinue }
  $len = (Get-Item $zip).Length
  Write-Host "Downloaded $($m.Name): $len / $($m.Size)"
  if ($len -ne $m.Size) { throw "Size mismatch for $($m.Name)" }
  $dest = Join-Path $modelsDir $m.Name
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $modelsDir -Force
}
Write-Host "ALL MODELS READY"

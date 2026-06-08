param(
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $RepoPath

$inside = git rev-parse --is-inside-work-tree 2>$null
if ($inside -ne "true") {
  throw "Not a git repository: $RepoPath"
}

$branch = (git branch --show-current).Trim()
if (-not $branch) {
  $branch = "main"
}

git add -A
$status = git status --porcelain
if ($status) {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  git commit -m "auto-sync: $stamp"
}

git pull --rebase --autostash origin $branch
git push origin $branch

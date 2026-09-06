param(
  [string]$RepositoryPath = (Get-Location).Path,
  [string]$Revision,
  [string]$SshKeyPath,
  [string]$HostName = '81.70.224.19',
  [string]$RemoteUser = 'ubuntu',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $SshKeyPath) { throw 'SshKeyPath is required.' }
if (-not (Test-Path -LiteralPath $SshKeyPath)) { throw "SSH key not found: $SshKeyPath" }
if (-not (Test-Path -LiteralPath (Join-Path $RepositoryPath '.git'))) { throw "Not a Git worktree: $RepositoryPath" }
if (-not $Revision) { $Revision = (git -C $RepositoryPath rev-parse --short HEAD).Trim() }

$resolvedRevision = (git -C $RepositoryPath rev-parse --verify "$Revision^{commit}").Trim()
$shortRevision = $resolvedRevision.Substring(0, 8)
$archivePath = Join-Path $env:TEMP "laixue-$shortRevision.zip"
$remoteArchive = "/tmp/laixue-$shortRevision.zip"

Remove-Item -LiteralPath $archivePath -ErrorAction SilentlyContinue
git -C $RepositoryPath archive --format=zip --output=$archivePath $resolvedRevision

try {
  & scp -i $SshKeyPath $archivePath "${RemoteUser}@${HostName}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw 'Archive upload failed.' }

  $dryRunFlag = if ($DryRun) { '--dry-run' } else { '' }
  $remoteScript = @"
set -euo pipefail
archive='$remoteArchive'
release_dir=`$(mktemp -d /tmp/laixue-release.XXXXXX)
cleanup() { rm -rf "`$release_dir" "`$archive"; }
trap cleanup EXIT
unzip -oq "`$archive" -d "`$release_dir"
rsync -a --delete $dryRunFlag \
  --exclude='.env.production' \
  --exclude='.deployed-revision' \
  --exclude='data/' \
  --exclude='deploy/Caddyfile' \
  "`$release_dir/" "`$HOME/laixue/"
if [ '$($DryRun.IsPresent)' = 'True' ]; then
  exit 0
fi
cd "`$HOME/laixue"
sudo docker compose --project-name laixue-rebuild --env-file .env.production build app
sudo docker compose --project-name laixue-rebuild --env-file .env.production up -d --no-deps --force-recreate app
printf '%s\n' '$shortRevision' > .deployed-revision
"@
  $remoteScript = $remoteScript -replace "`r`n", "`n"
  $base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
  & ssh -i $SshKeyPath "${RemoteUser}@${HostName}" "echo $base64 | base64 -d | bash"
  if ($LASTEXITCODE -ne 0) { throw 'Remote release failed.' }
} finally {
  Remove-Item -LiteralPath $archivePath -ErrorAction SilentlyContinue
}

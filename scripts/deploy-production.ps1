param(
  [string]$RepositoryPath = (Get-Location).Path,
  [string]$Revision,
  [string]$SshKeyPath,
  [string]$HostName = '81.70.224.19',
  [string]$RemoteUser = 'ubuntu',
  [string[]]$Services = @('app', 'revoice-worker', 'classroom-generation-worker', 'course-asset-cleanup-worker'),
  [switch]$SkipMigrations,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $SshKeyPath) { throw 'SshKeyPath is required.' }
if (-not (Test-Path -LiteralPath $SshKeyPath)) { throw "SSH key not found: $SshKeyPath" }
if (-not (Test-Path -LiteralPath (Join-Path $RepositoryPath '.git'))) { throw "Not a Git worktree: $RepositoryPath" }
if (-not $Revision) { $Revision = (git -C $RepositoryPath rev-parse --short HEAD).Trim() }

$allowedServices = @(
  'app',
  'revoice-worker',
  'classroom-generation-worker',
  'course-asset-cleanup-worker',
  'render-service',
  'video-export-worker'
)
$Services = @($Services | Select-Object -Unique)
if ($Services.Count -eq 0) { throw 'At least one deployable service is required.' }
foreach ($service in $Services) {
  if ($service -notin $allowedServices) { throw "Unsupported service: $service" }
}

$resolvedRevision = (git -C $RepositoryPath rev-parse --verify "$Revision^{commit}").Trim()
$shortRevision = $resolvedRevision.Substring(0, 8)
$archivePath = Join-Path $env:TEMP "laixue-$shortRevision.zip"
$remoteArchive = "/tmp/laixue-$shortRevision.zip"

Remove-Item -LiteralPath $archivePath -ErrorAction SilentlyContinue
git -C $RepositoryPath archive --format=zip --output=$archivePath $resolvedRevision

try {
  & scp -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $archivePath "${RemoteUser}@${HostName}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw 'Archive upload failed.' }

  $dryRunFlag = if ($DryRun) { '--dry-run' } else { '' }
  $remoteScript = @"
set -euo pipefail
archive='$remoteArchive'
release_dir=`$(mktemp -d /tmp/laixue-release.XXXXXX)
cleanup() { rm -rf "`$release_dir" "`$archive"; }
trap cleanup EXIT
unzip -oq "`$archive" -d "`$release_dir"

# Building multiple Next.js worker images concurrently has previously exhausted
# this host's memory and Docker storage. Keep the release serial, clean only
# recreatable cache when space is tight, and stop before replacing app files.
available_kb() { df -Pk / | awk 'NR == 2 { print `$4 }'; }
memory_available_kb() { awk '/MemAvailable:/ { print `$2 }' /proc/meminfo; }

disk_before=`$(available_kb)
memory_before=`$(memory_available_kb)
echo "Release preflight: disk=`$((disk_before / 1024 / 1024))GiB available, memory=`$((memory_before / 1024))MiB available"

if [ "`$disk_before" -lt $((12 * 1024 * 1024)) ]; then
  echo 'Low disk space: pruning only recreatable Docker build cache and dangling images.'
  sudo docker builder prune -af --filter 'until=24h'
  sudo docker image prune -f
  disk_before=`$(available_kb)
fi

if [ "`$disk_before" -lt $((8 * 1024 * 1024)) ]; then
  echo 'Insufficient disk space for a safe release (need 8GiB available after cache cleanup).' >&2
  exit 1
fi
if [ "`$memory_before" -lt $((512 * 1024)) ]; then
  echo 'Insufficient available memory for a safe release (need 512MiB available).' >&2
  exit 1
fi

# Application files may be owned by a previous root-run container build. Run
# the sync with sudo and avoid copying archive ownership so a later release
# cannot fail halfway through on an otherwise healthy host.
sudo rsync -rltD --delete $dryRunFlag \
  --exclude='.env.production' \
  --exclude='.deployed-revision' \
  --exclude='data/' \
  --exclude='deploy/Caddyfile' \
  "`$release_dir/" "`$HOME/laixue/"
if [ '$($DryRun.IsPresent)' = 'True' ]; then
  exit 0
fi
cd "`$HOME/laixue"

compose=(sudo docker compose --project-name laixue-rebuild --env-file .env.production)
for service in $($Services -join ' '); do
  echo "Building `$service serially..."
  "`${compose[@]}" build "`$service"
done

if [ '$($SkipMigrations.IsPresent)' != 'True' ]; then
  echo 'Building and applying database migrations...'
  "`${compose[@]}" build migrate
  "`${compose[@]}" --profile tools run --rm migrate
fi

echo 'Recreating selected services...'
"`${compose[@]}" up -d --no-deps --force-recreate $($Services -join ' ')
printf '%s\n' '$shortRevision' > .deployed-revision
"@
  # PowerShell writes pipeline text with CRLF. Strip it on the Linux side so
  # heredoc-derived shell lines and continuations keep their intended shape.
  $remoteScript | & ssh -T -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath "${RemoteUser}@${HostName}" 'tr -d "\r" | bash -s'
  if ($LASTEXITCODE -ne 0) { throw 'Remote release failed.' }
} finally {
  Remove-Item -LiteralPath $archivePath -ErrorAction SilentlyContinue
}

# fetch-search-tools.ps1
# Telecharge ripgrep (rg) et fd Windows x64 depuis leurs releases GitHub
# officielles et les place dans build/bin-win/. Utilise par extraResources
# (cf. package.json) pour bundler ces tools dans l'install vMux.
#
# Idempotent : si le binaire existe deja, on skip. Passe -Force pour
# re-telecharger.
#
# Dependances : gh CLI authentifie (gh auth status).

[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$outDir = Join-Path $root 'build\bin-win'
$null = New-Item -ItemType Directory -Path $outDir -Force

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Error "gh CLI introuvable. Install via 'winget install GitHub.cli'."
    exit 1
}

function Fetch-Tool {
    param(
        [Parameter(Mandatory=$true)] [string] $Repo,
        [Parameter(Mandatory=$true)] [string] $AssetPattern,
        [Parameter(Mandatory=$true)] [string] $ExeName
    )

    $targetExe = Join-Path $outDir $ExeName
    if ((Test-Path $targetExe) -and -not $Force) {
        Write-Host "[skip] $ExeName deja present (use -Force pour re-download)" -ForegroundColor Yellow
        return
    }

    Write-Host "[download] $Repo : asset matching $AssetPattern" -ForegroundColor Cyan

    $tmpDir = Join-Path $env:TEMP "vmux-fetch-$([guid]::NewGuid().ToString('N'))"
    $null = New-Item -ItemType Directory -Path $tmpDir -Force

    try {
        # gh release download fetch automatiquement la latest release
        # et matche les assets via -p glob (pas regex).
        $ghOutput = & gh release download --repo $Repo --pattern $AssetPattern --dir $tmpDir 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error "gh release download failed for $Repo : $ghOutput"
            exit 1
        }

        $archive = Get-ChildItem -Path $tmpDir -Filter '*.zip' | Select-Object -First 1
        if (-not $archive) {
            Write-Error "Aucune .zip telechargee pour $Repo"
            exit 1
        }

        Expand-Archive -Path $archive.FullName -DestinationPath $tmpDir -Force

        $exe = Get-ChildItem -Path $tmpDir -Recurse -Filter $ExeName | Select-Object -First 1
        if (-not $exe) {
            Write-Error "$ExeName introuvable dans l'archive de $Repo"
            exit 1
        }

        Copy-Item -Path $exe.FullName -Destination $targetExe -Force
        $sizeKB = [math]::Round((Get-Item $targetExe).Length / 1KB)
        Write-Host "[ok] $ExeName ($sizeKB KB) -> $targetExe" -ForegroundColor Green
    }
    finally {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ripgrep — grep moderne, ~5 MB, ecrit en Rust.
Fetch-Tool -Repo 'BurntSushi/ripgrep' -AssetPattern '*x86_64-pc-windows-msvc.zip' -ExeName 'rg.exe'

# fd — find moderne, ~3 MB, ecrit en Rust.
Fetch-Tool -Repo 'sharkdp/fd' -AssetPattern '*x86_64-pc-windows-msvc.zip' -ExeName 'fd.exe'

Write-Host ""
Write-Host "Done. Binaries in $outDir" -ForegroundColor Green

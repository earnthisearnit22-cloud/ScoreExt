# ScoreExt Startup Script (Portable and Auto-Installing)

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "Starting ScoreExt Tool..." -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

# Define local directories
$nodeDir = Join-Path $PSScriptRoot "node-portable"
$nodeExe = Join-Path $nodeDir "node.exe"
$npmCmd = Join-Path $nodeDir "npm.cmd"

# 1. Check/Install Node.js
Write-Host "[1/4] Checking Node.js environment..."
$globalNode = Get-Command node -ErrorAction SilentlyContinue
if ($globalNode) {
    $nodePath = "node"
    $npmPath = "npm.cmd"
    Write-Host "Using system Node.js: $((node -v))" -ForegroundColor Green
} elseif (Test-Path $nodeExe) {
    $nodePath = $nodeExe
    $npmPath = $npmCmd
    Write-Host "Using portable Node.js: $(& $nodeExe -v)" -ForegroundColor Green
} else {
    Write-Host "Node.js is not detected on this system." -ForegroundColor Yellow
    Write-Host "Downloading portable Node.js (approx. 30MB) to make it work offline/portable..." -ForegroundColor Yellow
    
    # Create portable folder
    New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
    
    # Download Node.js Windows x64 zip (LTS version)
    $zipUrl = "https://nodejs.org/dist/v20.11.1/node-v20.11.1-win-x64.zip"
    $zipPath = Join-Path $nodeDir "node.zip"
    
    Write-Host "Downloading $zipUrl..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
    
    Write-Host "Extracting portable Node.js..."
    Expand-Archive -Path $zipPath -DestinationPath $nodeDir -Force
    
    # Move files up from the extracted subfolder
    $subDir = Get-ChildItem -Path $nodeDir -Directory | Select-Object -First 1
    if ($subDir) {
        Move-Item -Path "$($subDir.FullName)\*" -Destination $nodeDir -Force
        Remove-Item -Path $subDir.FullName -Recurse -Force
    }
    
    Remove-Item -Path $zipPath -Force
    
    $nodePath = $nodeExe
    $npmPath = $npmCmd
    Write-Host "Portable Node.js set up successfully!" -ForegroundColor Green
}

# Add local node to environment path temporarily if we are in portable mode
if (-not $globalNode) {
    $env:Path = "$nodeDir;" + $env:Path
}

# 2. Cleanup existing node processes to free port 8000
Write-Host "[2/4] Cleaning up existing node processes..."
# Stop node processes (be gentle)
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 3. Check/Install Dependencies & Build Frontend
Write-Host "[3/4] Checking dependencies..."

$backendDir = Join-Path $PSScriptRoot "backend"
$frontendDir = Join-Path $PSScriptRoot "frontend"

if (-not (Test-Path (Join-Path $backendDir "node_modules"))) {
    Write-Host "Installing backend dependencies (this may take a minute)..." -ForegroundColor Yellow
    Start-Process -FilePath $npmPath -ArgumentList "install" -WorkingDirectory $backendDir -NoNewWindow -Wait
}

if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
    Write-Host "Installing frontend dependencies (this may take a minute)..." -ForegroundColor Yellow
    Start-Process -FilePath $npmPath -ArgumentList "install" -WorkingDirectory $frontendDir -NoNewWindow -Wait
}

# Build frontend if dist folder is missing
$distPath = Join-Path $frontendDir "dist"
if (-not (Test-Path $distPath)) {
    Write-Host "Building frontend assets..." -ForegroundColor Yellow
    Start-Process -FilePath $npmPath -ArgumentList "run", "build" -WorkingDirectory $frontendDir -NoNewWindow -Wait
}

# 4. Start Server (Single process! Backend serves the frontend now)
Write-Host "[4/4] Starting Server..."
# Launch backend node process hiddenly
Start-Process -FilePath $nodePath -ArgumentList "index.js" -WorkingDirectory $backendDir -WindowStyle Hidden

# Wait for port 8000 to be ready
Write-Host "Waiting for server to be ready on port 8000..."
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", 8000)
        if ($tcp.Connected) {
            $ready = $true
            $tcp.Close()
            break
        }
    } catch {
        # Not ready yet
    }
    Write-Host "." -NoNewline
    Start-Sleep -Seconds 1
}

if ($ready) {
    Write-Host "`nSuccessfully started!" -ForegroundColor Green
    Write-Host "Opening: http://127.0.0.1:8000/" -ForegroundColor Green
    Start-Process "http://127.0.0.1:8000/"
} else {
    Write-Host "`n[ERROR] Server failed to start or is taking too long." -ForegroundColor Red
}

Write-Host "`nPress any key to exit..."
$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

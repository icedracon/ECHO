#!/usr/bin/env bash
# ==============================================================================
# ECHO — 1-Click Auto-Installer & Launcher for Linux
# Supports: Ubuntu, Debian, Kali Linux, Fedora, Arch Linux
# ==============================================================================

set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "=========================================="
echo "         ECHO — Desktop Companion         "
echo "=========================================="

# 1. Check and install system dependencies if building from source
echo "[*] Checking system dependencies for Linux..."

install_ubuntu_debian() {
    echo "[*] Installing dependencies for Ubuntu/Debian/Kali via apt..."
    sudo apt update
    sudo apt install -y build-essential curl wget file libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
}

install_fedora() {
    echo "[*] Installing dependencies for Fedora via dnf..."
    sudo dnf check-update || true
    sudo dnf install -y gcc gcc-c++ make curl wget webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel
}

install_arch() {
    echo "[*] Installing dependencies for Arch via pacman..."
    sudo pacman -Sy --needed --noconfirm base-devel curl wget webkit2gtk-4.1 openssl libappindicator-gtk3 librsvg
}

# Auto-detect Package Manager and prompt if WebKitGTK isn't detected
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    echo "[!] WebKitGTK / Tauri build tools missing."
    if command -v apt &>/dev/null; then
        install_ubuntu_debian
    elif command -v dnf &>/dev/null; then
        install_fedora
    elif command -v pacman &>/dev/null; then
        install_arch
    else
        echo "[!] Unsupported package manager. Please install WebKitGTK 4.1 development files manually."
    fi
fi

# Check Node.js
if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
    echo "[!] Node.js / npm not found. Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - || true
    if command -v apt &>/dev/null; then sudo apt install -y nodejs; fi
    if command -v dnf &>/dev/null; then sudo dnf install -y nodejs npm; fi
fi

# Check Rust
if ! command -v cargo &>/dev/null; then
    echo "[!] Rust compiler (cargo) not found. Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi

# Seed the user media folder: any real-named gif in public/media becomes the
# poster (plain rename-copy, no conversion); poster.gif is the fallback.
mkdir -p "$HOME/.echo/media"
for f in public/media/*.gif; do
    [ -e "$f" ] || continue
    if [ "$(basename "$f")" != "poster.gif" ]; then
        cp -f "$f" "$HOME/.echo/media/poster.gif"
    fi
done
if [ ! -f "$HOME/.echo/media/poster.gif" ] && [ -f "public/media/poster.gif" ]; then
    cp "public/media/poster.gif" "$HOME/.echo/media/poster.gif"
fi
if [ ! -f "$HOME/.echo/media/song.mp3" ] && [ -f "public/media/song.mp3" ]; then
    cp "public/media/song.mp3" "$HOME/.echo/media/song.mp3"
fi

# Check node_modules
if [ ! -d "node_modules" ]; then
    echo "[*] Installing node dependencies..."
    npm install
fi

echo "[+] Starting ECHO in dev mode..."
npm run tauri dev &

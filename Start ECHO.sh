#!/usr/bin/env bash
# ECHO Linux Launcher (Ubuntu, Debian, Kali, Fedora, Arch)
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

# 1. Standalone / release binary
if [ -f "./ECHO" ]; then
    ./ECHO &
    exit 0
fi

if [ -f "./src-tauri/target/release/ECHO" ]; then
    ./src-tauri/target/release/ECHO &
    exit 0
fi

# 2. Dev mode fallback
echo "Starting ECHO in dev mode..."
npm run tauri dev &

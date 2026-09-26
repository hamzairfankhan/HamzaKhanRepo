#!/usr/bin/env bash
# One-shot Mac developer setup for the graph8 hackathon.
# Run:  bash scripts/mac_setup.sh
# Safe to re-run; every step is idempotent.
set -euo pipefail

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

# 1. Xcode command line tools (git, compilers)
if ! xcode-select -p >/dev/null 2>&1; then
  say "Installing Xcode Command Line Tools (a dialog will pop up, click Install, then re-run this script)"
  xcode-select --install || true
  exit 0
fi

# 2. Homebrew
if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
# Put brew on PATH for Apple Silicon and Intel
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
grep -q 'brew shellenv' ~/.zprofile 2>/dev/null || echo 'eval "$('"$(command -v brew)"' shellenv)"' >> ~/.zprofile

# 3. Core CLI tools
say "Installing git, gh (GitHub CLI), node 20+, jq, ripgrep"
brew install git gh node jq ripgrep 2>&1 | grep -v 'already installed' || true

# 4. Claude Code CLI
if ! command -v claude >/dev/null 2>&1; then
  say "Installing Claude Code CLI"
  npm install -g @anthropic-ai/claude-code
fi

# 5. GitHub CLI login (interactive, browser-based)
if ! gh auth status >/dev/null 2>&1; then
  say "Logging into GitHub (a browser window will open)"
  gh auth login --web --git-protocol https
fi
gh auth setup-git

# 6. Git identity
if [ -z "$(git config --global user.name || true)" ]; then
  read -rp "Git display name: " GNAME; git config --global user.name "$GNAME"
fi
if [ -z "$(git config --global user.email || true)" ]; then
  read -rp "Git email (same as GitHub): " GEMAIL; git config --global user.email "$GEMAIL"
fi
git config --global init.defaultBranch main
git config --global pull.rebase false

# 7. Clone the repo if we are not already inside it
if [ ! -d .git ]; then
  say "Cloning hamzairfankhan/HamzaKhanRepo"
  gh repo clone hamzairfankhan/HamzaKhanRepo
  cd HamzaKhanRepo
fi

# 8. Project dependencies
say "Installing project dependencies"
npm install
[ -f .env ] || cp .env.example .env

say "Done. Next steps:"
cat <<'MSG'
  1. Open a new Terminal tab so PATH changes apply.
  2. Run:  claude          (Claude Code in this folder; log in when prompted)
  3. Inside Claude Code run:  /mcp   to confirm the graph8 MCP server is connected.
  4. Put your keys in .env (G8_API_KEY from app.graph8.com → Settings → MCP & API → API, ANTHROPIC_API_KEY)
  5. Run:  npm run autopilot -- --help      and      npm run dashboard
MSG

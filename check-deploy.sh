#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
#  check-deploy.sh — diagnose the Railway "xconst" deploy issue
#  Run this from C:\Users\Yousef\Downloads\easytrac.io-main\easytrac.io-main
#  in Git Bash / WSL / PowerShell-with-bash.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

echo "═══ 1. LOCAL FILE INTEGRITY ═══"
echo ""
echo "First 32 bytes of server.js (hex):"
head -c 32 server.js | xxd
echo ""
echo -n "First word: "
head -c 5 server.js
echo ""
echo ""

if head -c 5 server.js | grep -q "^const"; then
  echo "  ✓ Local server.js starts with 'const' — file is clean"
else
  echo "  ✗ Local server.js does NOT start with 'const' — file is CORRUPTED"
  echo "    (this is the file Railway is deploying)"
fi
echo ""

echo "Local sha256:"
sha256sum server.js 2>/dev/null || shasum -a 256 server.js
echo ""

echo "Local node syntax check:"
node --check server.js && echo "  ✓ syntax OK" || echo "  ✗ SYNTAX ERROR — file is broken locally"
echo ""

echo "═══ 2. GIT STATE ═══"
echo ""
echo "Current branch + last 5 commits:"
git branch --show-current
git log --oneline -5
echo ""

echo "Uncommitted changes (if any):"
git status --short
echo ""

echo "Remote URL:"
git remote -v
echo ""

echo "═══ 3. WHAT'S ACTUALLY IN THE LATEST GIT COMMIT ═══"
echo ""
echo "First 5 lines of server.js as stored in HEAD commit:"
git show HEAD:server.js 2>/dev/null | head -5 || echo "  (cannot read HEAD:server.js)"
echo ""

echo "First word in HEAD's server.js:"
git show HEAD:server.js 2>/dev/null | head -c 5
echo ""
echo ""

if git show HEAD:server.js 2>/dev/null | head -c 5 | grep -q "^const"; then
  echo "  ✓ HEAD commit's server.js is clean"
  echo "    → Run: git push origin \$(git branch --show-current)"
  echo "    → Then redeploy on Railway dashboard"
else
  echo "  ✗ HEAD commit's server.js is CORRUPTED with 'xconst' typo"
  echo "    → Run these commands to fix:"
  echo ""
  echo "      git rm --cached server.js"
  echo "      git add server.js"
  echo "      git commit -m \"fix: clean server.js\""
  echo "      git push origin \$(git branch --show-current) --force-with-lease"
fi
echo ""

echo "═══ 4. WHAT'S ON THE REMOTE BRANCH ═══"
echo ""
git fetch origin 2>/dev/null
remote_branch="origin/$(git branch --show-current)"
echo "First 5 lines of server.js as stored on $remote_branch:"
git show $remote_branch:server.js 2>/dev/null | head -5 || echo "  (cannot read $remote_branch:server.js)"
echo ""

echo "═══ DONE — copy the output above and send it back to the chat ═══"

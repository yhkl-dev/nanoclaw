#!/bin/bash
# Watch NanoClaw IPC for Ollama activity and show macOS notifications

cd "$(dirname "$0")/.." || exit 1

echo "Watching for Ollama activity..."
echo "Press Ctrl+C to stop"
echo ""

LAST_TIMESTAMP=""
declare -A LAST_TIMESTAMPS

while true; do
  for status_file in data/ipc/*/ollama_status.json; do
    [ -f "$status_file" ] || continue

    TIMESTAMP=$(python3 -c "import json; print(json.load(open('$status_file'))['timestamp'])" 2>/dev/null)
    [ -z "$TIMESTAMP" ] && continue
    [ "$TIMESTAMP" = "${LAST_TIMESTAMPS[$status_file]}" ] && continue
    LAST_TIMESTAMPS["$status_file"]="$TIMESTAMP"
    LAST_TIMESTAMP="$TIMESTAMP"
    STATUS=$(python3 -c "import json; d=json.load(open('$status_file')); print(d['status'])" 2>/dev/null)
    DETAIL=$(python3 -c "import json; d=json.load(open('$status_file')); print(d.get('detail',''))" 2>/dev/null)

    case "$STATUS" in
      generating)
        osascript <<'APPLESCRIPT' "$DETAIL" 2>/dev/null
on run argv
  display notification (item 1 of argv) with title "NanoClaw → Ollama" sound name "Submarine"
end run
APPLESCRIPT
        echo "$(date +%H:%M:%S) 🔄 $DETAIL"
        ;;
      done)
        osascript <<'APPLESCRIPT' "$DETAIL" 2>/dev/null
on run argv
  display notification (item 1 of argv) with title "NanoClaw ← Ollama ✓" sound name "Glass"
end run
APPLESCRIPT
        echo "$(date +%H:%M:%S) ✅ $DETAIL"
        ;;
      listing)
        echo "$(date +%H:%M:%S) 📋 Listing models..."
        ;;
    esac
  done
  sleep 0.5
done

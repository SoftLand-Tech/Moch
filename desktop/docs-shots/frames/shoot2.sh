#!/usr/bin/env bash
OUT=$1
for i in $(seq -w 1 18); do
  if [ "$i" = "04" ]; then
    WS=$(hyprctl -j clients | python3 -c "import json,sys;print(next((c['workspace']['id'] for c in json.load(sys.stdin) if c.get('class')=='Moch-desktop'),3))" 2>/dev/null)
    hyprctl dispatch "hl.dsp.focus({ workspace = $WS })" >/dev/null 2>&1
  fi
  grim -g "12,12 1512x840" "$OUT/frame-$i.png" 2>/dev/null
  sleep 1.2
done

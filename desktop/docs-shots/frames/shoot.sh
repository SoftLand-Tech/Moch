#!/usr/bin/env bash
for i in $(seq -w 1 24); do
  grim -g "12,12 1512x840" "$1/frame-$i.png" 2>/dev/null
  sleep 1.5
done

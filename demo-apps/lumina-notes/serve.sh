#!/bin/sh
cd "$(dirname "$0")" && exec python3 -m http.server 8321 --bind 127.0.0.1

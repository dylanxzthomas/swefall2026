#!/usr/bin/env bash
# Starts the demo profile (port 4748) from anywhere.
cd "$(dirname "$0")/.." && exec npm run demo:start

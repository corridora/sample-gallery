#!/usr/bin/env python3
"""Replay a real browser incident if today's completed heartbeat is missing."""
import datetime,json,os,subprocess,urllib.request
base=os.environ['SAMPLE_BASE_URL'].rstrip('/')
with urllib.request.urlopen(base+'/api/demo/heartbeat',timeout=10) as response:heartbeat=json.load(response)
today=datetime.datetime.now(datetime.timezone.utc).date().isoformat()
if heartbeat.get('day')==today:print('Today already has a completed browser incident.')
else:subprocess.run(['npx','tsx','scripts/journey.ts'],check=True,timeout=180)

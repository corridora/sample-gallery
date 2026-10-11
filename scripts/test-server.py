#!/usr/bin/env python3
import os,subprocess,shutil
from pathlib import Path
root=Path(__file__).resolve().parent.parent
shutil.rmtree(root/'.sample/test/.wrangler',ignore_errors=True)
env=os.environ.copy();env.update(SAMPLE_STATE_DIR=str(root/'.sample/test'),SAMPLE_MODE='local',PORT='4101',CORRIDORA_TARGET='own',CORRIDORA_OTLP_ENDPOINT='http://127.0.0.1:4411',CORRIDORA_INGEST_KEY='test-backend-key',CORRIDORA_RUM_KEY='test-browser-key' if env.get('RUM_BUNDLE_PATH') else '',CORRIDORA_RUM_SCRIPT_URL='http://127.0.0.1:4411/corridora-rum.js',DEMO_CONTROL_TOKEN='local-test-control-token-32-chars',DEMO_DAILY_START_UTC='23:50',RECOMMENDER_URL='',TRACKER_SIMULATOR_URL='',ENABLE_PROVIDER_FORWARDING='false',ENABLE_SYNTHETICS='false')
for command in [['./setup','configure','--non-interactive'],['./setup','deploy','--yes']]:subprocess.run(command,cwd=root,env=env,check=True)
subprocess.run(['./setup','run'],cwd=root,env=env,check=True)

import contextlib,importlib.machinery,io,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parent.parent
setup=importlib.machinery.SourceFileLoader('sample_setup',str(ROOT/'setup')).load_module()
metrics=importlib.machinery.SourceFileLoader('provider_metrics',str(ROOT/'scripts/provider_metrics.py')).load_module()
class SetupTests(unittest.TestCase):
    def test_help_no_dependencies(self):
        import subprocess
        self.assertEqual(subprocess.run([str(ROOT/'setup'),'--help'],capture_output=True).returncode,0)
    def test_plan_redacts_secrets(self):
        cfg={**setup.DEFAULTS,'CORRIDORA_INGEST_KEY':'must-never-print','CLOUDFLARE_API_TOKEN':'must-never-print'}
        output=io.StringIO()
        with contextlib.redirect_stdout(output):setup.plan(cfg)
        self.assertNotIn('must-never-print',output.getvalue());self.assertIn('D1',output.getvalue())
    def test_private_files_and_noninteractive_control_generation(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(setup,'STATE',Path(directory)):
            cfg=setup.configure(setup.DEFAULTS.copy(),True)
            self.assertGreaterEqual(len(cfg['DEMO_CONTROL_TOKEN']),16)
            self.assertEqual((Path(directory)/'secrets.json').stat().st_mode&0o777,0o600)
            self.assertNotIn('DEMO_CONTROL_TOKEN',json.loads((Path(directory)/'config.json').read_text()))
    def test_cloud_requires_explicit_credentials_and_secure_urls(self):
        cfg={**setup.DEFAULTS,'SAMPLE_MODE':'cloud'}
        with self.assertRaises(ValueError):setup.validate(cfg,cloud=True)
        with self.assertRaises(ValueError):setup.validate({**setup.DEFAULTS,'RECOMMENDER_URL':'http://remote.example'})
        with self.assertRaises(ValueError):setup.validate({**setup.DEFAULTS,'CORRIDORA_TARGET':'demo'})
    def test_provider_metric_conversion_has_delta_interval(self):
        body=metrics.convert({'data':{'viewer':{'accounts':[{'workersInvocationsAdaptive':[{'sum':{'requests':3,'errors':1,'subrequests':2}}]}]}}},'account','worker',100,200)
        metric=body['resourceMetrics'][0]['scopeMetrics'][0]['metrics'][0]
        self.assertEqual(metric['sum']['aggregationTemporality'],1);self.assertEqual(metric['sum']['dataPoints'][0]['asInt'],'3');self.assertEqual(metric['sum']['dataPoints'][0]['startTimeUnixNano'],'100')
    def test_provider_error_does_not_become_zero(self):
        with self.assertRaises(ValueError):metrics.convert({'errors':['denied']},'a','b',1,2)
    def test_provision_resumes_and_records_reuse_without_ownership(self):
        cfg={**setup.DEFAULTS,'CLOUDFLARE_ACCOUNT_ID':'account','CLOUDFLARE_API_TOKEN':'not-real'};inv={'account_id':'account','resources':{'d1':{'id':'existing','owned':False},'r2':{'id':'existing-r2','owned':False},'kv':{'id':'existing-kv','owned':False},'dead':{'id':'existing-dead','owned':False},'queue':{'id':'existing-queue','owned':False},'worker':{'id':'existing-worker','owned':False}}}
        with patch.object(setup,'api') as api,patch.object(setup,'save_inventory'):
            setup.provision(cfg,inv);api.assert_not_called()
        self.assertFalse(inv['resources']['d1']['owned'])
    def test_teardown_does_not_require_revoked_telemetry_keys(self):
        setup.validate({**setup.DEFAULTS,'SAMPLE_MODE':'cloud','CORRIDORA_TARGET':'demo','CLOUDFLARE_ACCOUNT_ID':'account','CLOUDFLARE_API_TOKEN':'mock'},cloud=True,teardown=True)
    def test_control_plane_uses_deployment_bearer(self):
        import io
        response=io.BytesIO(b'{"success":true,"result":[]}')
        with patch.object(setup.urllib.request,'urlopen',return_value=response) as urlopen:
            setup.api({'CLOUDFLARE_API_TOKEN':'mock-deploy-token'},'GET','/accounts/mock/d1/database')
        self.assertEqual(urlopen.call_args.args[0].headers['Authorization'],'Bearer mock-deploy-token')
    def test_partial_provision_keeps_created_inventory(self):
        cfg={**setup.DEFAULTS,'CLOUDFLARE_ACCOUNT_ID':'account','CLOUDFLARE_API_TOKEN':'not-real'};inv={'account_id':'','resources':{}};saved=[]
        def api(config,method,path,data=None):
            if path.endswith('/d1/database'):
                return [] if method=='GET' else {'uuid':'new-db-id','name':'sample-gallery-catalog'}
            raise RuntimeError('injected provider failure')
        with patch.object(setup,'api',side_effect=api),patch.object(setup,'save_inventory',side_effect=lambda value:saved.append(json.loads(json.dumps(value)))):
            with self.assertRaises(RuntimeError):setup.provision(cfg,inv)
        self.assertEqual(saved[-1]['resources']['d1']['id'],'new-db-id');self.assertTrue(saved[-1]['resources']['d1']['owned'])
    def test_prefix_change_cannot_orphan_owned_resources(self):
        cfg={**setup.DEFAULTS,'CLOUDFLARE_ACCOUNT_ID':'account'};inv={'account_id':'account','resource_prefix':'another-prefix','resources':{}}
        with self.assertRaises(ValueError):setup.provision(cfg,inv)
    def test_teardown_preserves_reused_resources(self):
        from types import SimpleNamespace
        cfg={**setup.DEFAULTS,'SAMPLE_MODE':'cloud','CLOUDFLARE_ACCOUNT_ID':'account','CLOUDFLARE_API_TOKEN':'mock','CORRIDORA_OTLP_ENDPOINT':'https://ingest.example','CORRIDORA_INGEST_KEY':'mock-backend','CORRIDORA_RUM_KEY':'mock-browser'}
        inv={'account_id':'account','resources':{'d1':{'id':'owned-db','path':'/d1/database/owned-db','owned':True},'kv':{'id':'shared-kv','path':'/storage/kv/namespaces/shared-kv','owned':False}}}
        with patch.object(setup,'inventory',return_value=inv),patch.object(setup,'api') as api,patch.object(setup,'save_inventory'):
            with contextlib.redirect_stdout(io.StringIO()):setup.destroy(cfg,SimpleNamespace(plan=False,yes=True))
        self.assertEqual(api.call_count,1);self.assertEqual(api.call_args.args[2],'/accounts/account/d1/database/owned-db');self.assertIn('kv',inv['resources'])
if __name__=='__main__':unittest.main()

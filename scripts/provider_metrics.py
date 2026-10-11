#!/usr/bin/env python3
"""Convert a bounded Cloudflare GraphQL Analytics query into OTLP JSON metrics."""
import datetime,json,os,sys,time,urllib.request
QUERY='''query($accountTag:string,$start:string,$end:string,$script:string){viewer{accounts(filter:{accountTag:$accountTag}){workersInvocationsAdaptive(limit:1,filter:{scriptName:$script,datetime_geq:$start,datetime_leq:$end}){sum{requests errors subrequests}}}}}'''

def convert(data,account,script,start_ns,end_ns):
    if data.get('errors'):raise ValueError('Cloudflare analytics query returned errors')
    accounts=data['data']['viewer']['accounts'];rows=accounts[0]['workersInvocationsAdaptive'] if accounts else []
    if not rows:return None
    totals=rows[0]['sum'];metrics=[]
    for key in ['requests','errors','subrequests']:
        metrics.append({'name':'cloudflare.workers.'+key,'unit':'{'+key+'}','sum':{'aggregationTemporality':1,'isMonotonic':True,'dataPoints':[{'startTimeUnixNano':str(start_ns),'timeUnixNano':str(end_ns),'asInt':str(int(totals[key]))}]}})
    return {'resourceMetrics':[{'resource':{'attributes':[{'key':'service.name','value':{'stringValue':'sample-gallery-cloudflare-adapter'}},{'key':'cloud.provider','value':{'stringValue':'cloudflare'}},{'key':'cloud.account.id','value':{'stringValue':account}},{'key':'cloud.resource_id','value':{'stringValue':'workers/'+script}}]},'scopeMetrics':[{'scope':{'name':'cloudflare-graphql-adapter','version':'1.0.0'},'metrics':metrics}]}]}

def post(url,data,headers):
    request=urllib.request.Request(url,data=json.dumps(data).encode(),headers={'Content-Type':'application/json',**headers})
    with urllib.request.urlopen(request,timeout=15) as response:return json.load(response)

def main():
    required=['CLOUDFLARE_ANALYTICS_TOKEN','CLOUDFLARE_ACCOUNT_ID','RESOURCE_PREFIX','CORRIDORA_OTLP_ENDPOINT','CORRIDORA_INGEST_KEY']
    for key in required:
        if not os.environ.get(key):raise ValueError(key+' is required')
    end=datetime.datetime.now(datetime.timezone.utc).replace(second=0,microsecond=0);start=end-datetime.timedelta(minutes=15)
    # Align scheduled polls to closed 15-minute buckets; repeated manual polls can duplicate an interval.
    end=end.replace(minute=(end.minute//15)*15);start=end-datetime.timedelta(minutes=15)
    account=os.environ['CLOUDFLARE_ACCOUNT_ID'];script=os.environ['RESOURCE_PREFIX']
    data=post('https://api.cloudflare.com/client/v4/graphql',{'query':QUERY,'variables':{'accountTag':account,'start':start.isoformat(),'end':end.isoformat(),'script':script}},{'Authorization':'Bearer '+os.environ['CLOUDFLARE_ANALYTICS_TOKEN']})
    body=convert(data,account,script,int(start.timestamp()*1e9),int(end.timestamp()*1e9))
    if body is None:print('No provider data in closed bucket; nothing exported.');return
    post(os.environ['CORRIDORA_OTLP_ENDPOINT'].rstrip('/')+'/v1/metrics',body,{'X-CORRIDORA-KEY':os.environ['CORRIDORA_INGEST_KEY']});print('Native metrics accepted; verify storage in Corridora.')
if __name__=='__main__':
    try:main()
    except Exception as error:print(type(error).__name__+': native metrics export failed (details redacted)',file=sys.stderr);sys.exit(1)

import os, time, requests
API=os.getenv('FRAMEWORK_API','http://localhost:4000')
AGENT_ID=os.getenv('AGENT_ID','local-python-worker')

def post(path,data):
 r=requests.post(API+path,json=data,timeout=15); r.raise_for_status(); return r.json()

def main():
 post('/api/agents/register',{'id':AGENT_ID,'name':'Local Python Worker','runtime':'local','capabilities':['python','testing','research'],'maxConcurrentTasks':1})
 print('Registered',AGENT_ID,'at',API)
 while True:
  try: post('/api/agents/'+AGENT_ID+'/heartbeat',{'status':'available'}); time.sleep(15)
  except Exception as e: print('Heartbeat failed:',e); time.sleep(5)
if __name__=='__main__': main()

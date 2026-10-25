import concurrent.futures
from datetime import datetime, timezone
from email.utils import format_datetime
import io
import json
from pathlib import Path
import shutil
import socket
import sys
import threading
import time
import unittest
from unittest.mock import patch
from urllib import error, request

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import server as s
from dna_store import DnaStore, LibraryError


class StorageNetworkTests(unittest.TestCase):
    def setUp(self):
        self.root=ROOT/'runtime'/('test-feature-'+s.uuid.uuid4().hex)
        (self.root/'data').mkdir(parents=True)
        self.config=s.Config(self.root)

    def tearDown(self):
        assert self.root.resolve().is_relative_to((ROOT/'runtime').resolve())
        shutil.rmtree(self.root)

    @staticmethod
    def dna(i):
        return {'id':'author-'+str(i),'name':'参考博主'+str(i),'text':'# 表达 DNA\n先交代事实，再表达感受。',
                'raw':[{'title':f'原稿{n}','content':f'博主{i}第{n}篇不同原稿。','platform':'抖音','sourceUrl':f'https://v.douyin.com/Author{i}Clip{n}/'} for n in range(10)],
                'results':{'dna':'分析正文'},'expressionProfile':{'version':2,'rules':[{'text':'短句'}]}}

    def test_five_authors_ten_sources_survive_restart(self):
        store=DnaStore(self.config)
        self.assertFalse(store.load()['configured'])
        with self.assertRaises(LibraryError):store.save(self.dna(0))
        directory=self.root/'中文资料库'
        store.configure(str(directory))
        for i in range(5):store.save(self.dna(i))
        # 重建配置和文件库对象，完全不用浏览器缓存。
        second=DnaStore(s.Config(self.root)).load()
        self.assertEqual(len(second['entries']),5)
        self.assertTrue(all(len(d['raw'])==10 for d in second['entries']))
        self.assertEqual(len({d['id'] for d in second['entries']}),5)
        for entry in second['entries']:
            folder=Path(second['locations'][entry['id']])
            self.assertTrue(folder.name.startswith(entry['name']))
            self.assertEqual((folder/'Writing-DNA.md').read_text(encoding='utf-8'),entry['text'])
            self.assertEqual(len(json.loads((folder/'原稿.json').read_text(encoding='utf-8'))),10)
        self.config.save({'remember':False})
        self.assertEqual(DnaStore(s.Config(self.root)).load()['directory'],str(directory))

    def test_invalid_or_corrupt_library_preserves_files(self):
        store=DnaStore(self.config)
        with self.assertRaises(LibraryError):store.configure('relative/path')
        store.configure(str(self.root/'库'))
        saved=store.save(self.dna(1));file=Path(saved['directory'])/'dna.json'
        file.write_text('{broken-json',encoding='utf-8')
        self.assertTrue(store.load()['warnings'])
        with self.assertRaises(LibraryError):store.save(self.dna(1))
        self.assertEqual(file.read_text(encoding='utf-8'),'{broken-json')

    def test_library_strips_credentials_and_keeps_source_metadata(self):
        store=DnaStore(self.config);store.configure(str(self.root/'库'))
        dna=self.dna(1);dna['apiKey']='do-not-persist';dna['raw'][0]['token']='do-not-persist'
        saved=store.save(dna)
        text=(Path(saved['directory'])/'dna.json').read_text(encoding='utf-8')
        self.assertNotIn('do-not-persist',text)
        self.assertEqual(store.load()['entries'][0]['raw'][0]['platform'],'抖音')

    def test_fake_ip_cdn_compatibility_still_blocks_private_hosts(self):
        def dns(address):return [(socket.AF_INET,socket.SOCK_STREAM,6,'',(address,443))]
        with patch.object(s.socket,'getaddrinfo',return_value=dns('198.18.0.242')):
            self.assertTrue(s.remote_url('https://v5-se-gddgtc-default.365yg.com/video.mp4'))
            for url in ['https://127.0.0.1/a','http://198.18.0.1/a','https://localhost/a','https://365yg.com.evil.example/a']:
                with self.assertRaises(s.UserError):s.remote_url(url)
        with patch.object(s.socket,'getaddrinfo',return_value=dns('192.168.1.1')):
            with self.assertRaises(s.UserError):s.remote_url('https://v5.365yg.com/a')
            with self.assertRaises(s.UserError):s.SafeRedirect().redirect_request(request.Request('https://v5.365yg.com'),None,302,'',{},'http://127.0.0.1/secret')

    def test_dns_failure_is_reported_as_dns_failure(self):
        with patch.object(s.socket,'getaddrinfo',side_effect=socket.gaierror()):
            with self.assertRaises(s.UserError) as ctx:s.remote_url('https://v5.365yg.com/a')
            self.assertIn('DNS',str(ctx.exception))

    def test_http_429_respects_retry_after_and_redacts_body(self):
        exception=error.HTTPError('https://example.com',429,'limit',{'Retry-After':'37'},io.BytesIO(b'{"message":"rate limit secret-value"}'))
        with patch.object(s.request,'urlopen',side_effect=exception):
            with self.assertRaises(s.RateLimited) as ctx:s.provider_json('https://example.com',b'','key','test')
            self.assertEqual(ctx.exception.retry_after,37)
            self.assertNotIn('secret-value',str(ctx.exception))
        future=format_datetime(datetime.fromtimestamp(time.time()+90,tz=timezone.utc),usegmt=True)
        self.assertGreater(s.retry_after_seconds(future),88)
        daily=error.HTTPError('https://example.com',429,'limit',{},io.BytesIO(b'{"message":"requests per day exceeded"}'))
        with patch.object(s.request,'urlopen',side_effect=daily):
            with self.assertRaises(s.UserError) as ctx:s.provider_json('https://example.com',b'','key','test')
            self.assertNotIsInstance(ctx.exception,s.RateLimited)

    def test_gate_automatic_backoff_and_no_retry_for_other_errors(self):
        now=[100.0];calls=[];waiting=[]
        def operation():
            calls.append(now[0])
            if len(calls)==1:raise s.RateLimited('语音识别',37)
            return '原文'
        def advance(seconds):now[0]+=seconds
        with patch.object(s.time,'monotonic',side_effect=lambda:now[0]),patch.object(s.time,'sleep',side_effect=advance):
            gate=s.ProviderGate()
            self.assertEqual(gate.run(operation,6,1000,lambda:False,lambda *args:waiting.append(args),lambda:None),'原文')
        self.assertEqual(len(calls),2);self.assertGreaterEqual(calls[1]-calls[0],37)
        self.assertTrue(any(limited for _,limited,_ in waiting))
        operation_calls=[]
        def invalid():operation_calls.append(1);raise s.UserError('无效密钥')
        with self.assertRaises(s.UserError):s.ProviderGate().run(invalid,0,time.monotonic()+10,lambda:False,lambda *x:None,lambda:None)
        self.assertEqual(len(operation_calls),1)

    def test_gate_serializes_two_workers(self):
        gate=s.ProviderGate();active=[0];highest=[0];starts=[]
        def operation():
            active[0]+=1;highest[0]=max(highest[0],active[0]);starts.append(time.monotonic());time.sleep(.02);active[0]-=1
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures=[pool.submit(gate.run,operation,.05,time.monotonic()+5,lambda:False,lambda *x:None,lambda:None) for _ in range(2)]
            for f in futures:f.result()
        self.assertEqual(highest[0],1);self.assertGreaterEqual(starts[1]-starts[0],.045)

    def test_http_library_restored_with_new_server(self):
        first=s.make_server(self.root,0)
        thread=threading.Thread(target=first.serve_forever,daemon=True);thread.start()
        base='http://127.0.0.1:'+str(first.server_port)
        def put(path,body):
            req=request.Request(base+path,data=json.dumps(body).encode(),method='PUT',headers={'Content-Type':'application/json','X-Spoken-DNA':'local'})
            with request.urlopen(req) as res:return json.load(res)
        try:
            put('/api/library/config',{'directory':str(self.root/'本地DNA')})
            for i in range(5):put('/api/library',{'dna':self.dna(i)})
        finally:first.shutdown();first.server_close();first.jobs.pool.shutdown();thread.join()
        second=s.make_server(self.root,0)
        try:self.assertEqual(len(second.library.load()['entries']),5)
        finally:second.server_close();second.jobs.pool.shutdown()

    def test_batch_fifty_links_independently_queued(self):
        self.config.save({'asrKey':'batch-test-a','parserToken':'batch-test-p','remember':False})
        self.config.settings.update(asrInterval=0,parserInterval=0)
        (self.root/'runtime/temp').mkdir(parents=True,exist_ok=True)
        jobs=s.Jobs(self.root,self.config)
        links=[f'https://v.douyin.com/Batch{i}/' if i%2==0 else f'https://xhslink.com/a/Batch{i}/' for i in range(50)]
        def download(url,dest):dest.write_bytes(b'media')
        def audio(media,folder):
            part=folder/'test.wav';part.write_bytes(b'audio');return [part]
        try:
            with patch.object(s,'provider_json',return_value={'code':200,'data':{'title':'批量样例','url':'https://cdn.example/a.mp4'}}),patch.object(s,'download_media',download),patch.object(s,'extract_audio',audio),patch.object(s,'transcribe',return_value='批量模拟原文'):
                result=jobs.submit('\n'.join(links));self.assertEqual(result['added'],50)
                # 等待全部有限的模拟任务完成，不让并行浏览器检查的负载触发时间竞态。
                jobs.pool.shutdown(wait=True)
                self.assertEqual(sum(j['status']=='success' for j in jobs.public()),50)
        finally:jobs.pool.shutdown()
        self.assertEqual(list(jobs.temp.iterdir()),[])


if __name__=='__main__':unittest.main(verbosity=2)

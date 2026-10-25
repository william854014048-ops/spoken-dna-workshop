"""隔离模拟外部服务，真实执行本地 HTTP、队列、FFmpeg 与凭据加密。"""
import json
from pathlib import Path
import shutil
import sys
import threading
import time
import unittest
from unittest.mock import patch
from urllib import request, error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server as s


class LocalTests(unittest.TestCase):
    def setUp(self):
        self.root = ROOT / 'runtime' / ('test-' + s.uuid.uuid4().hex)
        (self.root / 'data').mkdir(parents=True)
        (self.root / 'runtime/temp').mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_links(self):
        text = '复制整段文案 https://v.douyin.com/AbCd/，第二条 http://xhslink.com/a/Zy123。重复 https://v.douyin.com/AbCd/?from=copy 结束'
        urls = s.extract_links(text)
        self.assertEqual(len(urls), 3)
        self.assertEqual(s.normalize_link(urls[0]), s.normalize_link(urls[2]))
        self.assertEqual(s.normalize_link('https://www.douyin.com/video/123?foo=1'), s.normalize_link('https://www.iesdouyin.com/share/video/123/'))
        self.assertEqual(s.normalize_link('https://www.xiaohongshu.com/explore/abc?xsec_token=aaa'), s.normalize_link('https://www.xiaohongshu.com/discovery/item/abc?xsec_token=bbb'))
        for bad in ['https://v.douyin.com.evil.example/a', 'https://www.douyin.com/user/foo', 'http://127.0.0.1/a', 'file:///c:/a']:
            with self.assertRaises(s.UserError): s.normalize_link(bad)

    @unittest.skipUnless(s.os.name == 'nt', 'Windows DPAPI credential persistence')
    def test_credentials(self):
        c = s.Config(self.root, None)
        with patch.dict(s.os.environ, {}, clear=True):
            c = s.Config(self.root, None)
            c.save({'asrKey':'test-private-asr', 'parserToken':'test-private-parser', 'remember':True})
            self.assertNotIn(b'test-private', c.secret_path.read_bytes())
            second = s.Config(self.root, None)
            self.assertEqual(second.snapshot()[0]['asrKey'], 'test-private-asr')
            self.assertNotIn('test-private', json.dumps(second.public()))
            second.save({'remember':False})
            self.assertFalse(c.secret_path.exists())
            self.assertFalse(s.Config(self.root, None).public()['asrConfigured'])
            second.save({'forget':True})
            self.assertFalse(second.public()['parserConfigured'])

    def test_portable_config_sources(self):
        with patch.dict(s.os.environ, {}, clear=True):
            local=self.root/'.env.local'
            local.write_text('ISTERO_API_TOKEN=project-parser\nSILICONFLOW_API_KEY=project-asr\n',encoding='utf-8')
            c=s.Config(self.root)
            self.assertEqual(c.snapshot()[0],{'parserToken':'project-parser','asrKey':'project-asr'})
            c.save({'forget':True})
            self.assertFalse(s.Config(self.root).public()['parserConfigured'])
            # 已有配置通过本地设置显式指定，不依赖任何开发者目录。
            other=self.root/'external.env'
            other.write_text('ISTERO_API_TOKEN=external-parser',encoding='utf-8')
            s.atomic_json(c.path,{'externalEnvFile':str(other),'reuseExisting':True})
            self.assertEqual(s.Config(self.root).snapshot()[0]['parserToken'],'external-parser')

    def test_unsupported_and_empty(self):
        for data in [{'type':'normal','images':['a']}, {'url':'https://cdn.example/a.jpg','type':'image'}, {}]:
            with self.assertRaises(s.UserError): s.parse_media({'code':200,'data':data})
        with self.assertRaises(s.UserError): s.parse_media({'code':403,'message':'secret-provider-token'})
        p=self.root/'empty.wav';p.write_bytes(b'RIFF')
        with patch.object(s, 'provider_json', return_value={'text':' '}):
            with self.assertRaises(s.UserError): s.transcribe(p,'private','model')
        with patch.object(s.request,'urlopen',side_effect=error.HTTPError('url',401,'private-token',{},None)):
            with self.assertRaises(s.UserError) as ctx: s.provider_json('https://example.com',b'','private','test')
            self.assertNotIn('private',str(ctx.exception))
        with patch.object(s.request,'urlopen',side_effect=TimeoutError()):
            with self.assertRaises(s.UserError): s.provider_json('https://example.com',b'','private','test')

    def test_ffmpeg(self):
        sample=self.root/'test.wav'
        s.run_media(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=440:duration=181','-y',str(sample)],10)
        parts=s.extract_audio(sample,self.root)
        self.assertEqual(len(parts),2)
        self.assertGreater(parts[0].stat().st_size,100)

    def test_queue_retry_and_cleanup(self):
        c=s.Config(self.root,None);c.save({'asrKey':'test-a','parserToken':'test-p','remember':False})
        jobs=s.Jobs(self.root,c)
        calls={}; seen=[]
        def provider(url,body,key,name,*args):
            link=json.loads(body)['url'];seen.append(key)
            calls[link]=calls.get(link,0)+1
            if 'Retry' in link and calls[link]==1: raise s.UserError('模拟解析失败')
            return {'code':200,'data':{'title':'模拟视频','url':'https://cdn.example/test.mp4'}}
        def download(url,dest): dest.write_bytes(b'temporary media')
        def audio(media,folder):
            p=folder/'part.wav';p.write_bytes(b'audio');return [p]
        def asr(part,key,model,timeout): seen.append(key);return '模拟转写原文。'
        with patch.object(s,'provider_json',provider),patch.object(s,'download_media',download),patch.object(s,'extract_audio',audio),patch.object(s,'transcribe',asr):
            result=jobs.submit('https://v.douyin.com/Retry/ https://xhslink.com/Good/ https://v.douyin.com/Retry/?a=1')
            self.assertEqual(result['duplicates'],1)
            for _ in range(100):
                if all(j['status'] not in s.ACTIVE for j in jobs.public()):break
                time.sleep(.02)
            rows=jobs.public();self.assertEqual({j['status'] for j in rows},{'success','failed'})
            failed=next(j for j in rows if j['status']=='failed');jobs.retry(failed['id'])
            for _ in range(100):
                if all(j['status']=='success' for j in jobs.public()):break
                time.sleep(.02)
            self.assertTrue(all(j['status']=='success' for j in jobs.public()))
            jobs.edit(failed['id'],{'title':'改后标题','transcript':'改后原文'})
            edited=next(j for j in jobs.public() if j['id']==failed['id'])
            self.assertEqual(edited['originalTranscript'],'模拟转写原文。')
            self.assertEqual(edited['transcript'],'改后原文')
        jobs.pool.shutdown()
        self.assertEqual(list(jobs.temp.iterdir()),[])
        self.assertIn('test-a',seen);self.assertIn('test-p',seen)
        self.assertNotIn('test-a',jobs.path.read_text(encoding='utf-8'))

    def test_partial_media_cleanup_and_restart(self):
        c=s.Config(self.root,None);c.save({'asrKey':'test-a','parserToken':'test-p','remember':False})
        jobs=s.Jobs(self.root,c)
        job=dict(id='c'*32,key='douyin-short:Fail',platform='抖音',originalUrl='https://v.douyin.com/Fail/',status='pending',attempts=1)
        jobs.rows.append(job)
        def interrupted(url,dest):
            dest.write_bytes(b'partial temporary media')
            raise s.UserError('模拟下载超时')
        with patch.object(s,'provider_json',return_value={'code':200,'data':{'title':'下载失败测试','url':'https://cdn.example/video.mp4'}}),patch.object(s,'download_media',interrupted):
            jobs.process(job)
        self.assertEqual(job['status'],'failed')
        self.assertEqual(list(jobs.temp.iterdir()),[])
        job['status']='transcribing';jobs.flush()
        folder=jobs.temp/job['id'];folder.mkdir();(folder/'media.bin').write_bytes(b'abandoned')
        jobs.pool.shutdown()
        restarted=s.Jobs(self.root,c)
        self.assertEqual(restarted.public()[0]['status'],'failed')
        self.assertEqual(list(restarted.temp.iterdir()),[])
        restarted.pool.shutdown()

    def test_http_guards_and_read_config(self):
        server=s.make_server(self.root,0,None)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base='http://127.0.0.1:'+str(server.server_port)
        try:
            data=json.load(request.urlopen(base+'/api/config'))
            self.assertIn('asrConfigured',data)
            req=request.Request(base+'/api/config',data=b'{"asrKey":"http-test","remember":false}',method='PUT',headers={'Content-Type':'application/json','X-Spoken-DNA':'local'})
            self.assertTrue(json.load(request.urlopen(req))['asrConfigured'])
            self.assertEqual(server.config.snapshot()[0]['asrKey'],'http-test')
            for headers in [{'Origin':'https://evil.example','X-Spoken-DNA':'local'},{}]:
                req=request.Request(base+'/api/jobs',data=b'{}',headers=headers)
                with self.assertRaises(error.HTTPError) as ctx: request.urlopen(req)
                self.assertEqual(ctx.exception.code,403)
            for path in ['/data/settings.json','/server.py','/data/credentials.dpapi']:
                with self.assertRaises(error.HTTPError) as ctx: request.urlopen(base+path)
                self.assertEqual(ctx.exception.code,404)
        finally:
            server.shutdown();server.server_close();server.jobs.pool.shutdown();thread.join()


if __name__=='__main__':unittest.main(verbosity=2)

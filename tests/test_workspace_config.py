import io
import json
from pathlib import Path
import shutil
import sys
import threading
import unittest
from unittest.mock import Mock, patch
from urllib import request

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import server as s
from dna_store import DnaStore
import folder_picker


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.root=ROOT/'runtime'/('test-workspace-'+s.uuid.uuid4().hex)
        (self.root/'data').mkdir(parents=True)
        self.config=s.Config(self.root)

    def tearDown(self):
        assert self.root.resolve().is_relative_to((ROOT/'runtime').resolve())
        shutil.rmtree(self.root)

    def dna(self):return {'id':'author-test','name':'中文博主','text':'# DNA\n自然口语。','raw':[{'title':'原稿','content':'先说真实经历。'}],'results':{}}

    @unittest.skipUnless(s.os.name=='nt','Windows encrypted persistence')
    def test_workspace_remembers_all_three_keys_and_models(self):
        self.config.save({'asrKey':'fake-asr-private','parserToken':'fake-parser-private','writingKey':'fake-writing-private',
                          'writingBase':'https://writing.example.test/v1','writingModel':'example/model','remember':True})
        old=DnaStore(self.config);old.configure(str(self.root/'旧DNA目录'));saved=old.save(self.dna())
        workspace=self.root/'统一工作目录';workspace.mkdir()
        data=s.connect_workspace(self.config,old,str(workspace))
        self.assertEqual(data['workspaceDirectory'],str(workspace))
        self.assertEqual(len(data['entries']),1)
        self.assertTrue(Path(saved['directory']).exists())  # 旧文件保留，不移动。
        self.assertEqual(self.config.path,workspace/'config.json')
        self.assertEqual(self.config.secret_path,workspace/'credentials.dpapi')
        self.assertTrue((workspace/'DNA').is_dir())
        self.assertEqual(json.loads(self.config.bootstrap_path.read_text(encoding='utf-8')),{'workspaceDirectory':str(workspace)})
        plain=(workspace/'config.json').read_text(encoding='utf-8')
        for secret in ('fake-asr-private','fake-parser-private','fake-writing-private'):
            self.assertNotIn(secret,plain);self.assertNotIn(secret.encode(),(workspace/'credentials.dpapi').read_bytes())
        restarted=s.Config(self.root)
        self.assertEqual(restarted.snapshot()[0],self.config.snapshot()[0])
        self.assertTrue(restarted.public()['writingConfigured'])
        self.assertEqual(restarted.public()['writingModel'],'example/model')
        self.assertNotIn('fake-writing-private',json.dumps(restarted.public()))
        restarted.save({'model':'must-not-change','writingKey':''})
        self.assertEqual(restarted.snapshot()[1],s.ASR_MODEL)
        self.assertTrue(s.Config(self.root).public()['writingConfigured'])

    @unittest.skipUnless(s.os.name=='nt','Windows encrypted persistence')
    def test_existing_workspace_connects_from_another_checkout(self):
        selected=self.root/'资料';selected.mkdir()
        s.connect_workspace(self.config,DnaStore(self.config),str(selected))
        self.config.save({'writingKey':'remembered-key','asrKey':'remembered-asr','parserToken':'remembered-parser','writingBase':'https://custom.example/v1','writingModel':'custom-model'})
        DnaStore(self.config).save(self.dna())
        other=self.root/'另一个项目副本';(other/'data').mkdir(parents=True)
        config=s.Config(other)
        result=s.connect_workspace(config,DnaStore(config),str(selected))
        self.assertEqual(len(result['entries']),1)
        self.assertEqual(config.snapshot()[0]['writingKey'],'remembered-key')
        self.assertEqual(config.public()['writingBase'],'https://custom.example/v1')

    def test_unrelated_config_is_never_overwritten(self):
        selected=self.root/'其他项目';selected.mkdir();file=selected/'config.json';file.write_text('{"other":"keep"}',encoding='utf-8')
        with self.assertRaises(s.UserError):s.connect_workspace(self.config,DnaStore(self.config),str(selected))
        self.assertEqual(file.read_text(encoding='utf-8'),'{"other":"keep"}')
        self.assertIsNone(self.config.workspace)

    def test_fixed_asr_model_and_saved_writing_key_are_used_by_proxy(self):
        self.config.save({'writingKey':'proxy-secret','writingBase':'https://writing.example.test/v1','writingModel':'saved-model','model':'other-asr'})
        self.assertEqual(self.config.snapshot()[1],s.ASR_MODEL)
        response={'choices':[{'message':{'content':'ok'},'finish_reason':'stop'}]}
        with patch.object(s,'provider_json',return_value=response) as call:
            result=s.writing_request(self.config,{'messages':[{'role':'user','content':'hello'}],'max_tokens':20,'model':'ignored-client-model'})
        self.assertEqual(result,response)
        args=call.call_args.args
        self.assertEqual(args[0],'https://writing.example.test/v1/chat/completions')
        self.assertEqual(args[2],'proxy-secret')
        self.assertEqual(json.loads(args[1])['model'],'saved-model')
        self.assertNotIn('proxy-secret',json.dumps(result))

    def test_picker_cancel_and_selected_folder_http(self):
        app=s.make_server(self.root,0);thread=threading.Thread(target=app.serve_forever,daemon=True);thread.start()
        url='http://127.0.0.1:'+str(app.server_port)+'/api/workspace/choose'
        def choose():
            req=request.Request(url,data=b'{}',headers={'Content-Type':'application/json','X-Spoken-DNA':'local'},method='POST')
            with request.urlopen(req) as res:return json.load(res)
        try:
            with patch.object(s,'choose_local_directory',return_value=''):
                self.assertTrue(choose()['cancelled']);self.assertIsNone(app.config.workspace)
            with patch.object(s,'choose_local_directory',return_value=str(self.root/'选择的目录')):
                result=choose();self.assertTrue(result['configured'])
                self.assertEqual(result['workspaceDirectory'],str(self.root/'选择的目录'))
                self.assertTrue((self.root/'选择的目录/config.json').exists())
        finally:app.shutdown();app.server_close();app.jobs.pool.shutdown();thread.join()

    def test_native_picker_uses_directory_dialog_and_handles_cancel(self):
        fake=Mock()
        with patch('tkinter.Tk',return_value=fake),patch('tkinter.filedialog.askdirectory',return_value='') as ask:
            self.assertEqual(folder_picker.choose_local_directory('E:/'), '')
            self.assertTrue(ask.call_args.kwargs['mustexist'])
            fake.destroy.assert_called_once()


if __name__=='__main__':unittest.main(verbosity=2)

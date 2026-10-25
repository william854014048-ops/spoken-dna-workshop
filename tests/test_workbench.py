import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server as s
from workbench_store import WorkbenchStore, WorkbenchConflict
from dna_store import LibraryError


class WorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='workbench-test-', dir=ROOT/'runtime'))
        self.config = s.Config(self.root)
        self.folder = self.root/'中文工作目录'
        self.folder.mkdir()
        self.config.workspace = self.folder
        self.store = WorkbenchStore(self.config)

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_authors_composition_versions_round_trip_without_keys(self):
        state = {'app': {'library': [{'id':'excluded'}], 'dnaSelection': {'structure':'A', 'rhythm':'B'},
                         'authorSpaces': {'A': {'name':'参考作者甲','articles':[]}},
                         'revisions': [{'stage':'原始口述','text':'昨天，我试了一次。'}],
                         'writingKey':'do-not-store', 'nested':{'asrKey':'also-private'}}, 'articles':[]}
        self.assertEqual(self.store.save(state, 0)['revision'], 1)
        recovered = WorkbenchStore(self.config).load()
        self.assertEqual(recovered['state']['app']['dnaSelection']['rhythm'], 'B')
        self.assertEqual(recovered['state']['app']['revisions'][0]['text'], '昨天，我试了一次。')
        text = (self.folder/'workbench.json').read_text(encoding='utf-8')
        self.assertNotIn('do-not-store', text)
        self.assertNotIn('also-private', text)
        self.assertNotIn('library', recovered['state']['app'])
        self.assertIn('中文工作目录', str(next(self.root.iterdir())))

    def test_stale_tab_and_damaged_file_are_not_overwritten(self):
        self.store.save({'app':{},'articles':[]},0)
        with self.assertRaises(WorkbenchConflict):
            self.store.save({'app':{'spoken':'stale'},'articles':[]},0)
        path=self.folder/'workbench.json'
        path.write_text('broken',encoding='utf-8')
        with self.assertRaises(LibraryError):self.store.save({'app':{},'articles':[]},1)
        self.assertEqual(path.read_text(encoding='utf-8'),'broken')

    def test_parser_author_is_metadata_not_title_guess(self):
        self.assertEqual(s.parse_author({'data':{'author':{'nickname':'甲','sec_uid':'123'}}}),('甲','123'))
        self.assertEqual(s.parse_author({'data':{'title':'@某某 分享视频'}}),('',''))
        self.assertEqual(s.parse_author({'data':{'author':'乙'}}),('乙',''))

    def test_known_redirect_fake_ip_but_not_private_or_suffix_spoof(self):
        answers=lambda host,*a,**k:[(2,1,6,'',('198.18.1.13',443))]
        with patch.object(s.socket,'getaddrinfo',side_effect=answers):
            self.assertTrue(s.remote_url('https://test.v.smtcdns.com/video'))
            with self.assertRaises(s.UserError):s.remote_url('https://smtcdns.com.evil.example/video')
        with patch.object(s.socket,'getaddrinfo',return_value=[(2,1,6,'',('192.168.1.1',443))]):
            with self.assertRaises(s.UserError):s.remote_url('https://test.v.smtcdns.com/video')


if __name__=='__main__':unittest.main()

from pathlib import Path
import shutil
import tempfile
import unittest

from project_skills import load_skills

ROOT = Path(__file__).resolve().parents[1]


class ProjectSkillsTests(unittest.TestCase):
    def test_prompt_edit_is_read_next_time_and_missing_file_is_not_silent(self):
        folder = Path(tempfile.mkdtemp(prefix='skills-test-', dir=ROOT/'runtime'))
        try:
            shutil.copytree(ROOT/'skills', folder/'skills')
            first = load_skills(folder)
            self.assertEqual(set(first['skills']), {'dna-extract','dna-compose','deai-edit'})
            target=folder/'skills/dna-compose/review.md'
            target.write_text('新的核对要求：保留事实。',encoding='utf-8')
            self.assertEqual(load_skills(folder)['skills']['dna-compose']['review'],'新的核对要求：保留事实。')
            target.unlink()
            with self.assertRaises(OSError):load_skills(folder)
        finally:
            shutil.rmtree(folder)


if __name__=='__main__':unittest.main()

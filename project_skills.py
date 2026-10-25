"""只读取本项目明确列出的 Skill 提示词，不执行文档内容。"""
from pathlib import Path


SKILLS = {
    'dna-extract': ('system', 'common', 'batch', 'aggregate'),
    'dna-compose': ('system', 'intent', 'compose', 'review', 'skip'),
    'deai-edit': ('system', 'strict', 'relaxed'),
}


def load_skills(root: Path):
    result = {}
    for name, parts in SKILLS.items():
        folder = root / 'skills' / name
        prompts = {}
        for part in parts:
            file = folder / (part + '.md')
            if file.stat().st_size > 100000:
                raise ValueError('Skill 提示词文件过大。')
            prompts[part] = file.read_text(encoding='utf-8-sig').strip()
            if not prompts[part]:
                raise ValueError('Skill 提示词不能为空。')
        result[name] = prompts
    return {'version': 1, 'skills': result}

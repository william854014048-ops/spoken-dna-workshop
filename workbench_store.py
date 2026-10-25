"""工作区资料与文稿版本；与 DNA 文件和加密凭据分别保存。"""
from __future__ import annotations

import json
import threading

from dna_store import LibraryError, clean_data, write_text_atomic


class WorkbenchConflict(LibraryError):
    pass


class WorkbenchStore:
    MAX_BYTES = 16 * 1024 * 1024

    def __init__(self, config):
        self.config = config
        self.lock = threading.RLock()

    def load(self):
        with self.lock:
            folder = self.config.workspace
            if folder is None:
                return {'configured': False, 'exists': False, 'revision': 0, 'state': None}
            path = folder / 'workbench.json'
            if not path.exists():
                return {'configured': True, 'exists': False, 'revision': 0, 'state': None}
            try:
                if path.stat().st_size > self.MAX_BYTES:
                    raise ValueError()
                data = json.loads(path.read_text(encoding='utf-8-sig'))
                if data.get('format') != 'spoken-dna-workbench/v1' or not isinstance(data.get('state'), dict):
                    raise ValueError()
                return {'configured': True, 'exists': True, 'revision': data['revision'], 'state': clean_data(data['state'])}
            except (OSError, ValueError, KeyError, TypeError):
                raise LibraryError('工作区文件无法读取，已保留原文件及浏览器资料，请先检查 workbench.json。') from None

    def save(self, state, revision):
        with self.lock:
            current = self.load()
            if not current['configured']:
                raise LibraryError('请先选择本地工作目录，才能保存工作区。')
            if not isinstance(state, dict) or not isinstance(state.get('app'), dict) or not isinstance(state.get('articles'), list):
                raise LibraryError('工作区资料格式不正确。')
            if revision != current['revision']:
                raise WorkbenchConflict('另一个页面已更新工作区。本页资料仍在浏览器中，请先导出备份，再刷新读取最新版本。')
            data = {'format': 'spoken-dna-workbench/v1', 'revision': revision + 1, 'state': clean_data(state)}
            # DNA 库单独保存，不在每次自动保存时重复复制。
            data['state']['app'].pop('library', None)
            text = json.dumps(data, ensure_ascii=False, indent=2)
            if len(text.encode('utf-8')) > self.MAX_BYTES:
                raise LibraryError('工作区超过 16 MB，请先导出备份并减少不再使用的素材。')
            path = self.config.workspace / 'workbench.json'
            try:
                write_text_atomic(path, text)
                if json.loads(path.read_text(encoding='utf-8')) != data:
                    raise LibraryError('工作区保存后回读失败，浏览器资料已保留。')
            except OSError as exc:
                raise LibraryError(f'工作区写入失败（系统错误 {getattr(exc, "winerror", None) or exc.errno}），浏览器资料已保留。') from None
            return {'ok': True, 'revision': data['revision']}

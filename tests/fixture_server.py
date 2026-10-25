"""只供页面回归使用：在 runtime 内隔离配置、任务和 DNA。"""
from pathlib import Path
import os
import shutil
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import server

if __name__=='__main__':
    root=ROOT/'runtime'/('browser-fixture-'+server.uuid.uuid4().hex)
    root.mkdir(parents=True,exist_ok=True)
    for key in ('ISTERO_API_TOKEN','ISTERO_TOKEN','SILICONFLOW_API_KEY','SPOKEN_DNA_ENV_FILE'):
        os.environ.pop(key,None)
    shutil.copytree(ROOT/'web',root/'web',dirs_exist_ok=True)
    shutil.copytree(ROOT/'skills',root/'skills',dirs_exist_ok=True)
    # 页面回归不弹真实系统窗口；同一路由仍真实连接目录、读写配置和加密密钥。
    server.choose_local_directory=lambda initial: str(root/'所选工作目录')
    app=server.make_server(root,8766)
    try:app.serve_forever(poll_interval=.1)
    finally:app.server_close();app.jobs.pool.shutdown()

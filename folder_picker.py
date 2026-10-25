"""从本机服务弹出系统文件夹选择器；取消不改变配置。"""
import threading


class FolderPickerError(Exception):
    pass


_lock = threading.Lock()


def choose_local_directory(initial=''):
    if not _lock.acquire(blocking=False):
        raise FolderPickerError('文件夹选择窗口已经打开，请先完成或取消当前选择。')
    root = None
    try:
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            return filedialog.askdirectory(parent=root, title='选择口播 DNA 本地工作目录',
                                           initialdir=initial or None, mustexist=True) or ''
        except Exception:
            raise FolderPickerError('无法打开系统文件夹选择器。请检查 Python 是否包含 tkinter，并在本机桌面环境运行服务。') from None
    finally:
        if root is not None:
            root.destroy()
        _lock.release()

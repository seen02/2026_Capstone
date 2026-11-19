"""개발 서버의 Python 변경 감지와 자동 재시작. 실행 중인 콘솔은 유지한다."""
from pathlib import Path
import socket
import subprocess
import sys
import time
import threading


def signatures(paths):
    result=[]
    for path in sorted(paths):
        try:
            stat=path.stat();result.append((str(path),stat.st_mtime_ns,stat.st_size))
        except OSError:
            result.append((str(path),None,None))
    return tuple(result)


def python_signature(root):
    return signatures((Path(root)/'lotteworld_sim').rglob('*.py'))


def stop_child(child):
    if child.poll() is None:
        child.terminate()
        try: child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill();child.wait()


def supervise(root, port, config_path=None, stop_event=None, *, host="127.0.0.1", mock_data=None):
    stop_event=stop_event or threading.Event()
    if port==0:
        with socket.socket() as reservation:
            reservation.bind((host,0));port=reservation.getsockname()[1]
    command=[sys.executable,'-m','lotteworld_sim.server','--host',host,'--port',str(port),'--no-reload']
    if config_path: command+=['--config',str(Path(config_path).resolve())]
    if mock_data: command+=['--mock-data',str(Path(mock_data).resolve())]
    child=None
    try:
        signature=python_signature(root)
        def start():
            return subprocess.Popen(command,cwd=root,stdout=sys.stdout,stderr=sys.stderr,stdin=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        child=start()
        has_restarted=False
        print('개발 자동 반영: 화면·설정 수정 후 새로고침하세요. Python 변경은 자동 재시작합니다.',flush=True)
        while not stop_event.wait(.4):
            updated=python_signature(root)
            if updated!=signature:
                if stop_event.wait(.3):break
                signature=python_signature(root)
                stop_child(child)
                print('서버 코드 변경을 감지해 다시 불러옵니다.',flush=True)
                child=start();has_restarted=True
            elif child.poll() is not None:
                if not has_restarted:return child.returncode
                # 잘못 저장한 소스에서 재시작을 반복하지 않는다. 다음 저장을 기다린다.
                config_signature=signatures((Path(root)/'configs').glob('*.json'))
                while python_signature(root)==signature and signatures((Path(root)/'configs').glob('*.json'))==config_signature:
                    if stop_event.wait(.4):return
                signature=python_signature(root);child=start()
    except KeyboardInterrupt:
        pass
    finally:
        if child is not None:stop_child(child)
    return 0

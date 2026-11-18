"""Configuração de logs: arquivo .log diário + console, com o id da execução em cada linha."""
from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path


class _ExecucaoFilter(logging.Filter):
    def __init__(self, execucao_id: str):
        super().__init__()
        self.execucao_id = execucao_id

    def filter(self, record: logging.LogRecord) -> bool:
        record.execucao_id = self.execucao_id
        return True


def configurar_logs(log_dir: Path, execucao_id: str) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    arquivo = log_dir / f"rpa_cotacoes_{datetime.now():%Y%m%d}.log"
    formato = logging.Formatter(
        "%(asctime)s | %(levelname)-8s | exec=%(execucao_id)s | %(name)s | %(message)s",
        "%Y-%m-%d %H:%M:%S",
    )
    raiz = logging.getLogger()
    raiz.setLevel(logging.INFO)
    for h in list(raiz.handlers):
        raiz.removeHandler(h)
    filtro = _ExecucaoFilter(execucao_id)
    for handler in (logging.FileHandler(arquivo, encoding="utf-8"), logging.StreamHandler()):
        handler.setFormatter(formato)
        handler.addFilter(filtro)
        raiz.addHandler(handler)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    return arquivo

"""Configurações do bot (variáveis de ambiente ou arquivo rpa/.env)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

RPA_DIR = Path(__file__).resolve().parent.parent

try:
    from dotenv import load_dotenv

    load_dotenv(RPA_DIR / ".env")
except ImportError:  # pragma: no cover
    pass


def _lista(valor: str) -> list[str]:
    return [v.strip().upper() for v in valor.split(",") if v.strip()]


@dataclass(frozen=True)
class Config:
    # Banco do MVP (Postgres em produção; SQLite para desenvolvimento local)
    database_url: str = os.getenv("DATABASE_URL", f"sqlite:///{(RPA_DIR / 'data' / 'agroconecta.db').as_posix()}")

    # Fonte CEAGESP
    ceagesp_url: str = os.getenv("CEAGESP_URL", "https://ceagesp.gov.br/cotacoes/")
    grupos: list[str] = field(default_factory=lambda: _lista(
        os.getenv("RPA_GRUPOS", "FRUTAS,LEGUMES,VERDURAS,DIVERSOS")))
    janela_dias: int = int(os.getenv("RPA_JANELA_DIAS", "15"))   # até quantos dias atrás buscar boletins
    pausa_entre_requisicoes: float = float(os.getenv("RPA_PAUSA_SEG", "2"))
    tentativas: int = int(os.getenv("RPA_TENTATIVAS", "3"))
    timeout: int = int(os.getenv("RPA_TIMEOUT", "30"))
    user_agent: str = "AgroConecta-RPA/1.0 (projeto academico FIAP)"

    # Regras de negócio
    alerta_variacao_pct: float = float(os.getenv("RPA_ALERTA_VARIACAO_PCT", "15"))
    alerta_janela_cotacoes: int = int(os.getenv("RPA_ALERTA_JANELA", "5"))
    preco_maximo_plausivel: float = float(os.getenv("RPA_PRECO_MAXIMO", "5000"))

    # Logs e agendamento
    log_dir: Path = Path(os.getenv("RPA_LOG_DIR", str(RPA_DIR / "logs")))
    horario_agendado: str = os.getenv("RPA_HORARIO", "07:30")


CONFIG = Config()

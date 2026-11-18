"""Persistência no banco do MVP (PostgreSQL em produção, SQLite em desenvolvimento).

Tabelas:
  cotacoes              — cotações válidas (upsert pela chave natural)
  cotacoes_rejeitadas   — registros reprovados na validação, com o motivo
  alertas_preco         — variações relevantes de preço (Central de Alertas)
  execucoes_rpa         — histórico de execuções do robô (espelho dos .log)
"""
from __future__ import annotations

import json
from datetime import date, datetime

import pandas as pd
from sqlalchemy import (JSON, Column, Date, DateTime, Float, Integer, MetaData, String, Table, Text,
                        UniqueConstraint, create_engine, func, select)
from sqlalchemy.engine import Engine

metadata = MetaData()

cotacoes = Table(
    "cotacoes", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("fonte", String(40), nullable=False),
    Column("localidade", String(120), nullable=False),
    Column("grupo", String(40), nullable=False),
    Column("produto", String(120), nullable=False),
    Column("produto_normalizado", String(120), nullable=False, index=True),
    Column("classificacao", String(80), nullable=False, default=""),
    Column("unidade", String(30)),
    Column("unidade_original", String(20), nullable=False),
    Column("peso_kg", Float),
    Column("preco_minimo", Float),
    Column("preco_comum", Float, nullable=False),
    Column("preco_maximo", Float),
    Column("preco_kg", Float),
    Column("data_cotacao", Date, nullable=False, index=True),
    Column("coletado_em", DateTime, nullable=False),
    Column("execucao_id", String(40)),
    UniqueConstraint("fonte", "produto_normalizado", "classificacao", "unidade_original", "data_cotacao",
                     name="uq_cotacao"),
)

cotacoes_rejeitadas = Table(
    "cotacoes_rejeitadas", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("execucao_id", String(40)),
    Column("fonte", String(40)),
    Column("grupo", String(40)),
    Column("data_cotacao", Date),
    Column("registro", Text),
    Column("motivo", Text),
    Column("rejeitado_em", DateTime, default=datetime.now),
)

alertas_preco = Table(
    "alertas_preco", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("fonte", String(40)),
    Column("produto", String(120)),
    Column("produto_normalizado", String(120), index=True),
    Column("classificacao", String(80)),
    Column("unidade", String(30)),
    Column("data_cotacao", Date, index=True),
    Column("preco_atual", Float),
    Column("preco_referencia", Float),
    Column("variacao_pct", Float),
    Column("tipo", String(10)),           # ALTA | QUEDA
    Column("mensagem", Text),
    Column("criado_em", DateTime, default=datetime.now),
    UniqueConstraint("fonte", "produto_normalizado", "classificacao", "unidade", "data_cotacao", name="uq_alerta"),
)

execucoes_rpa = Table(
    "execucoes_rpa", metadata,
    Column("execucao_id", String(40), primary_key=True),
    Column("inicio", DateTime),
    Column("fim", DateTime),
    Column("status", String(20)),          # SUCESSO | SUCESSO_PARCIAL | SEM_NOVIDADES | FALHA
    Column("fonte", String(40)),
    Column("registros_coletados", Integer),
    Column("registros_validos", Integer),
    Column("registros_rejeitados", Integer),
    Column("alertas_gerados", Integer),
    Column("erros", JSON),
    Column("detalhes", JSON),
)


class Repositorio:
    def __init__(self, database_url: str):
        self.engine: Engine = create_engine(database_url, future=True)
        metadata.create_all(self.engine)

    # ------------------------------------------------------------------ util
    def _insert(self, tabela):
        dialeto = self.engine.dialect.name
        if dialeto == "postgresql":
            from sqlalchemy.dialects.postgresql import insert
        elif dialeto == "sqlite":
            from sqlalchemy.dialects.sqlite import insert
        else:  # pragma: no cover
            raise NotImplementedError(f"Banco não suportado: {dialeto}")
        return insert(tabela)

    @staticmethod
    def _registros(df: pd.DataFrame) -> list[dict]:
        return [{k: (None if pd.isna(v) else v) for k, v in linha.items()}
                for linha in df.to_dict(orient="records")]

    # -------------------------------------------------------------- consultas
    def datas_ja_coletadas(self, fonte: str, grupo: str) -> set[date]:
        with self.engine.connect() as con:
            linhas = con.execute(select(cotacoes.c.data_cotacao).distinct()
                                 .where(cotacoes.c.fonte == fonte, cotacoes.c.grupo == grupo))
            return {r[0] for r in linhas}

    def historico(self, fonte: str, data_limite: date) -> pd.DataFrame:
        consulta = select(cotacoes).where(cotacoes.c.fonte == fonte, cotacoes.c.data_cotacao <= data_limite)
        with self.engine.connect() as con:
            return pd.read_sql(consulta, con)

    # ---------------------------------------------------------------- gravação
    def salvar_cotacoes(self, df: pd.DataFrame, execucao_id: str) -> int:
        if df.empty:
            return 0
        linhas = self._registros(df.assign(execucao_id=execucao_id))
        stmt = self._insert(cotacoes)
        atualizar = {c: stmt.excluded[c] for c in (
            "produto", "unidade", "peso_kg", "preco_minimo", "preco_comum", "preco_maximo",
            "preco_kg", "coletado_em", "execucao_id", "localidade", "grupo")}
        stmt = stmt.on_conflict_do_update(
            index_elements=["fonte", "produto_normalizado", "classificacao", "unidade_original", "data_cotacao"],
            set_=atualizar)
        with self.engine.begin() as con:
            con.execute(stmt, linhas)
        return len(linhas)

    def salvar_rejeitados(self, df: pd.DataFrame, execucao_id: str) -> int:
        if df.empty:
            return 0
        linhas = []
        for r in self._registros(df):
            linhas.append({
                "execucao_id": execucao_id,
                "fonte": r.get("fonte"),
                "grupo": r.get("grupo"),
                "data_cotacao": r.get("data_cotacao"),
                "registro": json.dumps({k: v for k, v in r.items() if k != "motivo"}, default=str, ensure_ascii=False),
                "motivo": r.get("motivo"),
            })
        with self.engine.begin() as con:
            con.execute(cotacoes_rejeitadas.insert(), linhas)
        return len(linhas)

    def salvar_alertas(self, alertas: list[dict]) -> int:
        if not alertas:
            return 0
        stmt = self._insert(alertas_preco).on_conflict_do_nothing()
        with self.engine.begin() as con:
            res = con.execute(stmt, alertas)
        return res.rowcount if res.rowcount and res.rowcount > 0 else len(alertas)

    def registrar_execucao(self, dados: dict):
        stmt = self._insert(execucoes_rpa)
        stmt = stmt.on_conflict_do_update(index_elements=["execucao_id"],
                                          set_={k: stmt.excluded[k] for k in dados if k != "execucao_id"})
        with self.engine.begin() as con:
            con.execute(stmt, dados)

    def contar(self, tabela: Table) -> int:
        with self.engine.connect() as con:
            return con.execute(select(func.count()).select_from(tabela)).scalar_one()

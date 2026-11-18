"""API de leitura das cotações para o MVP (Central de Cotações e Alertas).

    uvicorn api.app:app --reload        (executar dentro da pasta rpa/)
    Documentação interativa: http://localhost:8000/docs
"""
from __future__ import annotations

from datetime import date

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import desc, func, select

from bot_cotacoes.config import CONFIG
from bot_cotacoes.repositorio import Repositorio, alertas_preco, cotacoes, execucoes_rpa
from bot_cotacoes.validador import normalizar_produto

repo = Repositorio(CONFIG.database_url)
app = FastAPI(title="AgroConecta — Cotações", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])


def _linhas(stmt) -> list[dict]:
    with repo.engine.connect() as con:
        return [dict(r._mapping) for r in con.execute(stmt)]


@app.get("/saude")
def saude():
    ultima = _linhas(select(execucoes_rpa).order_by(desc(execucoes_rpa.c.inicio)).limit(1))
    return {"status": "ok", "ultima_execucao_rpa": ultima[0] if ultima else None}


@app.get("/cotacoes/ultimas")
def ultimas_cotacoes(grupo: str | None = None, produto: str | None = None, limite: int = Query(500, le=5000)):
    """Cotações do boletim mais recente (por grupo)."""
    ult = (select(cotacoes.c.grupo, func.max(cotacoes.c.data_cotacao).label("data"))
           .group_by(cotacoes.c.grupo).subquery())
    stmt = (select(cotacoes).join(ult, (cotacoes.c.grupo == ult.c.grupo) & (cotacoes.c.data_cotacao == ult.c.data))
            .order_by(cotacoes.c.grupo, cotacoes.c.produto).limit(limite))
    if grupo:
        stmt = stmt.where(cotacoes.c.grupo == grupo.upper())
    if produto:
        stmt = stmt.where(cotacoes.c.produto_normalizado.like(f"%{normalizar_produto(produto)}%"))
    return _linhas(stmt)


@app.get("/cotacoes/historico")
def historico(produto: str, inicio: date | None = None, fim: date | None = None):
    """Série histórica de um produto (todas as classificações)."""
    stmt = (select(cotacoes).where(cotacoes.c.produto_normalizado.like(f"%{normalizar_produto(produto)}%"))
            .order_by(cotacoes.c.data_cotacao, cotacoes.c.classificacao))
    if inicio:
        stmt = stmt.where(cotacoes.c.data_cotacao >= inicio)
    if fim:
        stmt = stmt.where(cotacoes.c.data_cotacao <= fim)
    dados = _linhas(stmt)
    if not dados:
        raise HTTPException(404, f"Nenhuma cotação para '{produto}'")
    return dados


@app.get("/cotacoes/produtos")
def produtos():
    stmt = (select(cotacoes.c.grupo, cotacoes.c.produto, cotacoes.c.produto_normalizado)
            .distinct().order_by(cotacoes.c.grupo, cotacoes.c.produto))
    return _linhas(stmt)


@app.get("/alertas")
def alertas(tipo: str | None = None, limite: int = Query(100, le=1000)):
    stmt = select(alertas_preco).order_by(desc(alertas_preco.c.data_cotacao),
                                          desc(func.abs(alertas_preco.c.variacao_pct))).limit(limite)
    if tipo:
        stmt = stmt.where(alertas_preco.c.tipo == tipo.upper())
    return _linhas(stmt)


@app.get("/execucoes")
def execucoes(limite: int = Query(20, le=200)):
    return _linhas(select(execucoes_rpa).order_by(desc(execucoes_rpa.c.inicio)).limit(limite))

"""Regras de alerta de preço para a Central de Cotações e Alertas.

Para cada produto (mesma classificação e unidade) cotado na data, compara o
preço comum com a média das últimas N cotações anteriores. Se a variação passar
do limite configurado, gera um alerta de ALTA ou QUEDA.
"""
from __future__ import annotations

from datetime import date

import pandas as pd


def gerar_alertas(historico: pd.DataFrame, data_alvo: date, limite_pct: float = 15.0,
                  janela: int = 5, minimo_historico: int = 2) -> list[dict]:
    if historico.empty:
        return []
    chave = ["fonte", "produto_normalizado", "classificacao", "unidade_original"]
    hist = historico.sort_values("data_cotacao")
    alertas = []
    for _, grupo in hist.groupby(chave, sort=False):
        atual = grupo[grupo["data_cotacao"] == data_alvo]
        anteriores = grupo[grupo["data_cotacao"] < data_alvo].tail(janela)
        if atual.empty or len(anteriores) < minimo_historico:
            continue  # sem base de comparação suficiente
        preco_atual = float(atual["preco_comum"].iloc[-1])
        referencia = float(anteriores["preco_comum"].mean())
        if referencia <= 0:
            continue
        variacao = (preco_atual - referencia) / referencia * 100
        if abs(variacao) < limite_pct:
            continue
        linha = atual.iloc[-1]
        tipo = "ALTA" if variacao > 0 else "QUEDA"
        descricao = f"{linha['produto']}" + (f" ({linha['classificacao']})" if linha["classificacao"] else "")
        alertas.append({
            "fonte": linha["fonte"],
            "produto": linha["produto"],
            "produto_normalizado": linha["produto_normalizado"],
            "classificacao": linha["classificacao"],
            "unidade": linha["unidade"],
            "data_cotacao": data_alvo,
            "preco_atual": round(preco_atual, 2),
            "preco_referencia": round(referencia, 2),
            "variacao_pct": round(variacao, 1),
            "tipo": tipo,
            "mensagem": (f"{descricao}: {tipo.lower()} de {abs(variacao):.1f}% — R$ {preco_atual:.2f}/{linha['unidade']} "
                         f"contra média de R$ {referencia:.2f} nas últimas {len(anteriores)} cotações."),
        })
    return alertas

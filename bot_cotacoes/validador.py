"""Validação e padronização das cotações com pandas.

Regras (cada registro reprovado vai para ``cotacoes_rejeitadas`` com o motivo):
  R1  preço comum ausente
  R2  preço não numérico, zero ou negativo
  R3  faixa incoerente (mínimo > comum ou comum > máximo)
  R4  preço acima do teto plausível (erro de digitação na fonte)
  R5  data da cotação ausente, futura ou diferente da data solicitada
  R6  produto sem nome
  R7  registro duplicado (mesma fonte, produto, classificação, unidade e data)
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime

import pandas as pd

# Siglas usadas pelas CEASAs -> unidade padronizada do AgroConecta
UNIDADES = {
    "KG": "kg",
    "UN": "unidade",
    "UND": "unidade",
    "ENG": "engradado",
    "CX": "caixa",
    "MC": "maço",
    "MÇ": "maço",
    "BJ": "bandeja",
    "CBC": "cabeça",
    "SC": "saco",
    "PCT": "pacote",
    "DZ": "dúzia",
    "VS": "vaso",
    "M2": "m²",
    "TORRÃO": "torrão",
    "MALA": "mala",
    "TON": "tonelada",
}

COLUNAS_SAIDA = [
    "fonte", "localidade", "grupo", "produto", "produto_normalizado", "classificacao",
    "unidade", "unidade_original", "peso_kg", "preco_minimo", "preco_comum", "preco_maximo",
    "preco_kg", "data_cotacao", "coletado_em",
]


def remover_acentos(texto: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", texto) if not unicodedata.combining(c))


def normalizar_produto(nome: str | None) -> str | None:
    """'  abacaxi  HAVAÍ ' -> 'ABACAXI HAVAI' (chave de comparação entre fontes)."""
    if nome is None or not str(nome).strip():
        return None
    return re.sub(r"\s+", " ", remover_acentos(str(nome)).upper().strip())


def nome_exibicao(nome: str | None) -> str | None:
    """'ABACAXI HAVAÍ' -> 'Abacaxi Havaí' (para mostrar no app)."""
    if nome is None or not str(nome).strip():
        return None
    return re.sub(r"\s+", " ", str(nome).strip()).title()


def para_decimal(valor) -> float | None:
    """Converte o formato brasileiro '1.234,56' em 1234.56. Retorna None se inválido."""
    if valor is None or (isinstance(valor, float) and pd.isna(valor)):
        return None
    if isinstance(valor, (int, float)):
        return float(valor)
    texto = str(valor).strip().replace("R$", "").strip()
    if texto in {"", "-", "--", "N/D", "ND"}:
        return None
    if "," in texto:
        texto = texto.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+", texto):  # '1.200' = mil e duzentos
        texto = texto.replace(".", "")
    try:
        return float(texto)
    except ValueError:
        return None


def validar(registros: list[dict], data_solicitada: date, preco_maximo: float = 5000.0,
            coletado_em: datetime | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Retorna (válidos, rejeitados)."""
    coletado_em = coletado_em or datetime.now()
    if not registros:
        return pd.DataFrame(columns=COLUNAS_SAIDA), pd.DataFrame(columns=["motivo"])

    df = pd.DataFrame(registros)
    df["produto_bruto"] = df["produto"]
    df["produto_normalizado"] = df["produto"].map(normalizar_produto)
    df["produto"] = df["produto"].map(nome_exibicao)
    df["classificacao"] = (df["classificacao"].fillna("").astype(str).str.strip()
                           .replace({"-": "", "--": ""}).str.upper())
    df["unidade_original"] = df["unidade"].fillna("").astype(str).str.strip().str.upper()
    df["unidade"] = df["unidade_original"].map(lambda u: UNIDADES.get(u, u.lower() or None))
    for col in ("preco_minimo", "preco_comum", "preco_maximo", "peso_kg"):
        df[col] = df[col].map(para_decimal)
    df["data_cotacao"] = pd.to_datetime(df["data_cotacao"], errors="coerce").dt.date
    df["coletado_em"] = coletado_em

    # ---- regras de decisão: cada linha acumula a lista de motivos de rejeição
    motivos: list[list[str]] = [[] for _ in range(len(df))]

    def regra(mascara: pd.Series, texto: str):
        for i in mascara[mascara.fillna(False)].index:
            motivos[df.index.get_loc(i)].append(texto)

    regra(df["produto_normalizado"].isna(), "R6 produto sem nome")
    regra(df["preco_comum"].isna(), "R1 preço comum ausente")
    for col in ("preco_minimo", "preco_comum", "preco_maximo"):
        regra(df[col].notna() & (df[col] <= 0), f"R2 {col} zero ou negativo")
    regra((df["preco_minimo"] > df["preco_comum"]) | (df["preco_comum"] > df["preco_maximo"]),
          "R3 faixa de preço incoerente")
    regra(df["preco_maximo"] > preco_maximo, f"R4 preço acima de R$ {preco_maximo:,.2f}")
    regra(df["data_cotacao"].isna(), "R5 data da cotação ausente")
    regra(df["data_cotacao"].notna() & (df["data_cotacao"] > coletado_em.date()), "R5 data da cotação no futuro")
    regra(df["data_cotacao"].notna() & (df["data_cotacao"] != data_solicitada),
          "R5 data diferente da solicitada")

    chave = ["fonte", "produto_normalizado", "classificacao", "unidade", "data_cotacao"]
    regra(df.duplicated(subset=chave, keep="first"), "R7 registro duplicado")

    df["motivo"] = ["; ".join(m) for m in motivos]
    rejeitados = df[df["motivo"] != ""].copy()
    validos = df[df["motivo"] == ""].copy()

    # Preço por kg: 'Quilo' informa quantos kg tem a unidade de venda (ex.: engradado de 12 kg)
    peso_ok = validos["peso_kg"].notna() & (validos["peso_kg"] > 0)
    validos["preco_kg"] = (validos["preco_comum"] / validos["peso_kg"].where(peso_ok)).round(2)

    return validos[COLUNAS_SAIDA].reset_index(drop=True), rejeitados.reset_index(drop=True)

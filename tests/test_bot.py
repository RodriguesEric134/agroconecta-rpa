from datetime import date, datetime
from pathlib import Path

import pandas as pd
import pytest

from bot_cotacoes.alertas import gerar_alertas
from bot_cotacoes.coletor_ceagesp import (LayoutAlteradoError, ResultadoConsulta, extrair_datas_disponiveis,
                                          extrair_tabela)
from bot_cotacoes.config import Config
from bot_cotacoes.main import executar
from bot_cotacoes.repositorio import Repositorio, cotacoes, cotacoes_rejeitadas
from bot_cotacoes.validador import normalizar_produto, para_decimal, validar

FIXTURE = (Path(__file__).parent / "fixtures" / "ceagesp_frutas_04112026.html").read_text(encoding="utf-8")


# ----------------------------------------------------------------- parsing
def test_extrai_datas_disponiveis():
    datas = extrair_datas_disponiveis(FIXTURE)
    assert date(2026, 11, 4) in datas["FRUTAS"]
    assert datas["ORGÂNICOS"] == []           # categoria sem boletim (null no portal)


def test_extrai_tabela_real():
    categoria, data_boletim, regs = extrair_tabela(FIXTURE)
    assert categoria == "FRUTAS"
    assert data_boletim == date(2026, 11, 4)
    assert regs[0]["produto"] == "ABACATE AVOCADO/HASS/FUERTE"
    assert regs[0]["preco_comum"] == "13,73"


def test_layout_alterado_e_detectado():
    html = FIXTURE.replace("<b>Comum</b>", "<b>Preço</b>")
    with pytest.raises(LayoutAlteradoError):
        extrair_tabela(html)


# ----------------------------------------------------------------- validação
def test_conversao_decimal_brasileira():
    assert para_decimal("1.234,56") == 1234.56
    assert para_decimal("6,3") == 6.3
    assert para_decimal("1.200") == 1200
    assert para_decimal("-") is None
    assert para_decimal("abc") is None


def test_normalizacao_produto():
    assert normalizar_produto("  abacaxi   HAVAÍ ") == "ABACAXI HAVAI"


def _reg(**kw):
    base = dict(produto="TOMATE", classificacao="EXTRA AA", unidade="KG", preco_minimo="5,00",
                preco_comum="6,00", preco_maximo="7,00", peso_kg="1", grupo="LEGUMES",
                data_cotacao=date(2026, 11, 4), fonte="CEAGESP", localidade="CEAGESP - SP")
    base.update(kw)
    return base


def test_regras_de_validacao():
    regs = [
        _reg(),                                                       # válido
        _reg(produto="ALFACE", unidade="ENG", preco_comum="24", preco_minimo="20",
             preco_maximo="30", peso_kg="12"),                        # válido, preço/kg = 2
        _reg(produto="CENOURA", preco_comum=""),                      # R1
        _reg(produto="BATATA", preco_minimo="0", preco_comum="0"),    # R2
        _reg(produto="CEBOLA", preco_minimo="9"),                     # R3
        _reg(produto="ALHO", preco_maximo="99999", preco_comum="9000", preco_minimo="8000"),  # R4
        _reg(produto="PIMENTÃO", data_cotacao=date(2026, 11, 3)),     # R5
        _reg(produto="  tomate "),                                    # R7 duplicado do 1º
    ]
    validos, rejeitados = validar(regs, date(2026, 11, 4), coletado_em=datetime(2026, 11, 6, 8))
    assert list(validos["produto"]) == ["Tomate", "Alface"]
    assert validos.loc[1, "unidade"] == "engradado"
    assert validos.loc[1, "preco_kg"] == 2.0
    motivos = " | ".join(rejeitados["motivo"])
    for codigo in ("R1", "R2", "R3", "R4", "R5", "R7"):
        assert codigo in motivos


# ----------------------------------------------------------------- alertas
def test_alerta_de_alta():
    hist = pd.DataFrame([
        dict(fonte="CEAGESP", produto="Tomate", produto_normalizado="TOMATE", classificacao="", unidade="kg",
             unidade_original="KG", data_cotacao=date(2026, 11, d), preco_comum=p)
        for d, p in [(2, 5.0), (3, 5.0), (4, 5.2), (5, 7.0)]
    ])
    alertas = gerar_alertas(hist, date(2026, 11, 5), limite_pct=15)
    assert len(alertas) == 1 and alertas[0]["tipo"] == "ALTA"
    assert alertas[0]["variacao_pct"] == pytest.approx(38.2, abs=0.1)


# ----------------------------------------------------------------- fluxo ponta a ponta (sem rede)
class ColetorFalso:
    """Simula o portal: FRUTAS ok, LEGUMES com erro, VERDURAS sem boletim."""

    def datas_disponiveis(self):
        return {"FRUTAS": [date(2026, 11, 4)], "LEGUMES": [date(2026, 11, 4)], "VERDURAS": []}

    def consultar(self, grupo, data_boletim):
        if grupo == "LEGUMES":
            raise LayoutAlteradoError("tabela mudou")
        _, d, regs = extrair_tabela(FIXTURE)
        for r in regs:
            r.update(grupo=grupo, data_cotacao=d, fonte="CEAGESP", localidade="CEAGESP - SP")
        return ResultadoConsulta(grupo, data_boletim, d, regs)


def test_execucao_ponta_a_ponta(tmp_path):
    cfg = Config(database_url=f"sqlite:///{(tmp_path / 't.db').as_posix()}", log_dir=tmp_path,
                 grupos=["FRUTAS", "LEGUMES", "VERDURAS"], janela_dias=10)
    repo = Repositorio(cfg.database_url)
    resumo = executar(cfg, coletor=ColetorFalso(), repo=repo, hoje=date(2026, 11, 6))
    assert resumo["status"] == "SUCESSO_PARCIAL"
    assert resumo["registros_validos"] == 12 and repo.contar(cotacoes) == 12
    assert len(resumo["erros"]) == 1
    assert list(tmp_path.glob("rpa_cotacoes_*.log"))

    # 2ª execução: incremental — nada novo para FRUTAS
    resumo2 = executar(cfg, coletor=ColetorFalso(), repo=repo, hoje=date(2026, 11, 6))
    assert resumo2["registros_coletados"] == 0
    assert repo.contar(cotacoes) == 12 and repo.contar(cotacoes_rejeitadas) == 0

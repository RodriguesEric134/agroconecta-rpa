"""Coleta de cotações no portal público da CEAGESP (https://ceagesp.gov.br/cotacoes/).

Como o portal funciona (verificado em 11/2026):
* GET /cotacoes/ devolve o formulário e uma variável JS ``Grupos`` com as datas de
  boletim disponíveis por categoria: ``var Grupos = {"FRUTAS": ["23/10/2026", ...]}``.
* POST /cotacoes/ com ``cot_grupo`` e ``cot_data`` (dd/mm/aaaa) devolve a tabela
  ``table.contacao_lista`` com as colunas:
  Produto | Classificação | Uni/Peso | Menor | Comum | Maior | Quilo
* robots.txt permite /cotacoes/ (``User-agent: * / Allow: /``).
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import date, datetime

import requests
from bs4 import BeautifulSoup

from .config import CONFIG, Config

log = logging.getLogger(__name__)

try:  # usa os certificados do Windows/macOS (antivírus ou proxy que inspeciona HTTPS)
    import truststore

    truststore.inject_into_ssl()
except ImportError:  # pragma: no cover
    pass

FONTE = "CEAGESP"
LOCALIDADE = "CEAGESP - Entreposto Terminal de São Paulo (ETSP)"
COLUNAS_ESPERADAS = ["Produto", "Classificação", "Uni/Peso", "Menor", "Comum", "Maior", "Quilo"]


class FonteIndisponivelError(Exception):
    """Portal fora do ar ou respondendo com erro após todas as tentativas."""


class LayoutAlteradoError(Exception):
    """A estrutura HTML mudou — o robô não deve gravar dados possivelmente errados."""


@dataclass
class ResultadoConsulta:
    grupo: str
    data_solicitada: date
    data_boletim: date | None
    registros: list[dict]


# --------------------------------------------------------------------------- #
# Funções de parsing (puras — testáveis sem rede)
# --------------------------------------------------------------------------- #
def extrair_datas_disponiveis(html: str) -> dict[str, list[date]]:
    m = re.search(r"var\s+Grupos\s*=\s*(\{.*?\});", html, re.S)
    if not m:
        raise LayoutAlteradoError("Variável 'Grupos' não encontrada na página de cotações")
    bruto = json.loads(m.group(1))
    return {
        grupo: sorted(datetime.strptime(d, "%d/%m/%Y").date() for d in (datas or []))
        for grupo, datas in bruto.items()
    }


def extrair_tabela(html: str) -> tuple[str | None, date | None, list[dict]]:
    soup = BeautifulSoup(html, "html.parser")
    tabela = soup.find("table", class_="contacao_lista")
    if tabela is None:
        return None, None, []  # sem boletim para a data/grupo

    linhas = tabela.find_all("tr")
    cabecalho_info = linhas[0].get_text(" ", strip=True) if linhas else ""
    m_cat = re.search(r"Categoria:\s*(.+?)\s+Data:", cabecalho_info)
    m_data = re.search(r"Data:\s*(\d{2}/\d{2}/\d{4})", cabecalho_info)
    categoria = m_cat.group(1).strip() if m_cat else None
    data_boletim = datetime.strptime(m_data.group(1), "%d/%m/%Y").date() if m_data else None

    cabecalho = [td.get_text(strip=True) for td in linhas[1].find_all("td")] if len(linhas) > 1 else []
    if cabecalho != COLUNAS_ESPERADAS:
        raise LayoutAlteradoError(f"Colunas inesperadas: {cabecalho}")

    registros = []
    for tr in linhas[2:]:
        celulas = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
        if not any(celulas):
            continue
        registros.append(dict(zip(
            ["produto", "classificacao", "unidade", "preco_minimo", "preco_comum", "preco_maximo", "peso_kg"],
            celulas + [None] * (7 - len(celulas)),
        )))
    return categoria, data_boletim, registros


# --------------------------------------------------------------------------- #
# Cliente HTTP
# --------------------------------------------------------------------------- #
class ColetorCeagesp:
    def __init__(self, config: Config = CONFIG, sessao: requests.Session | None = None):
        self.cfg = config
        self.sessao = sessao or requests.Session()
        self.sessao.headers.update({"User-Agent": config.user_agent})

    def _requisitar(self, metodo: str, **kwargs) -> str:
        ultimo_erro: Exception | None = None
        for tentativa in range(1, self.cfg.tentativas + 1):
            try:
                resp = self.sessao.request(metodo, self.cfg.ceagesp_url, timeout=self.cfg.timeout, **kwargs)
                resp.raise_for_status()
                if "charset" not in resp.headers.get("content-type", "").lower():
                    resp.encoding = "utf-8"  # o portal é UTF-8; evita o padrão ISO-8859-1 do requests
                return resp.text
            except requests.RequestException as exc:
                ultimo_erro = exc
                espera = 2 ** tentativa
                log.warning("Tentativa %s/%s falhou (%s). Aguardando %ss", tentativa, self.cfg.tentativas, exc, espera)
                time.sleep(espera)
        raise FonteIndisponivelError(f"CEAGESP indisponível: {ultimo_erro}")

    def datas_disponiveis(self) -> dict[str, list[date]]:
        return extrair_datas_disponiveis(self._requisitar("GET"))

    def consultar(self, grupo: str, data_boletim: date) -> ResultadoConsulta:
        html = self._requisitar("POST", data={"cot_grupo": grupo, "cot_data": data_boletim.strftime("%d/%m/%Y")})
        time.sleep(self.cfg.pausa_entre_requisicoes)  # cortesia com o servidor público
        categoria, data_lida, registros = extrair_tabela(html)
        if categoria and categoria.upper() != grupo.upper():
            raise LayoutAlteradoError(f"Pedido {grupo}, recebido {categoria}")
        for r in registros:
            r.update({"grupo": grupo, "data_cotacao": data_lida, "fonte": FONTE, "localidade": LOCALIDADE})
        return ResultadoConsulta(grupo, data_boletim, data_lida, registros)

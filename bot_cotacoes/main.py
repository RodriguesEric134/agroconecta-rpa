"""Orquestrador do robô de cotações (ponto de entrada).

Fluxo (ver docs/processo_cotacoes.bpmn):
  1. Inicia execução, gera id e abre o log
  2. Lê no portal as datas de boletim disponíveis por categoria
  3. PARA CADA categoria configurada:
       - categoria sem boletins?            -> registra aviso e pula
       PARA CADA data dentro da janela:
         - data já coletada no banco?        -> pula (coleta incremental)
         - consulta o portal (com retentativas)
         - valida e padroniza (pandas)
         - grava válidos (upsert) e rejeitados
         - erro nesta categoria/data?        -> registra, segue para a próxima
  4. Gera alertas de variação de preço
  5. Define status final, grava resumo no banco e no .log

Uso:
  python -m bot_cotacoes                     # execução única
  python -m bot_cotacoes --agendar           # fica em execução e roda todo dia no horário configurado
  python -m bot_cotacoes --grupos FRUTAS --dias 7
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
import uuid
from dataclasses import replace
from datetime import date, datetime, timedelta

from .alertas import gerar_alertas
from .coletor_ceagesp import FONTE, ColetorCeagesp, FonteIndisponivelError, LayoutAlteradoError
from .config import CONFIG, Config
from .logger import configurar_logs
from .repositorio import Repositorio
from .validador import validar

log = logging.getLogger("bot_cotacoes")


def executar(cfg: Config = CONFIG, coletor: ColetorCeagesp | None = None,
             repo: Repositorio | None = None, hoje: date | None = None) -> dict:
    execucao_id = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    arquivo_log = configurar_logs(cfg.log_dir, execucao_id)
    hoje = hoje or date.today()
    inicio = datetime.now()
    resumo = {"execucao_id": execucao_id, "inicio": inicio, "fonte": FONTE,
              "registros_coletados": 0, "registros_validos": 0, "registros_rejeitados": 0,
              "alertas_gerados": 0, "erros": [], "detalhes": []}

    log.info("=== Início da execução | fonte=%s | grupos=%s | janela=%s dias | log=%s",
             FONTE, ",".join(cfg.grupos), cfg.janela_dias, arquivo_log)
    repo = repo or Repositorio(cfg.database_url)
    coletor = coletor or ColetorCeagesp(cfg)

    try:
        disponiveis = coletor.datas_disponiveis()
    except (FonteIndisponivelError, LayoutAlteradoError) as exc:
        log.error("Falha ao abrir o portal: %s", exc)
        resumo["erros"].append({"etapa": "abrir_portal", "erro": str(exc)})
        return _finalizar(repo, resumo, "FALHA")

    datas_processadas: set[date] = set()
    limite = hoje - timedelta(days=cfg.janela_dias)

    for grupo in cfg.grupos:                                         # laço 1: categorias
        datas = [d for d in disponiveis.get(grupo, []) if limite <= d < hoje + timedelta(days=1)]
        if not datas:                                                # decisão: há boletim?
            log.warning("Grupo %s: nenhum boletim disponível nos últimos %s dias", grupo, cfg.janela_dias)
            resumo["detalhes"].append({"grupo": grupo, "status": "SEM_BOLETIM"})
            continue
        ja_coletadas = repo.datas_ja_coletadas(FONTE, grupo)
        pendentes = [d for d in datas if d not in ja_coletadas]      # decisão: incremental
        log.info("Grupo %s: %s boletins disponíveis, %s pendentes", grupo, len(datas), len(pendentes))

        for data_boletim in pendentes:                               # laço 2: datas
            try:
                resultado = coletor.consultar(grupo, data_boletim)
                if not resultado.registros:
                    log.warning("Grupo %s %s: boletim vazio", grupo, data_boletim)
                    resumo["detalhes"].append({"grupo": grupo, "data": str(data_boletim), "status": "VAZIO"})
                    continue
                validos, rejeitados = validar(resultado.registros, data_boletim, cfg.preco_maximo_plausivel)
                gravados = repo.salvar_cotacoes(validos, execucao_id)
                repo.salvar_rejeitados(rejeitados, execucao_id)

                resumo["registros_coletados"] += len(resultado.registros)
                resumo["registros_validos"] += gravados
                resumo["registros_rejeitados"] += len(rejeitados)
                datas_processadas.add(data_boletim)
                resumo["detalhes"].append({"grupo": grupo, "data": str(data_boletim), "status": "OK",
                                           "coletados": len(resultado.registros), "validos": gravados,
                                           "rejeitados": len(rejeitados)})
                log.info("Grupo %s %s: coletados=%s válidos=%s rejeitados=%s",
                         grupo, data_boletim, len(resultado.registros), gravados, len(rejeitados))
                if len(rejeitados):
                    for motivo, qtd in rejeitados["motivo"].value_counts().items():
                        log.warning("   rejeição '%s': %s registro(s)", motivo, qtd)
            except (FonteIndisponivelError, LayoutAlteradoError) as exc:   # exceção de negócio/fonte
                log.error("Grupo %s %s: %s", grupo, data_boletim, exc)
                resumo["erros"].append({"grupo": grupo, "data": str(data_boletim), "erro": str(exc)})
            except Exception as exc:  # noqa: BLE001 — falha inesperada não derruba as demais
                log.exception("Grupo %s %s: erro inesperado", grupo, data_boletim)
                resumo["erros"].append({"grupo": grupo, "data": str(data_boletim),
                                        "erro": f"{type(exc).__name__}: {exc}"})

    # Alertas de preço para cada boletim novo
    try:
        for d in sorted(datas_processadas):
            alertas = gerar_alertas(repo.historico(FONTE, d), d, cfg.alerta_variacao_pct, cfg.alerta_janela_cotacoes)
            resumo["alertas_gerados"] += repo.salvar_alertas(alertas)
            for a in alertas[:5]:
                log.info("ALERTA %s", a["mensagem"])
    except Exception as exc:  # noqa: BLE001
        log.exception("Falha ao gerar alertas")
        resumo["erros"].append({"etapa": "alertas", "erro": str(exc)})

    if resumo["erros"]:
        status = "SUCESSO_PARCIAL" if resumo["registros_validos"] else "FALHA"
    else:
        status = "SUCESSO" if resumo["registros_validos"] else "SEM_NOVIDADES"
    return _finalizar(repo, resumo, status)


def _finalizar(repo: Repositorio, resumo: dict, status: str) -> dict:
    resumo["fim"] = datetime.now()
    resumo["status"] = status
    try:
        repo.registrar_execucao(resumo)
    except Exception:  # noqa: BLE001
        log.exception("Não foi possível registrar a execução no banco")
    duracao = (resumo["fim"] - resumo["inicio"]).total_seconds()
    log.info("=== Fim | status=%s | coletados=%s | válidos=%s | rejeitados=%s | alertas=%s | erros=%s | %.1fs",
             status, resumo["registros_coletados"], resumo["registros_validos"], resumo["registros_rejeitados"],
             resumo["alertas_gerados"], len(resumo["erros"]), duracao)
    return resumo


def agendar(cfg: Config):
    import schedule

    def tarefa():
        try:
            executar(cfg)
        except Exception:  # noqa: BLE001 — o agendador nunca pode morrer
            logging.getLogger("bot_cotacoes").exception("Execução agendada falhou")

    schedule.every().day.at(cfg.horario_agendado).do(tarefa)
    print(f"Robô agendado para todos os dias às {cfg.horario_agendado}. Ctrl+C para sair.")
    while True:
        schedule.run_pending()
        time.sleep(30)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Robô de cotações agrícolas — AgroConecta")
    parser.add_argument("--grupos", help="Categorias separadas por vírgula (ex.: FRUTAS,LEGUMES)")
    parser.add_argument("--dias", type=int, help="Janela de dias para buscar boletins")
    parser.add_argument("--agendar", action="store_true", help="Mantém o robô rodando diariamente")
    args = parser.parse_args(argv)

    cfg = CONFIG
    if args.grupos:
        cfg = replace(cfg, grupos=[g.strip().upper() for g in args.grupos.split(",")])
    if args.dias:
        cfg = replace(cfg, janela_dias=args.dias)

    if args.agendar:
        agendar(cfg)
        return 0
    resumo = executar(cfg)
    return 0 if resumo["status"] in {"SUCESSO", "SUCESSO_PARCIAL", "SEM_NOVIDADES"} else 1


if __name__ == "__main__":
    sys.exit(main())

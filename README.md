# RPA — Robô de Cotações Agrícolas do AgroConecta (n8n)

O robô substitui a consulta manual diária ao portal de preços da **CEAGESP**. Todo dia às 07:30 ele:
1. coleta os boletins de FRUTAS, LEGUMES, VERDURAS e DIVERSOS;
2. valida e padroniza os dados;
3. grava tudo no banco do MVP (**Supabase**);
4. detecta variações de preço relevantes e **avisa os produtores no Telegram**;
5. registra cada execução em tabelas de log.

```
                       n8n Cloud (gsultimosemestreultimoano.app.n8n.cloud)
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⏰ 07:30 ─► Robô de cotações CEAGESP ─────────────► Supabase (Postgres)              │
│             portal → laço por boletim → valida     cotacoes · cotacoes_rejeitadas    │
│             → grava → alertas → log                alertas_preco · execucoes_rpa     │
│                   │ falha inesperada               logs_rpa · assinantes_telegram    │
│                   ▼                                        │                         │
│             Tratamento de erros ──► Telegram (admins)      ▼                         │
│                                                     vw_ultimas_cotacoes ─► MVP       │
│ 📲 Bot do Telegram: /start · /preco tomate · /parar ◄──► produtores                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Workflows

| Workflow | ID | Status | Função |
|---|---|---|---|
| **AgroConecta \| Robô de cotações CEAGESP** | `WxXWYjOO1O65rFeZ` | ativo (07:30, fuso de Brasília) | Processo principal: 33 nós |
| **AgroConecta \| Tratamento de erros do robô** | `4R3YeNUIvy51ffep` | ativo | *Error workflow* do robô: marca FALHA, grava log e avisa os admins |
| **AgroConecta \| Bot do Telegram** | `Uc6FQ0wxoGH15jum` | ativo | Cadastro de produtores e consulta de preços |
| **AgroConecta \| Setup do banco** | `zANlM1hCSjvgK00c` | manual | Cria as tabelas no Supabase ([schema_supabase.sql](n8n/schema_supabase.sql)) |

O código-fonte de cada workflow (Workflow SDK do n8n) está em [`n8n/`](n8n/).

## Requisitos da disciplina × implementação no n8n

| Requisito | Nós do n8n |
|---|---|
| **Fluxo ponta a ponta** | Agenda → portal → laço por boletim → validação → banco → alertas → Telegram → log |
| **Regras de decisão** | IF *Boletim já coletado?* (coleta incremental) · IF *Há registros rejeitados?* · IF *Variação de preço relevante?* · Switch *Qual comando?* (bot) · regras R1–R7 e status final no Code |
| **Laços de repetição** | *Percorrer boletins* (Loop Over Items: categoria × data) · laço por linha da tabela dentro do *Validar e padronizar* |
| **Tratamento de exceções** | *Retry on fail* (3 tentativas, intervalo de 5 s) nas requisições · saída de erro do *Acessar portal* → FALHA + aviso aos admins · saída de erro do *Consultar boletim* e do *Validar* → registra o erro e o laço **continua** · `LAYOUT_ALTERADO` (o robô não grava dado se o HTML mudar) · *Error workflow* para falhas inesperadas |
| **Logs** | `execucoes_rpa` (1 linha por execução: status, contagens, erros, detalhes) + `logs_rpa` (linhas INFO/WARNING/ERROR) + histórico de execuções do n8n |
| **Entrega ao MVP** | Tabelas no Supabase + view `vw_ultimas_cotacoes`, com leitura pública via API REST do Supabase (RLS) + alertas no Telegram |

### Regras de validação (nó *Validar e padronizar (R1–R7)*)
| Código | Regra |
|---|---|
| R1 | preço comum ausente |
| R2 | preço zero ou negativo |
| R3 | faixa incoerente (mínimo > comum ou comum > máximo) |
| R4 | preço acima do teto plausível (R$ 5.000) |
| R5 | data ausente, futura ou diferente da solicitada |
| R6 | produto sem nome |
| R7 | registro duplicado |

Padronizações aplicadas:
- **Nome do produto:** sem acento e em maiúsculas para usar como chave, e em *Title Case* para exibição.
- **Unidades:** `KG`→kg, `ENG`→engradado, `MC`→maço, `CX`→caixa…
- **Números:** formato brasileiro (`1.234,56`).
- **Preço por kg:** calculado a partir da coluna "Quilo" do portal.

### Status da execução
| Status | Quando |
|---|---|
| `SUCESSO` | gravou cotações novas, sem erros |
| `SUCESSO_PARCIAL` | gravou cotações, mas algum boletim falhou |
| `SEM_NOVIDADES` | nenhum boletim novo desde a última coleta |
| `FALHA` | portal fora do ar, nada gravado ou erro inesperado (*error workflow*) |

## Resultados (11/11/2026)
| Execução | Resultado |
|---|---|
| 1ª (carga inicial) | `SUCESSO`: **20 boletins**, **2.296 cotações** válidas, 0 rejeitadas, **300 alertas**, 22 linhas de log, 52 s |
| 2ª (logo depois) | `SEM_NOVIDADES`: todos os boletins já estavam no banco, 3 s |

## Como usar
- **Receber alertas:** no Telegram, abra o bot e envie `/start`. A primeira pessoa cadastrada vira **administrador** e também recebe os avisos de falha.
- **Consultar preço:** `/preco tomate`.
- **Rodar o robô na hora:** no n8n, abra o workflow do robô e clique em *Execute workflow* (gatilho *Executar agora (demonstração)*).
- **Recriar o banco:** rode o workflow *Setup do banco*. Ele é idempotente: pode rodar de novo sem perder dados.

### Consultas úteis (Supabase → SQL Editor)
```sql
SELECT execucao_id, status, inicio, fim, boletins_processados, registros_validos, alertas_gerados
FROM execucoes_rpa ORDER BY inicio DESC;

SELECT nivel, etapa, mensagem, criado_em FROM logs_rpa
WHERE execucao_id = (SELECT max(execucao_id::int)::text FROM execucoes_rpa) ORDER BY id;

SELECT data_cotacao, tipo, mensagem FROM alertas_preco ORDER BY data_cotacao DESC, abs(variacao_pct) DESC LIMIT 20;
```

## Limites do n8n Cloud
- **Tempo de execução:** máximo de **180 s** por execução. A carga inicial levou 52 s, e as execuções diárias levam de 5 a 15 s.
- **Trial:** se o plano for trial, exporte os workflows (menu ⋯ → *Download*) para `rpa/n8n/exports/` antes da entrega.

## Versão Python (referência)
O pacote [`bot_cotacoes/`](bot_cotacoes/) é a primeira versão do robô, em Python. Ela tem as mesmas regras e serviu de base para o fluxo no n8n.
- Tem testes automatizados: `python -m pytest`, com 8 testes.
- Tem uma API FastAPI (`api/app.py`).
- Continua funcional como alternativa local: `python -m bot_cotacoes`.

## Roteiro do vídeo (≤ 3 min)
1. **(0:00)** O problema: o produtor consulta preços manualmente no portal da CEAGESP.
2. **(0:20)** O diagrama BPMN do processo.
3. **(0:40)** O fluxo no n8n: execução manual ao vivo, com os nós acendendo e o laço percorrendo os boletins.
4. **(1:30)** No Supabase: as tabelas `cotacoes`, `execucoes_rpa` e `logs_rpa`.
5. **(2:00)** No Telegram: o alerta de preço chegando e o comando `/preco tomate` respondendo.
6. **(2:30)** A 2ª execução termina com `SEM_NOVIDADES` (incremental) e mostra o tratamento de erros (*error workflow*).

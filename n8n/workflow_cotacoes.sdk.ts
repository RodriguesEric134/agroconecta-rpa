import { workflow, node, trigger, sticky, ifElse, splitInBatches, nextBatch, expr } from '@n8n/workflow-sdk';

const PG = { postgres: { id: 'vHkjYCcR97jtmaam', name: 'Postgres account' } };
const TG = { telegramApi: { id: '9QXOYJilBHrOE88q', name: 'Telegram account' } };

const agenda = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.2,
  config: {
    name: 'Todo dia às 07:30',
    position: [0, 200],
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 7, triggerAtMinute: 30 }] } }
  },
  output: [{ timestamp: '2026-11-11T07:30:00-03:00' }]
});

const manual = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Executar agora (demonstração)', position: [0, 400] },
  output: [{}]
});

const configurar = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Configurar execução',
    position: [240, 300],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'c1', name: 'execucao_id', value: expr('{{ $execution.id }}'), type: 'string' },
          { id: 'c2', name: 'modo', value: expr('{{ $execution.mode }}'), type: 'string' },
          { id: 'c3', name: 'url', value: 'https://ceagesp.gov.br/cotacoes/', type: 'string' },
          { id: 'c4', name: 'grupos', value: expr('{{ ["FRUTAS", "LEGUMES", "VERDURAS", "DIVERSOS"] }}'), type: 'array' },
          { id: 'c5', name: 'janela_dias', value: 15, type: 'number' },
          { id: 'c6', name: 'limite_alerta_pct', value: 15, type: 'number' },
          { id: 'c7', name: 'preco_maximo', value: 5000, type: 'number' }
        ]
      }
    }
  },
  output: [{ execucao_id: '101', modo: 'manual', url: 'https://ceagesp.gov.br/cotacoes/', grupos: ['FRUTAS', 'LEGUMES', 'VERDURAS', 'DIVERSOS'], janela_dias: 15, limite_alerta_pct: 15, preco_maximo: 5000 }]
});

const registrarInicio = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Registrar início da execução',
    position: [480, 300],
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `WITH inicio AS (
  INSERT INTO execucoes_rpa (execucao_id, workflow, modo, inicio, status, fonte)
  VALUES ($1, $2, $3, now(), 'EM_EXECUCAO', 'CEAGESP')
  ON CONFLICT (execucao_id) DO UPDATE SET inicio = now(), status = 'EM_EXECUCAO'
  RETURNING execucao_id
)
INSERT INTO logs_rpa (execucao_id, nivel, etapa, mensagem)
SELECT execucao_id, 'INFO', 'inicio', $4 FROM inicio
RETURNING execucao_id;`,
      options: {
        queryReplacement: expr('{{ [$json.execucao_id, $workflow.name, $json.modo, "Início da execução | fonte=CEAGESP | grupos=" + $json.grupos.join(",") + " | janela=" + $json.janela_dias + " dias | modo=" + $json.modo] }}')
      }
    }
  },
  output: [{ execucao_id: '101' }]
});

const acessarPortal = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Acessar portal CEAGESP',
    position: [720, 300],
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    onError: 'continueErrorOutput',
    parameters: {
      method: 'GET',
      url: expr('{{ $("Configurar execução").first().json.url }}'),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'User-Agent', value: 'AgroConecta-RPA/1.0 (projeto academico FIAP)' }] },
      options: {
        timeout: 30000,
        response: { response: { responseFormat: 'text', outputPropertyName: 'data' } }
      }
    }
  },
  output: [{ data: '<html>... var Grupos = {"FRUTAS":["04\\/11\\/2026"]}; ...</html>' }]
});

const registrarFalhaPortal = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Portal indisponível: registrar FALHA',
    position: [960, 520],
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `WITH falha AS (
  UPDATE execucoes_rpa
     SET fim = now(), status = 'FALHA',
         erros = jsonb_build_array(jsonb_build_object('etapa', 'abrir_portal', 'erro', $2::text))
   WHERE execucao_id = $1
  RETURNING execucao_id
)
INSERT INTO logs_rpa (execucao_id, nivel, etapa, mensagem)
SELECT execucao_id, 'ERROR', 'abrir_portal', 'Portal CEAGESP indisponível após 3 tentativas: ' || $2 FROM falha
RETURNING execucao_id;`,
      options: {
        queryReplacement: expr('{{ [$("Configurar execução").first().json.execucao_id, String($json.error?.message ?? $json.error ?? "erro desconhecido")] }}')
      }
    }
  },
  output: [{ execucao_id: '101' }]
});

const buscarAdminsPortal = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Buscar administradores',
    position: [1200, 520],
    credentials: PG,
    executeOnce: true,
    parameters: { operation: 'executeQuery', query: 'SELECT chat_id FROM assinantes_telegram WHERE ativo AND admin;' }
  },
  output: [{ chat_id: 123456789 }]
});

const avisarAdminsPortal = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Avisar administradores (Telegram)',
    position: [1440, 520],
    credentials: TG,
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('⚠️ <b>Robô de cotações — FALHA</b>\nO portal da CEAGESP não respondeu após 3 tentativas.\nExecução: {{ $("Configurar execução").first().json.execucao_id }}\nA coleta será tentada novamente amanhã às 07:30.'),
      additionalFields: { appendAttribution: false, parse_mode: 'HTML' }
    }
  },
  output: [{ ok: true }]
});

const lerDatas = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Ler datas de boletim disponíveis',
    position: [960, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// O portal publica no HTML a variável JS "Grupos" com as datas de boletim de cada categoria.
const cfg = $('Configurar execução').first().json;
const html = $input.first().json.data || '';
const m = html.match(/var\\s+Grupos\\s*=\\s*(\\{[\\s\\S]*?\\});/);
if (!m) {
  throw new Error('LAYOUT_ALTERADO: variável Grupos não encontrada na página de cotações');
}
const grupos = JSON.parse(m[1]);
const hoje = $now.setZone('America/Sao_Paulo').startOf('day');
const limite = hoje.minus({ days: cfg.janela_dias });
const saida = [];
for (const grupo of cfg.grupos) {
  for (const d of (grupos[grupo] || [])) {
    const partes = d.split('/');
    const iso = partes[2] + '-' + partes[1] + '-' + partes[0];
    const dt = DateTime.fromISO(iso, { zone: 'America/Sao_Paulo' });
    if (dt >= limite && dt <= hoje) {
      saida.push({ json: { grupo: grupo, data_br: d, data_iso: iso } });
    }
  }
}
return saida;`
    }
  },
  output: [{ grupo: 'FRUTAS', data_br: '04/11/2026', data_iso: '2026-11-04' }]
});

const consultarColetados = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Consultar boletins já coletados',
    position: [1200, 300],
    credentials: PG,
    executeOnce: true,
    alwaysOutputData: true,
    parameters: {
      operation: 'executeQuery',
      query: `SELECT DISTINCT grupo, to_char(data_cotacao, 'YYYY-MM-DD') AS data_iso
FROM cotacoes
WHERE fonte = 'CEAGESP' AND data_cotacao >= current_date - $1::int;`,
      options: { queryReplacement: expr('{{ [$("Configurar execução").first().json.janela_dias + 5] }}') }
    }
  },
  output: [{ grupo: 'FRUTAS', data_iso: '2026-11-03' }]
});

const marcarPendentes = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Marcar boletins pendentes',
    position: [1440, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const coletados = new Set($('Consultar boletins já coletados').all().map(i => i.json.grupo + '|' + i.json.data_iso));
return $('Ler datas de boletim disponíveis').all().map(i => ({
  json: Object.assign({}, i.json, { ja_coletado: coletados.has(i.json.grupo + '|' + i.json.data_iso) })
}));`
    }
  },
  output: [{ grupo: 'FRUTAS', data_br: '04/11/2026', data_iso: '2026-11-04', ja_coletado: false }]
});

const percorrer = splitInBatches({
  version: 3,
  config: { name: 'Percorrer boletins', position: [1680, 300], parameters: { batchSize: 1, options: {} } }
});

const jaColetado = ifElse({
  version: 2.2,
  config: {
    name: 'Boletim já coletado?',
    position: [1920, 420],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr('{{ $json.ja_coletado }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      }
    }
  }
});

const pular = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Pular (coleta incremental)',
    position: [2160, 640],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'p1', name: 'grupo', value: expr('{{ $json.grupo }}'), type: 'string' },
          { id: 'p2', name: 'data_iso', value: expr('{{ $json.data_iso }}'), type: 'string' },
          { id: 'p3', name: 'status', value: 'JA_COLETADO', type: 'string' }
        ]
      }
    }
  },
  output: [{ grupo: 'FRUTAS', data_iso: '2026-11-03', status: 'JA_COLETADO' }]
});

const aguardar = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: {
    name: 'Aguardar 1s (cortesia com o portal)',
    position: [2160, 420],
    parameters: { resume: 'timeInterval', amount: 1, unit: 'seconds' }
  },
  output: [{ grupo: 'FRUTAS', data_br: '04/11/2026', data_iso: '2026-11-04', ja_coletado: false }]
});

const consultarBoletim = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Consultar boletim (POST)',
    position: [2400, 420],
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    onError: 'continueErrorOutput',
    parameters: {
      method: 'POST',
      url: expr('{{ $("Configurar execução").first().json.url }}'),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'User-Agent', value: 'AgroConecta-RPA/1.0 (projeto academico FIAP)' }] },
      sendBody: true,
      contentType: 'form-urlencoded',
      bodyParameters: {
        parameters: [
          { name: 'cot_grupo', value: expr('{{ $json.grupo }}') },
          { name: 'cot_data', value: expr('{{ $json.data_br }}') }
        ]
      },
      options: {
        timeout: 30000,
        response: { response: { responseFormat: 'text', outputPropertyName: 'data' } }
      }
    }
  },
  output: [{ data: '<table class="contacao_lista">...</table>' }]
});

const extrairTabela = node({
  type: 'n8n-nodes-base.html',
  version: 1.2,
  config: {
    name: 'Extrair tabela de preços (HTML)',
    position: [2640, 340],
    parameters: {
      operation: 'extractHtmlContent',
      sourceData: 'json',
      dataPropertyName: 'data',
      extractionValues: {
        values: [
          { key: 'cabecalho', cssSelector: 'table.contacao_lista tr:first-child', returnValue: 'text', returnArray: false },
          { key: 'colunas', cssSelector: 'table.contacao_lista tr.h td', returnValue: 'text', returnArray: true },
          { key: 'linhas', cssSelector: 'table.contacao_lista tr', returnValue: 'html', returnArray: true }
        ]
      },
      options: { trimValues: true, cleanUpText: true }
    }
  },
  output: [{ cabecalho: 'Categoria: FRUTAS Data: 04/11/2026', colunas: ['Produto', 'Classificação', 'Uni/Peso', 'Menor', 'Comum', 'Maior', 'Quilo'], linhas: ['<td class="ta_l">ABACATE</td><td>A</td><td>KG</td><td>12,51</td><td>13,73</td><td>14,94</td><td>1</td>'] }]
});

const validar = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validar e padronizar (R1–R7)',
    position: [2880, 340],
    onError: 'continueErrorOutput',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Regras de validação (registros reprovados vão para cotacoes_rejeitadas com o motivo):
// R1 preço comum ausente | R2 preço zero/negativo | R3 faixa incoerente (mín > comum > máx)
// R4 preço acima do teto plausível | R5 data ausente/futura/diferente da solicitada
// R6 produto sem nome | R7 registro duplicado
const cfg = $('Configurar execução').first().json;
const boletim = $('Percorrer boletins').first().json;
const ext = $input.first().json;

const ESPERADAS = ['Produto', 'Classificação', 'Uni/Peso', 'Menor', 'Comum', 'Maior', 'Quilo'];
const UNIDADES = { KG: 'kg', UN: 'unidade', UND: 'unidade', ENG: 'engradado', CX: 'caixa', MC: 'maço', 'MÇ': 'maço', BJ: 'bandeja', CBC: 'cabeça', SC: 'saco', PCT: 'pacote', DZ: 'dúzia', VS: 'vaso', M2: 'm²', 'TORRÃO': 'torrão', MALA: 'mala', TON: 'tonelada' };
const FONTE = 'CEAGESP';
const LOCALIDADE = 'CEAGESP - Entreposto Terminal de São Paulo (ETSP)';

function limpar(h) {
  return String(h == null ? '' : h).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\\s+/g, ' ').trim();
}
function semAcento(s) { return s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''); }
function normalizar(s) { return s ? semAcento(s).toUpperCase().replace(/\\s+/g, ' ').trim() : null; }
function exibir(s) { return s.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }
function decimal(v) {
  if (v == null) return null;
  let t = String(v).replace('R$', '').trim();
  if (['', '-', '--', 'N/D', 'ND'].includes(t)) return null;
  if (t.includes(',')) t = t.replace(/\\./g, '').replace(',', '.');
  else if (/^\\d{1,3}(\\.\\d{3})+$/.test(t)) t = t.replace(/\\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const base = { grupo: boletim.grupo, data_iso: boletim.data_iso };
const colunas = (ext.colunas || []).map(limpar);
const linhas = ext.linhas || [];

// Decisão: portal respondeu sem tabela -> não há boletim para esta data
if (linhas.length === 0) {
  return [{ json: Object.assign({}, base, { status: 'VAZIO', coletados: 0, qtd_validos: 0, qtd_rejeitados: 0, validos: [], rejeitados: [], motivos: {} }) }];
}
// Exceção de negócio: layout mudou -> não grava dado possivelmente errado
if (colunas.join('|') !== ESPERADAS.join('|')) {
  throw new Error('LAYOUT_ALTERADO: colunas recebidas = ' + colunas.join(' | '));
}
const cab = limpar(ext.cabecalho);
const mData = cab.match(/Data:\\s*(\\d{2})\\/(\\d{2})\\/(\\d{4})/);
const dataBoletim = mData ? mData[3] + '-' + mData[2] + '-' + mData[1] : null;
const mCat = cab.match(/Categoria:\\s*(.+?)\\s+Data:/);
if (mCat && mCat[1].trim().toUpperCase() !== boletim.grupo) {
  throw new Error('LAYOUT_ALTERADO: pedido ' + boletim.grupo + ', recebido ' + mCat[1]);
}

const hoje = $now.setZone('America/Sao_Paulo').toISODate();
const coletadoEm = $now.toISO();
const validos = [];
const rejeitados = [];
const vistos = {};
const motivos = {};
let coletados = 0;

for (const tr of linhas) {
  const tds = (tr.match(/<td[^>]*>[\\s\\S]*?<\\/td>/gi) || []).map(limpar);
  if (tds.length !== 7 || tds[0] === 'Produto') continue;
  coletados++;
  const produto = tds[0], classif = tds[1], unid = tds[2].toUpperCase();
  const r = {
    fonte: FONTE,
    localidade: LOCALIDADE,
    grupo: boletim.grupo,
    produto: produto ? exibir(produto) : null,
    produto_normalizado: normalizar(produto),
    classificacao: ['-', '--'].includes(classif) ? '' : classif.toUpperCase(),
    unidade_original: unid,
    unidade: UNIDADES[unid] || (unid ? unid.toLowerCase() : null),
    preco_minimo: decimal(tds[3]),
    preco_comum: decimal(tds[4]),
    preco_maximo: decimal(tds[5]),
    peso_kg: decimal(tds[6]),
    data_cotacao: dataBoletim,
    coletado_em: coletadoEm
  };
  const m = [];
  if (!r.produto_normalizado) m.push('R6 produto sem nome');
  if (r.preco_comum == null) m.push('R1 preço comum ausente');
  if ([r.preco_minimo, r.preco_comum, r.preco_maximo].some(p => p != null && p <= 0)) m.push('R2 preço zero ou negativo');
  if ((r.preco_minimo != null && r.preco_comum != null && r.preco_minimo > r.preco_comum) ||
      (r.preco_comum != null && r.preco_maximo != null && r.preco_comum > r.preco_maximo)) m.push('R3 faixa de preço incoerente');
  if (r.preco_maximo != null && r.preco_maximo > cfg.preco_maximo) m.push('R4 preço acima do teto plausível');
  if (!r.data_cotacao) m.push('R5 data da cotação ausente');
  else if (r.data_cotacao > hoje) m.push('R5 data da cotação no futuro');
  else if (r.data_cotacao !== boletim.data_iso) m.push('R5 data diferente da solicitada');
  const chave = [r.fonte, r.produto_normalizado, r.classificacao, r.unidade_original, r.data_cotacao].join('|');
  if (vistos[chave]) m.push('R7 registro duplicado');
  vistos[chave] = true;

  if (m.length) {
    const motivo = m.join('; ');
    motivos[motivo] = (motivos[motivo] || 0) + 1;
    rejeitados.push(Object.assign({}, r, { motivo: motivo }));
  } else {
    r.preco_kg = r.peso_kg && r.peso_kg > 0 ? Math.round(r.preco_comum / r.peso_kg * 100) / 100 : null;
    validos.push(r);
  }
}
return [{ json: Object.assign({}, base, {
  status: 'OK', coletados: coletados, qtd_validos: validos.length, qtd_rejeitados: rejeitados.length,
  validos: validos, rejeitados: rejeitados, motivos: motivos
}) }];`
    }
  },
  output: [{ grupo: 'FRUTAS', data_iso: '2026-11-04', status: 'OK', coletados: 1, qtd_validos: 1, qtd_rejeitados: 0, validos: [], rejeitados: [], motivos: {} }]
});

const gravarCotacoes = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Gravar cotações (upsert)',
    position: [3120, 300],
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `WITH gravados AS (
  INSERT INTO cotacoes (fonte, localidade, grupo, produto, produto_normalizado, classificacao, unidade,
                        unidade_original, peso_kg, preco_minimo, preco_comum, preco_maximo, preco_kg,
                        data_cotacao, coletado_em, execucao_id)
  SELECT r.fonte, r.localidade, r.grupo, r.produto, r.produto_normalizado, r.classificacao, r.unidade,
         r.unidade_original, r.peso_kg, r.preco_minimo, r.preco_comum, r.preco_maximo, r.preco_kg,
         r.data_cotacao, now(), $2
  FROM jsonb_to_recordset($1::jsonb) AS r(
    fonte text, localidade text, grupo text, produto text, produto_normalizado text, classificacao text,
    unidade text, unidade_original text, peso_kg numeric, preco_minimo numeric, preco_comum numeric,
    preco_maximo numeric, preco_kg numeric, data_cotacao date)
  ON CONFLICT ON CONSTRAINT uq_cotacao DO UPDATE SET
    produto = EXCLUDED.produto, unidade = EXCLUDED.unidade, peso_kg = EXCLUDED.peso_kg,
    preco_minimo = EXCLUDED.preco_minimo, preco_comum = EXCLUDED.preco_comum,
    preco_maximo = EXCLUDED.preco_maximo, preco_kg = EXCLUDED.preco_kg,
    coletado_em = now(), execucao_id = EXCLUDED.execucao_id
  RETURNING 1
)
SELECT count(*)::int AS gravados FROM gravados;`,
      options: {
        queryReplacement: expr('{{ [JSON.stringify($json.validos), $("Configurar execução").first().json.execucao_id] }}')
      }
    }
  },
  output: [{ gravados: 1 }]
});

const haRejeitados = ifElse({
  version: 2.2,
  config: {
    name: 'Há registros rejeitados?',
    position: [3360, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr('{{ $("Validar e padronizar (R1–R7)").first().json.qtd_rejeitados }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } }],
        combinator: 'and'
      }
    }
  }
});

const gravarRejeitados = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Gravar rejeitados (quarentena)',
    position: [3600, 200],
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `WITH ins AS (
  INSERT INTO cotacoes_rejeitadas (execucao_id, fonte, grupo, data_cotacao, registro, motivo)
  SELECT $2, r->>'fonte', r->>'grupo', NULLIF(r->>'data_cotacao', '')::date, r, r->>'motivo'
  FROM jsonb_array_elements($1::jsonb) AS r
  RETURNING 1
)
SELECT count(*)::int AS rejeitados_gravados FROM ins;`,
      options: {
        queryReplacement: expr('{{ [JSON.stringify($("Validar e padronizar (R1–R7)").first().json.rejeitados), $("Configurar execução").first().json.execucao_id] }}')
      }
    }
  },
  output: [{ rejeitados_gravados: 1 }]
});

const resumoBoletim = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Resumo do boletim',
    position: [3840, 300],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'r1', name: 'grupo', value: expr('{{ $("Validar e padronizar (R1–R7)").first().json.grupo }}'), type: 'string' },
          { id: 'r2', name: 'data_iso', value: expr('{{ $("Validar e padronizar (R1–R7)").first().json.data_iso }}'), type: 'string' },
          { id: 'r3', name: 'status', value: expr('{{ $("Validar e padronizar (R1–R7)").first().json.status }}'), type: 'string' },
          { id: 'r4', name: 'coletados', value: expr('{{ $("Validar e padronizar (R1–R7)").first().json.coletados }}'), type: 'number' },
          { id: 'r5', name: 'gravados', value: expr('{{ $("Gravar cotações (upsert)").first().json.gravados }}'), type: 'number' },
          { id: 'r6', name: 'qtd_rejeitados', value: expr('{{ $("Validar e padronizar (R1–R7)").first().json.qtd_rejeitados }}'), type: 'number' },
          { id: 'r7', name: 'motivos', value: expr('{{ $("Validar e padronizar (R1–R7)").first().json.motivos }}'), type: 'object' }
        ]
      }
    }
  },
  output: [{ grupo: 'FRUTAS', data_iso: '2026-11-04', status: 'OK', coletados: 1, gravados: 1, qtd_rejeitados: 0, motivos: {} }]
});

const registrarErroBoletim = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Registrar erro do boletim e seguir',
    position: [3120, 640],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'e1', name: 'grupo', value: expr('{{ $("Percorrer boletins").first().json.grupo }}'), type: 'string' },
          { id: 'e2', name: 'data_iso', value: expr('{{ $("Percorrer boletins").first().json.data_iso }}'), type: 'string' },
          { id: 'e3', name: 'status', value: 'ERRO', type: 'string' },
          { id: 'e4', name: 'erro', value: expr('{{ String($json.error?.message ?? $json.error ?? "erro desconhecido") }}'), type: 'string' }
        ]
      }
    }
  },
  output: [{ grupo: 'FRUTAS', data_iso: '2026-11-04', status: 'ERRO', erro: 'timeout' }]
});

const consolidar = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Consolidar execução e definir status',
    position: [1920, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const cfg = $('Configurar execução').first().json;
const itens = $input.all().map(i => i.json);
const por = s => itens.filter(i => i.status === s);
const ok = por('OK'), erros = por('ERRO'), vazios = por('VAZIO'), pulados = por('JA_COLETADO');
const soma = (lista, campo) => lista.reduce((t, i) => t + (Number(i[campo]) || 0), 0);
const coletados = soma(ok, 'coletados');
const validos = soma(ok, 'gravados');
const rejeitados = soma(ok, 'qtd_rejeitados');
const gruposComBoletim = new Set(itens.map(i => i.grupo));
const semBoletim = cfg.grupos.filter(g => !gruposComBoletim.has(g));

// Regra de decisão do status final
let status;
if (erros.length) status = validos > 0 ? 'SUCESSO_PARCIAL' : 'FALHA';
else status = validos > 0 ? 'SUCESSO' : 'SEM_NOVIDADES';

const logs = [];
semBoletim.forEach(g => logs.push({ nivel: 'WARNING', etapa: 'coleta', mensagem: 'Grupo ' + g + ': nenhum boletim nos últimos ' + cfg.janela_dias + ' dias' }));
if (pulados.length) logs.push({ nivel: 'INFO', etapa: 'incremental', mensagem: pulados.length + ' boletim(ns) já coletado(s) anteriormente foram ignorados' });
ok.forEach(i => {
  logs.push({ nivel: 'INFO', etapa: 'coleta', mensagem: 'Grupo ' + i.grupo + ' ' + i.data_iso + ': coletados=' + i.coletados + ' válidos=' + i.gravados + ' rejeitados=' + i.qtd_rejeitados });
  Object.entries(i.motivos || {}).forEach(e => logs.push({ nivel: 'WARNING', etapa: 'validacao', mensagem: 'Grupo ' + i.grupo + ' ' + i.data_iso + ': rejeição "' + e[0] + '" em ' + e[1] + ' registro(s)' }));
});
vazios.forEach(i => logs.push({ nivel: 'WARNING', etapa: 'coleta', mensagem: 'Grupo ' + i.grupo + ' ' + i.data_iso + ': boletim vazio' }));
erros.forEach(i => logs.push({ nivel: 'ERROR', etapa: 'coleta', mensagem: 'Grupo ' + i.grupo + ' ' + i.data_iso + ': ' + i.erro }));
logs.push({ nivel: status === 'FALHA' ? 'ERROR' : 'INFO', etapa: 'fim', mensagem: 'Fim | status=' + status + ' | boletins=' + ok.length + ' | coletados=' + coletados + ' | válidos=' + validos + ' | rejeitados=' + rejeitados + ' | erros=' + erros.length });

return [{ json: {
  execucao_id: cfg.execucao_id,
  status: status,
  boletins_processados: ok.length,
  coletados: coletados,
  validos: validos,
  rejeitados: rejeitados,
  erros: erros.map(i => ({ grupo: i.grupo, data: i.data_iso, erro: i.erro })),
  detalhes: itens.map(i => ({ grupo: i.grupo, data: i.data_iso, status: i.status, coletados: i.coletados || 0, validos: i.gravados || 0, rejeitados: i.qtd_rejeitados || 0 })),
  logs: logs
} }];`
    }
  },
  output: [{ execucao_id: '101', status: 'SUCESSO', boletins_processados: 1, coletados: 1, validos: 1, rejeitados: 0, erros: [], detalhes: [], logs: [] }]
});

const gerarAlertas = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Gerar alertas de preço',
    position: [2160, 0],
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `-- Compara o preço comum de cada cotação nova com a média das 5 cotações anteriores do mesmo produto.
WITH novos AS (
  SELECT * FROM cotacoes WHERE execucao_id = $1
), comparados AS (
  SELECT n.*, h.referencia, h.qtd_hist
  FROM novos n
  CROSS JOIN LATERAL (
    SELECT avg(x.preco_comum) AS referencia, count(*) AS qtd_hist
    FROM (
      SELECT c.preco_comum FROM cotacoes c
      WHERE c.fonte = n.fonte AND c.produto_normalizado = n.produto_normalizado
        AND c.classificacao = n.classificacao AND c.unidade_original = n.unidade_original
        AND c.data_cotacao < n.data_cotacao
      ORDER BY c.data_cotacao DESC
      LIMIT 5
    ) x
  ) h
  WHERE h.qtd_hist >= 2 AND h.referencia > 0
), relevantes AS (
  SELECT *, round(((preco_comum - referencia) / referencia * 100)::numeric, 1) AS variacao
  FROM comparados
  WHERE abs((preco_comum - referencia) / referencia * 100) >= $2::numeric
), inseridos AS (
  INSERT INTO alertas_preco (execucao_id, fonte, grupo, produto, produto_normalizado, classificacao, unidade,
                             data_cotacao, preco_atual, preco_referencia, variacao_pct, tipo, mensagem)
  SELECT $1, fonte, grupo, produto, produto_normalizado, classificacao, unidade, data_cotacao,
         preco_comum, round(referencia, 2), variacao,
         CASE WHEN variacao > 0 THEN 'ALTA' ELSE 'QUEDA' END,
         produto || CASE WHEN classificacao <> '' THEN ' (' || classificacao || ')' ELSE '' END || ': '
           || CASE WHEN variacao > 0 THEN 'alta' ELSE 'queda' END || ' de ' || replace(abs(variacao)::text, '.', ',')
           || '% — R$ ' || replace(to_char(preco_comum, 'FM999990.00'), '.', ',') || '/' || coalesce(unidade, '')
           || ' (média R$ ' || replace(to_char(referencia, 'FM999990.00'), '.', ',') || ' em ' || qtd_hist || ' cotações)'
  FROM relevantes
  ON CONFLICT ON CONSTRAINT uq_alerta DO NOTHING
  RETURNING tipo, mensagem, variacao_pct, data_cotacao
)
SELECT count(*)::int AS qtd,
       (count(*) FILTER (WHERE tipo = 'ALTA'))::int AS altas,
       (count(*) FILTER (WHERE tipo = 'QUEDA'))::int AS quedas,
       coalesce((SELECT json_agg(t) FROM (
         SELECT tipo, mensagem FROM inseridos ORDER BY data_cotacao DESC, abs(variacao_pct) DESC LIMIT 8
       ) t), '[]'::json) AS destaques
FROM inseridos;`,
      options: {
        queryReplacement: expr('{{ [$json.execucao_id, $("Configurar execução").first().json.limite_alerta_pct] }}')
      }
    }
  },
  output: [{ qtd: 2, altas: 1, quedas: 1, destaques: [{ tipo: 'ALTA', mensagem: 'Tomate: alta de 20%' }] }]
});

const finalizar = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Finalizar execução e gravar log',
    position: [2400, -160],
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `WITH atualiza AS (
  UPDATE execucoes_rpa SET
    fim = now(), status = $2, boletins_processados = $3::int, registros_coletados = $4::int,
    registros_validos = $5::int, registros_rejeitados = $6::int, alertas_gerados = $7::int,
    erros = $8::jsonb, detalhes = $9::jsonb
  WHERE execucao_id = $1
  RETURNING execucao_id, status
), logs AS (
  INSERT INTO logs_rpa (execucao_id, nivel, etapa, mensagem)
  SELECT $1, l.nivel, l.etapa, l.mensagem
  FROM jsonb_to_recordset($10::jsonb) AS l(nivel text, etapa text, mensagem text)
  RETURNING 1
)
SELECT a.execucao_id, a.status, (SELECT count(*) FROM logs)::int AS linhas_de_log FROM atualiza a;`,
      options: {
        queryReplacement: expr('{{ (() => { const c = $("Consolidar execução e definir status").first().json; const a = $("Gerar alertas de preço").first().json; return [c.execucao_id, c.status, c.boletins_processados, c.coletados, c.validos, c.rejeitados, a.qtd, JSON.stringify(c.erros), JSON.stringify(c.detalhes), JSON.stringify(c.logs.concat([{ nivel: "INFO", etapa: "alertas", mensagem: "Alertas de preço gerados: " + a.qtd + " (altas=" + a.altas + ", quedas=" + a.quedas + ")" }]))]; })() }}')
      }
    }
  },
  output: [{ execucao_id: '101', status: 'SUCESSO', linhas_de_log: 5 }]
});

const haAlertas = ifElse({
  version: 2.2,
  config: {
    name: 'Variação de preço relevante?',
    position: [2400, 80],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr('{{ $json.qtd }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } }],
        combinator: 'and'
      }
    }
  }
});

const buscarAssinantes = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Buscar produtores inscritos',
    position: [2640, 0],
    credentials: PG,
    executeOnce: true,
    parameters: { operation: 'executeQuery', query: 'SELECT chat_id, nome FROM assinantes_telegram WHERE ativo;' }
  },
  output: [{ chat_id: 123456789, nome: 'Produtor' }]
});

const enviarAlertas = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Enviar alertas aos produtores (Telegram)',
    position: [2880, 0],
    credentials: TG,
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('📊 <b>AgroConecta — Alertas de preço (CEAGESP)</b>\n{{ $("Gerar alertas de preço").first().json.qtd }} variações de pelo menos {{ $("Configurar execução").first().json.limite_alerta_pct }}% em relação à média recente ({{ $("Gerar alertas de preço").first().json.altas }} altas, {{ $("Gerar alertas de preço").first().json.quedas }} quedas).\n\n<b>Destaques:</b>\n{{ $("Gerar alertas de preço").first().json.destaques.map(d => (d.tipo === "ALTA" ? "🔺 " : "🔻 ") + d.mensagem.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("\\n") }}\n\nConsulte um produto: /preco tomate'),
      additionalFields: { appendAttribution: false, parse_mode: 'HTML' }
    }
  },
  output: [{ ok: true }]
});

const notaVisaoGeral = sticky(`## 🤖 Robô de cotações CEAGESP — AgroConecta
Substitui a consulta manual diária ao portal de preços da CEAGESP.
1. Agenda diária (07:30) ou execução manual
2. Registra a execução e acessa o portal (3 tentativas)
3. Lê as datas de boletim e pula as já coletadas (incremental)
4. Para cada boletim: consulta, extrai, valida (R1–R7) e grava no Supabase
5. Gera alertas de variação ≥ 15% e avisa os produtores no Telegram
6. Grava status final e log (tabelas execucoes_rpa e logs_rpa)`, [agenda, manual, configurar, registrarInicio], { color: 7 });

const notaFalha = sticky(`### Exceção: portal fora do ar
Após 3 tentativas sem resposta, a execução é marcada como FALHA e os administradores são avisados.`, [registrarFalhaPortal, buscarAdminsPortal, avisarAdminsPortal], { color: 3 });

const notaLaco = sticky(`### Laço por boletim (categoria × data)
Decisões: já coletado? / há tabela? / layout esperado? / há rejeitados?
Erro em um boletim não interrompe os demais: ele é registrado e o laço segue.`, [jaColetado, aguardar, consultarBoletim, extrairTabela, validar, gravarCotacoes, haRejeitados, gravarRejeitados, resumoBoletim, registrarErroBoletim, pular], { color: 5 });

const notaFim = sticky(`### Fechamento
Status final: SUCESSO, SUCESSO_PARCIAL, SEM_NOVIDADES ou FALHA. Alertas são enviados só quando há variação relevante.`, [consolidar, gerarAlertas, finalizar, haAlertas, buscarAssinantes, enviarAlertas], { color: 6 });

export default workflow('agroconecta-robo-cotacoes', 'AgroConecta | Robô de cotações CEAGESP')
  .add(agenda)
  .to(configurar)
  .add(manual)
  .to(configurar)
  .add(configurar)
  .to(registrarInicio)
  .to(acessarPortal
    .onError(registrarFalhaPortal.to(buscarAdminsPortal).to(avisarAdminsPortal)))
  .add(acessarPortal)
  .to(lerDatas)
  .to(consultarColetados)
  .to(marcarPendentes)
  .to(percorrer
    .onDone(consolidar.to(gerarAlertas))
    .onEachBatch(jaColetado
      .onTrue(pular.to(nextBatch(percorrer)))
      .onFalse(aguardar.to(consultarBoletim
        .onError(registrarErroBoletim.to(nextBatch(percorrer))))))
  )
  .add(consultarBoletim)
  .to(extrairTabela)
  .to(validar
    .onError(registrarErroBoletim))
  .add(validar)
  .to(gravarCotacoes)
  .to(haRejeitados
    .onTrue(gravarRejeitados.to(resumoBoletim))
    .onFalse(resumoBoletim))
  .add(resumoBoletim)
  .to(nextBatch(percorrer))
  .add(gerarAlertas)
  .to(finalizar)
  .add(gerarAlertas)
  .to(haAlertas.onTrue(buscarAssinantes.to(enviarAlertas)))
  .add(notaVisaoGeral)
  .add(notaFalha)
  .add(notaLaco)
  .add(notaFim);

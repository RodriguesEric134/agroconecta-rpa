import { workflow, node, trigger, sticky, switchCase, expr } from '@n8n/workflow-sdk';

const PG = { postgres: { id: 'vHkjYCcR97jtmaam', name: 'Postgres account' } };
const TG = { telegramApi: { id: '9QXOYJilBHrOE88q', name: 'Telegram account' } };

const recebeu = trigger({
  type: 'n8n-nodes-base.telegramTrigger',
  version: 1.2,
  config: {
    name: 'Mensagem recebida no bot',
    position: [0, 300],
    credentials: TG,
    parameters: { updates: ['message'], additionalFields: {} }
  },
  output: [{ message: { chat: { id: 123456789 }, from: { first_name: 'Maria', last_name: 'Silva', username: 'mariasilva' }, text: '/preco tomate' } }]
});

const lerMensagem = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Ler mensagem',
    position: [240, 300],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'm1', name: 'chat_id', value: expr('{{ $json.message.chat.id }}'), type: 'number' },
          { id: 'm2', name: 'nome', value: expr('{{ [$json.message.from?.first_name, $json.message.from?.last_name].filter(Boolean).join(" ") || "produtor" }}'), type: 'string' },
          { id: 'm3', name: 'username', value: expr('{{ $json.message.from?.username ?? "" }}'), type: 'string' },
          { id: 'm4', name: 'comando', value: expr('{{ ($json.message.text ?? "").trim().split(/\\s+/)[0].split("@")[0].toLowerCase() }}'), type: 'string' },
          { id: 'm5', name: 'argumento', value: expr('{{ ($json.message.text ?? "").trim().split(/\\s+/).slice(1).join(" ") }}'), type: 'string' },
          { id: 'm6', name: 'busca', value: expr('{{ ($json.message.text ?? "").trim().split(/\\s+/).slice(1).join(" ").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toUpperCase() }}'), type: 'string' }
        ]
      }
    }
  },
  output: [{ chat_id: 123456789, nome: 'Maria Silva', username: 'mariasilva', comando: '/preco', argumento: 'tomate', busca: 'TOMATE' }]
});

const qualComando = switchCase({
  version: 3.2,
  config: {
    name: 'Qual comando?',
    position: [480, 300],
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          { outputKey: '/start', renameOutput: true, conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.comando }}'), rightValue: '/start', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } },
          { outputKey: '/parar', renameOutput: true, conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.comando }}'), rightValue: '/parar', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } },
          { outputKey: '/preco', renameOutput: true, conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.comando }}'), rightValue: '/preco', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } }
        ]
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'ajuda' }
    }
  }
});

const cadastrar = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Cadastrar produtor',
    position: [760, 80],
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `INSERT INTO assinantes_telegram (chat_id, nome, username, ativo, admin)
VALUES ($1::bigint, $2, $3, true, NOT EXISTS (SELECT 1 FROM assinantes_telegram WHERE admin))
ON CONFLICT (chat_id) DO UPDATE SET ativo = true, nome = EXCLUDED.nome, username = EXCLUDED.username, atualizado_em = now()
RETURNING chat_id, admin;`,
      options: { queryReplacement: expr('{{ [$json.chat_id, $json.nome, $json.username] }}') }
    }
  },
  output: [{ chat_id: 123456789, admin: true }]
});

const boasVindas = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Responder boas-vindas',
    position: [1020, 80],
    credentials: TG,
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('🌱 Olá, {{ $("Ler mensagem").first().json.nome }}! Você agora recebe os <b>alertas de preço do AgroConecta</b>.\n\nTodo dia útil o robô consulta a CEAGESP e avisa quando um produto sobe ou cai 15% ou mais.\n\n• /preco tomate — preço mais recente de um produto\n• /parar — deixar de receber alertas{{ $json.admin ? "\\n\\n🔧 Você também é administrador e receberá avisos se o robô falhar." : "" }}'),
      additionalFields: { appendAttribution: false, parse_mode: 'HTML' }
    }
  },
  output: [{ ok: true }]
});

const desativar = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Descadastrar produtor',
    position: [760, 260],
    credentials: PG,
    alwaysOutputData: true,
    parameters: {
      operation: 'executeQuery',
      query: 'UPDATE assinantes_telegram SET ativo = false, atualizado_em = now() WHERE chat_id = $1::bigint RETURNING chat_id;',
      options: { queryReplacement: expr('{{ [$json.chat_id] }}') }
    }
  },
  output: [{ chat_id: 123456789 }]
});

const confirmarSaida = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Confirmar descadastro',
    position: [1020, 260],
    credentials: TG,
    executeOnce: true,
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Ler mensagem").first().json.chat_id }}'),
      text: 'Pronto, você não receberá mais alertas. Para voltar, envie /start.',
      additionalFields: { appendAttribution: false }
    }
  },
  output: [{ ok: true }]
});

const buscarPreco = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Buscar preço mais recente',
    position: [760, 440],
    credentials: PG,
    alwaysOutputData: true,
    parameters: {
      operation: 'executeQuery',
      query: `SELECT produto, classificacao, unidade, preco_comum, preco_kg, to_char(data_cotacao, 'DD/MM/YYYY') AS data
FROM vw_ultimas_cotacoes
WHERE $1 <> '' AND produto_normalizado LIKE '%' || $1 || '%'
ORDER BY produto, classificacao
LIMIT 12;`,
      options: { queryReplacement: expr('{{ [$json.busca] }}') }
    }
  },
  output: [{ produto: 'Tomate Débora', classificacao: '1A', unidade: 'kg', preco_comum: '9.44', preco_kg: '9.44', data: '09/11/2026' }]
});

const responderPreco = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Responder preços',
    position: [1020, 440],
    credentials: TG,
    executeOnce: true,
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Ler mensagem").first().json.chat_id }}'),
      text: expr('{{ (() => { const termo = $("Ler mensagem").first().json.argumento; const linhas = $input.all().map(i => i.json).filter(r => r.produto); if (!termo) return "Envie o nome do produto. Ex.: /preco tomate"; if (!linhas.length) return "Não encontrei \\"" + termo + "\\" no último boletim da CEAGESP."; const fmt = v => v == null ? "-" : Number(v).toFixed(2).replace(".", ","); return "💰 <b>CEAGESP — " + termo + "</b> (boletim de " + linhas[0].data + ")\\n\\n" + linhas.map(r => "• " + r.produto + (r.classificacao ? " (" + r.classificacao + ")" : "") + ": R$ " + fmt(r.preco_comum) + "/" + r.unidade + (r.preco_kg && r.unidade !== "kg" ? " (R$ " + fmt(r.preco_kg) + "/kg)" : "")).join("\\n"); })() }}'),
      additionalFields: { appendAttribution: false, parse_mode: 'HTML' }
    }
  },
  output: [{ ok: true }]
});

const ajuda = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Responder ajuda',
    position: [760, 620],
    credentials: TG,
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: '🤖 Comandos do AgroConecta:\n/start — receber alertas de preço\n/preco tomate — preço mais recente na CEAGESP\n/parar — deixar de receber alertas',
      additionalFields: { appendAttribution: false }
    }
  },
  output: [{ ok: true }]
});

const nota = sticky(`## 📲 Bot do AgroConecta no Telegram
Canal do produtor com a Central de Cotações e Alertas.
• /start → cadastra o produtor (o primeiro cadastrado vira administrador)
• /preco <produto> → responde com o boletim mais recente
• /parar → descadastra`, [recebeu, lerMensagem, qualComando], { color: 4 });

export default workflow('agroconecta-bot-telegram', 'AgroConecta | Bot do Telegram')
  .add(recebeu)
  .to(lerMensagem)
  .to(qualComando
    .onCase(0, cadastrar.to(boasVindas))
    .onCase(1, desativar.to(confirmarSaida))
    .onCase(2, buscarPreco.to(responderPreco))
    .onCase(3, ajuda))
  .add(nota);

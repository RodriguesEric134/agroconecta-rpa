import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';

const PG = { postgres: { id: 'vHkjYCcR97jtmaam', name: 'Postgres account' } };
const TG = { telegramApi: { id: '9QXOYJilBHrOE88q', name: 'Telegram account' } };

const quandoFalhar = trigger({
  type: 'n8n-nodes-base.errorTrigger',
  version: 1,
  config: { name: 'Quando o robô falhar', position: [0, 300] },
  output: [{ execution: { id: '231', url: 'https://exemplo.app.n8n.cloud/execution/231', error: { message: 'LAYOUT_ALTERADO: variável Grupos não encontrada' }, lastNodeExecuted: 'Ler datas de boletim disponíveis', mode: 'trigger' }, workflow: { id: 'WxXWYjOO1O65rFeZ', name: 'AgroConecta | Robô de cotações CEAGESP' } }]
});

const registrarFalha = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Registrar FALHA e log',
    position: [260, 300],
    credentials: PG,
    parameters: {
      operation: 'executeQuery',
      query: `WITH up AS (
  INSERT INTO execucoes_rpa (execucao_id, workflow, modo, inicio, fim, status, fonte, erros)
  VALUES ($1, $2, $3, now(), now(), 'FALHA', 'CEAGESP',
          jsonb_build_array(jsonb_build_object('etapa', $4::text, 'erro', $5::text)))
  ON CONFLICT (execucao_id) DO UPDATE SET
    fim = now(), status = 'FALHA', erros = execucoes_rpa.erros || EXCLUDED.erros
  RETURNING execucao_id
)
INSERT INTO logs_rpa (execucao_id, nivel, etapa, mensagem)
SELECT execucao_id, 'ERROR', $4, 'Falha inesperada no nó "' || $4 || '": ' || $5 FROM up
RETURNING execucao_id;`,
      options: {
        queryReplacement: expr('{{ [String($json.execution?.id ?? ("sem-id-" + $now.toMillis())), $json.workflow?.name ?? "desconhecido", $json.execution?.mode ?? "desconhecido", $json.execution?.lastNodeExecuted ?? "desconhecido", String($json.execution?.error?.message ?? "erro sem mensagem")] }}')
      }
    }
  },
  output: [{ execucao_id: '231' }]
});

const buscarAdmins = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Buscar administradores',
    position: [520, 300],
    credentials: PG,
    executeOnce: true,
    parameters: { operation: 'executeQuery', query: 'SELECT chat_id FROM assinantes_telegram WHERE ativo AND admin;' }
  },
  output: [{ chat_id: 123456789 }]
});

const avisar = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Avisar administradores (Telegram)',
    position: [780, 300],
    credentials: TG,
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr('🚨 <b>Falha no robô de cotações</b>\nWorkflow: {{ $("Quando o robô falhar").first().json.workflow?.name }}\nEtapa: {{ $("Quando o robô falhar").first().json.execution?.lastNodeExecuted }}\nErro: {{ String($("Quando o robô falhar").first().json.execution?.error?.message ?? "sem mensagem").replace(/&/g, "&amp;").replace(/</g, "&lt;").slice(0, 300) }}\n\nDetalhes: {{ $("Quando o robô falhar").first().json.execution?.url }}'),
      additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true }
    }
  },
  output: [{ ok: true }]
});

const nota = sticky(`## 🚨 Tratamento de erros do robô
Acionado automaticamente quando o workflow "Robô de cotações CEAGESP" falha em produção (ex.: layout do portal mudou, banco indisponível).
Marca a execução como FALHA, grava o log e avisa os administradores no Telegram.`, [quandoFalhar, registrarFalha, buscarAdmins, avisar], { color: 3 });

export default workflow('agroconecta-tratamento-erros', 'AgroConecta | Tratamento de erros do robô')
  .add(quandoFalhar)
  .to(registrarFalha)
  .to(buscarAdmins)
  .to(avisar)
  .add(nota);

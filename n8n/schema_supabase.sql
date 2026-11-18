-- AgroConecta — schema do banco do MVP (Supabase / PostgreSQL)
-- Aplicado pelo workflow "AgroConecta | Setup do banco" (idempotente: pode rodar várias vezes).

-- ------------------------------------------------------------------ cotações
CREATE TABLE IF NOT EXISTS cotacoes (
  id                  BIGSERIAL PRIMARY KEY,
  fonte               TEXT        NOT NULL,
  localidade          TEXT        NOT NULL,
  grupo               TEXT        NOT NULL,
  produto             TEXT        NOT NULL,
  produto_normalizado TEXT        NOT NULL,
  classificacao       TEXT        NOT NULL DEFAULT '',
  unidade             TEXT,
  unidade_original    TEXT        NOT NULL,
  peso_kg             NUMERIC(10,3),
  preco_minimo        NUMERIC(12,2),
  preco_comum         NUMERIC(12,2) NOT NULL,
  preco_maximo        NUMERIC(12,2),
  preco_kg            NUMERIC(12,2),
  data_cotacao        DATE        NOT NULL,
  coletado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  execucao_id         TEXT,
  CONSTRAINT uq_cotacao UNIQUE (fonte, produto_normalizado, classificacao, unidade_original, data_cotacao)
);
CREATE INDEX IF NOT EXISTS ix_cotacoes_produto_data ON cotacoes (produto_normalizado, data_cotacao DESC);
CREATE INDEX IF NOT EXISTS ix_cotacoes_grupo_data   ON cotacoes (grupo, data_cotacao DESC);

-- ------------------------------------------------------------------ rejeitados (regras R1–R7)
CREATE TABLE IF NOT EXISTS cotacoes_rejeitadas (
  id            BIGSERIAL PRIMARY KEY,
  execucao_id   TEXT,
  fonte         TEXT,
  grupo         TEXT,
  data_cotacao  DATE,
  registro      JSONB,
  motivo        TEXT,
  rejeitado_em  TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------------ alertas de preço
CREATE TABLE IF NOT EXISTS alertas_preco (
  id                  BIGSERIAL PRIMARY KEY,
  execucao_id         TEXT,
  fonte               TEXT,
  grupo               TEXT,
  produto             TEXT,
  produto_normalizado TEXT,
  classificacao       TEXT,
  unidade             TEXT,
  data_cotacao        DATE,
  preco_atual         NUMERIC(12,2),
  preco_referencia    NUMERIC(12,2),
  variacao_pct        NUMERIC(6,1),
  tipo                TEXT CHECK (tipo IN ('ALTA', 'QUEDA')),
  mensagem            TEXT,
  criado_em           TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_alerta UNIQUE (fonte, produto_normalizado, classificacao, unidade, data_cotacao)
);

-- ------------------------------------------------------------------ execuções e logs do robô
CREATE TABLE IF NOT EXISTS execucoes_rpa (
  execucao_id           TEXT PRIMARY KEY,
  workflow              TEXT,
  modo                  TEXT,
  inicio                TIMESTAMPTZ,
  fim                   TIMESTAMPTZ,
  status                TEXT,           -- EM_EXECUCAO | SUCESSO | SUCESSO_PARCIAL | SEM_NOVIDADES | FALHA
  fonte                 TEXT,
  boletins_processados  INT DEFAULT 0,
  registros_coletados   INT DEFAULT 0,
  registros_validos     INT DEFAULT 0,
  registros_rejeitados  INT DEFAULT 0,
  alertas_gerados       INT DEFAULT 0,
  erros                 JSONB DEFAULT '[]'::jsonb,
  detalhes              JSONB DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS logs_rpa (
  id           BIGSERIAL PRIMARY KEY,
  execucao_id  TEXT,
  nivel        TEXT,                    -- INFO | WARNING | ERROR
  etapa        TEXT,
  mensagem     TEXT,
  criado_em    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_logs_execucao ON logs_rpa (execucao_id, criado_em);

-- ------------------------------------------------------------------ produtores que recebem alertas no Telegram
CREATE TABLE IF NOT EXISTS assinantes_telegram (
  chat_id        BIGINT PRIMARY KEY,
  nome           TEXT,
  username       TEXT,
  ativo          BOOLEAN DEFAULT true,
  admin          BOOLEAN DEFAULT false,  -- recebe também avisos de falha do robô
  cadastrado_em  TIMESTAMPTZ DEFAULT now(),
  atualizado_em  TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------------ visão de consumo do MVP
CREATE OR REPLACE VIEW vw_ultimas_cotacoes AS
SELECT c.*
FROM cotacoes c
JOIN (SELECT grupo, max(data_cotacao) AS data_cotacao FROM cotacoes GROUP BY grupo) u
  ON u.grupo = c.grupo AND u.data_cotacao = c.data_cotacao;

-- ------------------------------------------------------------------ segurança (API REST do Supabase)
-- RLS ligado em todas as tabelas: sem política = nada exposto pela API pública.
-- O n8n conecta como 'postgres' (dono das tabelas) e não é afetado.
ALTER TABLE cotacoes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE cotacoes_rejeitadas ENABLE ROW LEVEL SECURITY;
ALTER TABLE alertas_preco       ENABLE ROW LEVEL SECURITY;
ALTER TABLE execucoes_rpa       ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs_rpa            ENABLE ROW LEVEL SECURITY;
ALTER TABLE assinantes_telegram ENABLE ROW LEVEL SECURITY;

-- Cotações e alertas são dados públicos de mercado: leitura liberada para o app (anon/authenticated).
DROP POLICY IF EXISTS leitura_publica_cotacoes ON cotacoes;
CREATE POLICY leitura_publica_cotacoes ON cotacoes FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS leitura_publica_alertas ON alertas_preco;
CREATE POLICY leitura_publica_alertas ON alertas_preco FOR SELECT TO anon, authenticated USING (true);
ALTER VIEW vw_ultimas_cotacoes SET (security_invoker = true);

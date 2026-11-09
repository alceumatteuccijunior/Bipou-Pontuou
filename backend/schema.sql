-- ============================================================================
-- PROJETO: BIPOU, PONTUOU — LIXEIRA INTELIGENTE COM IA & ESP32
-- SCRIPT COMPLETO DE DEFINIÇÃO E CRIAÇÃO DO BANCO DE DADOS (DDL + DML)
-- Compatível com: MySQL 8.0+, MariaDB 10.5+, MySQL Workbench, phpMyAdmin
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CRIAÇÃO E SELEÇÃO DO BANCO DE DADOS
-- ----------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS bipa_pesa
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE bipa_pesa;

-- Desativa temporariamente a checagem de chaves estrangeiras para execução segura
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------------------------------------------------------
-- 2. TABELA: usuarios
-- Armazena os dados dos alunos. Login e cadastro simplificado feito por CPF.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  cpf VARCHAR(14) NOT NULL UNIQUE,
  nome VARCHAR(120) NOT NULL,
  senha VARCHAR(255) NOT NULL,
  telefone VARCHAR(20) NULL,
  pontos INT NOT NULL DEFAULT 0,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_usuarios_cpf (cpf)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 3. TABELA: materiais
-- Categorias de resíduos reconhecidos pela IA (Plástico, Papel, Metal)
-- Pontuação padrão: 50 pontos por descarte.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS materiais (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(80) NOT NULL UNIQUE,
  pontos_por_descarte INT NOT NULL DEFAULT 50,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 4. TABELA: reciclagens
-- Registra cada descarte realizado na lixeira inteligente.
-- Armazena o material identificado pela IA, o status do ESP32 e a foto.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reciclagens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  usuario_id BIGINT UNSIGNED NOT NULL,
  material VARCHAR(80) NOT NULL,
  confianca VARCHAR(20) NULL DEFAULT 'alta',
  descricao_ia TEXT NULL,
  status_esp32 VARCHAR(255) NULL,
  pontos_ganhos INT NOT NULL DEFAULT 50,
  foto_url VARCHAR(255) NULL,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_reciclagens_usuario (usuario_id),
  INDEX idx_reciclagens_data (criado_em),
  CONSTRAINT fk_reciclagens_usuario
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 5. TABELA: recompensas
-- Catálogo de prêmios. A Bala a 40 pontos é o item principal de troca.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recompensas (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  titulo VARCHAR(120) NOT NULL UNIQUE,
  pontos_necessarios INT NOT NULL DEFAULT 40,
  estoque INT NOT NULL DEFAULT 1000,
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 6. TABELA: resgates
-- Registra as trocas de pontos por balas, gerando um comprovante digital único.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resgates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  codigo_comprovante VARCHAR(40) NOT NULL UNIQUE,
  usuario_id BIGINT UNSIGNED NOT NULL,
  recompensa_id INT UNSIGNED NOT NULL,
  quantidade INT NOT NULL DEFAULT 1,
  pontos_gastos INT NOT NULL DEFAULT 40,
  status VARCHAR(30) NOT NULL DEFAULT 'Válido para troca',
  criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_resgates_usuario (usuario_id),
  INDEX idx_resgates_codigo (codigo_comprovante),
  CONSTRAINT fk_resgates_usuario
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_resgates_recompensa
    FOREIGN KEY (recompensa_id) REFERENCES recompensas(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reativa a checagem de chaves estrangeiras
SET FOREIGN_KEY_CHECKS = 1;

-- ----------------------------------------------------------------------------
-- 7. CARGA DE DADOS INICIAIS (SEEDS)
-- ----------------------------------------------------------------------------

-- Inserção dos materiais recicláveis com 50 pontos por descarte
INSERT INTO materiais (nome, pontos_por_descarte)
VALUES
  ('Plastico', 50),
  ('Metal', 50),
  ('Papel', 50)
ON DUPLICATE KEY UPDATE
  pontos_por_descarte = VALUES(pontos_por_descarte);

-- Inserção das recompensas (Bala a 40 pontos)
INSERT INTO recompensas (titulo, pontos_necessarios, estoque)
VALUES
  ('Bala', 40, 1000),
  ('Pirulito', 80, 200),
  ('Bombom', 120, 100)
ON DUPLICATE KEY UPDATE
  pontos_necessarios = VALUES(pontos_necessarios),
  estoque = VALUES(estoque);

-- ============================================================================
-- FIM DO SCRIPT
-- ============================================================================

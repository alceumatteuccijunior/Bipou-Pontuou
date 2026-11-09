const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '7828',
  database: process.env.DB_NAME || 'bipa_pesa',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
};

const pool = mysql.createPool(dbConfig);

async function testarConexao() {
  // 1. Cria o banco de dados bipa_pesa automaticamente no MySQL se ainda não existir
  try {
    const rootConn = await mysql.createConnection({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      multipleStatements: true
    });

    await rootConn.query(`
      CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`
      CHARACTER SET utf8mb4
      COLLATE utf8mb4_unicode_ci;
    `);

    await rootConn.query(`USE \`${dbConfig.database}\``);

    // 2. Se o banco não tiver tabelas, executa o schema.sql automaticamente
    const [tables] = await rootConn.query('SHOW TABLES');
    if (!tables.length) {
      console.log('🔄 Banco de dados vazio. Inicializando tabelas a partir de schema.sql...');
      const schemaPath = path.join(__dirname, 'schema.sql');
      if (fs.existsSync(schemaPath)) {
        const sql = fs.readFileSync(schemaPath, 'utf8');
        await rootConn.query(sql);
        console.log('✅ Estrutura de tabelas e sementes iniciais criadas com sucesso!');
      }
    }

    await rootConn.end();
  } catch (initErr) {
    console.warn('ℹ️ Verificação de auto-criação do banco:', initErr.message);
  }

  // 3. Testa a conexão do Pool oficial com o banco bipa_pesa
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query('SELECT 1');
    console.log(`✅ MySQL conectado com sucesso no banco "${dbConfig.database}".`);
  } catch (error) {
    console.error('❌ Não foi possível conectar ao MySQL.');
    console.error('Verifique o .env, a senha do MySQL e se o serviço está ativo.');
    console.error(error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { pool, testarConexao };

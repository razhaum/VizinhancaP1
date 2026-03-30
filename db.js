require('dotenv').config();
const { Pool } = require('pg');

const conexao = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

conexao.connect()
  .then(() => console.log('🔥 Conectado ao Neon PostgreSQL'))
  .catch(err => console.error('❌ Erro ao conectar:', err));

module.exports = conexao;
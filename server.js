require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const multer = require('multer');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const conexao = require('./db');

const app = express();

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({
    pool: conexao,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'segredo_prototipo_vizinhanca',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 24
  }
}));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const nome = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    cb(null, nome);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const permitidos = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
      'video/webm'
    ];

    if (permitidos.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido.'));
    }
  }
});

function requireAuth(req, res, next) {
  if (!req.session.usuario) {
    return res.status(401).json({ erro: 'Usuário não autenticado' });
  }
  next();
}

function calcularHashSHA256(caminhoArquivo) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(caminhoArquivo);

    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

app.get('/api/teste', async (req, res) => {
  try {
    const r = await conexao.query('SELECT NOW()');
    res.json({
      status: 'ok',
      servidor: 'funcionando',
      banco: r.rows[0]
    });
  } catch (erro) {
    console.error('Erro na rota /api/teste:', erro);
    res.status(500).json({ erro: 'Erro ao testar conexão com banco' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { nome, email, senha, tipo, consentimento_lgpd } = req.body;

  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'Nome, email e senha são obrigatórios.' });
  }

  if (!consentimento_lgpd || String(consentimento_lgpd) !== 'true') {
    return res.status(400).json({ erro: 'É necessário aceitar o consentimento LGPD.' });
  }

  try {
    const existe = await conexao.query(
      'SELECT id FROM usuarios WHERE email = $1',
      [email]
    );

    if (existe.rows.length > 0) {
      return res.status(409).json({ erro: 'Este email já está cadastrado.' });
    }

    const senha_hash = await bcrypt.hash(senha, 10);

    const result = await conexao.query(
      `INSERT INTO usuarios (nome, email, senha_hash, tipo, consentimento_lgpd)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, email, tipo, consentimento_lgpd`,
      [nome, email, senha_hash, tipo || 'morador', true]
    );

    req.session.usuario = result.rows[0];

    res.status(201).json({
      mensagem: 'Cadastro realizado com sucesso.',
      usuario: result.rows[0]
    });
  } catch (erro) {
    console.error('Erro no cadastro:', erro);
    res.status(500).json({ erro: 'Erro ao cadastrar usuário.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Email e senha são obrigatórios.' });
  }

  try {
    const result = await conexao.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'Credenciais inválidas.' });
    }

    const usuario = result.rows[0];
    const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);

    if (!senhaOk) {
      return res.status(401).json({ erro: 'Credenciais inválidas.' });
    }

    req.session.usuario = {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      tipo: usuario.tipo,
      consentimento_lgpd: usuario.consentimento_lgpd
    };

    res.json({
      mensagem: 'Login realizado com sucesso.',
      usuario: req.session.usuario
    });
  } catch (erro) {
    console.error('Erro no login:', erro);
    res.status(500).json({ erro: 'Erro ao realizar login.' });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.usuario) {
    return res.status(401).json({ autenticado: false });
  }

  res.json({
    autenticado: true,
    usuario: req.session.usuario
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ mensagem: 'Logout realizado com sucesso.' });
  });
});

app.post('/api/ocorrencias', requireAuth, upload.single('midia'), async (req, res) => {
  console.log('BODY:', req.body);
console.log('FILE:', req.file);
console.log('SESSION:', req.session.usuario);

  const { tipo, descricao, data, hora, local, latitude, longitude } = req.body;
  const usuario_id = req.session.usuario.id;

  if (!tipo || !data || !local) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(400).json({
      erro: 'Campos obrigatórios: tipo, data e local'
    });
  }

  const client = await conexao.connect();

  try {
    await client.query('BEGIN');

    const ocorrenciaResult = await client.query(
      `INSERT INTO ocorrencias (
        usuario_id,
        tipo,
        descricao,
        data_ocorrencia,
        hora_ocorrencia,
        local_ocorrencia,
        latitude,
        longitude
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        usuario_id,
        tipo,
        descricao || '',
        data,
        hora || null,
        local,
        latitude || null,
        longitude || null
      ]
    );

    let midia = null;

    if (req.file) {
      const hash_sha256 = await calcularHashSHA256(req.file.path);

      const midiaResult = await client.query(
        `INSERT INTO midias (
          ocorrencia_id,
          nome_original,
          nome_arquivo,
          caminho_arquivo,
          mime_type,
          tamanho_bytes,
          hash_sha256
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *`,
        [
          ocorrenciaResult.rows[0].id,
          req.file.originalname,
          req.file.filename,
          req.file.path,
          req.file.mimetype,
          req.file.size,
          hash_sha256
        ]
      );

      midia = midiaResult.rows[0];
    }

    await client.query('COMMIT');

    res.status(201).json({
      mensagem: 'Ocorrência registrada com sucesso.',
      dados: ocorrenciaResult.rows[0],
      midia
    });
  } catch (erro) {
    await client.query('ROLLBACK');

    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    console.error('Erro ao salvar ocorrência:', erro);
    res.status(500).json({
      erro: 'Erro ao salvar ocorrência no banco'
    });
  } finally {
    client.release();
  }
});

app.get('/api/ocorrencias', requireAuth, async (req, res) => {
  try {
    const result = await conexao.query(
      `SELECT 
        o.*,
        u.nome AS usuario_nome
      FROM ocorrencias o
      JOIN usuarios u ON u.id = o.usuario_id
      ORDER BY o.id DESC`
    );

    const midias = await conexao.query(
      'SELECT * FROM midias ORDER BY id DESC'
    );

    const ocorrencias = result.rows.map(ocorrencia => {
      const arquivos = midias.rows.filter(m => m.ocorrencia_id === ocorrencia.id);
      return {
        ...ocorrencia,
        midias: arquivos
      };
    });

    res.json({
      total: ocorrencias.length,
      ocorrencias
    });
  } catch (err) {
    console.error('Erro ao listar ocorrências:', err);
    res.status(500).json({
      erro: 'Erro ao buscar ocorrências'
    });
  }
});

app.get('/api/midias/:id', requireAuth, async (req, res) => {
  try {
    const result = await conexao.query(
      'SELECT * FROM midias WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Arquivo não encontrado.' });
    }

    const arquivo = result.rows[0];
    res.sendFile(path.resolve(arquivo.caminho_arquivo));
  } catch (erro) {
    console.error('Erro ao buscar mídia:', erro);
    res.status(500).json({ erro: 'Erro ao buscar mídia.' });
  }
});

app.delete('/api/ocorrencias/:id', requireAuth, async (req, res) => {
  const client = await conexao.connect();

  try {
    await client.query('BEGIN');

    const ocorrenciaId = req.params.id;

    const ocorrencia = await client.query(
      'SELECT * FROM ocorrencias WHERE id = $1',
      [ocorrenciaId]
    );

    if (ocorrencia.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Ocorrência não encontrada.' });
    }

    const midias = await client.query(
      'SELECT * FROM midias WHERE ocorrencia_id = $1',
      [ocorrenciaId]
    );

    for (const midia of midias.rows) {
      if (midia.caminho_arquivo && fs.existsSync(midia.caminho_arquivo)) {
        fs.unlinkSync(midia.caminho_arquivo);
      }
    }

    await client.query(
      'DELETE FROM midias WHERE ocorrencia_id = $1',
      [ocorrenciaId]
    );

    await client.query(
      'DELETE FROM ocorrencias WHERE id = $1',
      [ocorrenciaId]
    );

    await client.query('COMMIT');

    res.json({ mensagem: 'Ocorrência excluída com sucesso.' });
  } catch (erro) {
    await client.query('ROLLBACK');
    console.error('Erro ao excluir ocorrência:', erro);
    res.status(500).json({ erro: 'Erro ao excluir ocorrência.' });
  } finally {
    client.release();
  }
});


app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});